import type { WsKeyField, WsOpen, WsServerMessage } from "@as400web/server";
import { viewSettings } from "./stores/viewSettings.js";
import type { AidKey } from "@as400web/tn5250";
import { WsClient, wsUrl } from "./ws-client.js";
import {
  MSG_NO_RESPONSE,
  MSG_PC_COMMAND_DENIED,
  MSG_PC_COMMAND_DISABLED,
  MSG_PC_COMMAND_DONE,
  MSG_PC_COMMAND_FAILED,
  MSG_PC_COMMAND_RUNNING
} from "./composables/opMessages.js";
import {
  sessionsStore,
  type PcCommandView,
  type SessionState,
  type SessionMeta
} from "./stores/sessions.js";
import { workspaceStore } from "./stores/workspace.js";
import { blocksManualInput, noteUnrecordable, recordSend } from "./macro-record.js";
import { findMandatoryViolation, type MandatoryFinding } from "./composables/mandatoryCheck.js";
import { MSG_MANDATORY_ENTER, MSG_MANDATORY_FILL } from "./composables/opMessages.js";

/** `/ws` の URL（組み立ては `ws-client.ts` に 1 か所。監視コンソールも同じものを使う） */
const WS_URL = wsUrl;

/** ローディング表示までの猶予（この時間内に応答が来ればスピナーを出さない） */
const LOADING_DELAY_MS = 500;
const loadingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 在席の合図を送る間隔（ms）。打鍵のたびに送るとただの無駄なので間引く。
 *
 * サーバーの掃除は 60 秒間隔で、設定できる最小値は 1 分。15 秒に 1 回なら
 * `lastActivity` は最大 15 秒古いだけなので、1 分の設定でも操作中に切られない。
 */
const ACTIVITY_THROTTLE_MS = 15_000;

/**
 * 利用者が触ったことをサーバーへ伝える（入力・カーソル移動）。
 *
 * 打った文字は AID キーを押すまで送らない約束なので、**サーバーからは打鍵中が無操作に見える**。
 * アイドルタイムアウトに有限値を設定したとき「設定した時間より早く切られ、打ち込み途中の
 * 未送信入力が消える」のを防ぐための合図（spec 方針4）。
 *
 * **値は載せない。** `edits` の中身を早く送ると秘密（マクロの `secretRef`）の扱いが変わる。
 * 既定（永続）でも送る——クライアントはサーバー側の既定を知らないため。
 */
export function noteActivity(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  const t = Date.now();
  if (s.activitySentAt !== undefined && t - s.activitySentAt < ACTIVITY_THROTTLE_MS) return;
  s.activitySentAt = t;
  s.client.send({ type: "activity" });
}

/** 通信中フラグを設定。busy 中は入力プロテクト、0.5 秒超でローディング表示 */
function setBusy(sessionId: string, busy: boolean): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  const timer = loadingTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    loadingTimers.delete(sessionId);
  }
  s.busy = busy;
  if (busy) {
    s.loading = false;
    loadingTimers.set(
      sessionId,
      setTimeout(() => {
        const cur = sessionsStore.get(sessionId);
        if (cur?.busy) cur.loading = true;
        loadingTimers.delete(sessionId);
      }, LOADING_DELAY_MS)
    );
  } else {
    s.loading = false;
  }
}

/** 画面に残す PC コマンドの件数（サーバー側の保持と同じ）。古いものから捨てる */
const PC_COMMAND_VIEW_LIMIT = 20;

/** PC コマンドの状況 → 操作員メッセージ。開始（outcome 無し）と結果で出し分ける */
function pcCommandNotice(e: PcCommandView): string {
  if (!e.outcome) return MSG_PC_COMMAND_RUNNING;
  switch (e.outcome.status) {
    case "disabled":
      return MSG_PC_COMMAND_DISABLED;
    case "denied":
      return MSG_PC_COMMAND_DENIED;
    case "failed":
      return MSG_PC_COMMAND_FAILED;
    default:
      return MSG_PC_COMMAND_DONE;
  }
}

/** 接続を開き、セッションを stores に登録してワークスペースに追加する */
export async function openSession(
  open: WsOpen,
  label: string,
  meta?: SessionMeta,
  systemRef?: string,
  configRef?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let sessionId = "";
    const client = new WsClient(
      WS_URL(),
      {
        onServerMessage(msg: WsServerMessage) {
          switch (msg.type) {
            case "opened": {
              sessionId = msg.sessionId;
              // ログの絞り込みに使うため、実 ID が決まった時点で伝える
              client.setSessionId(sessionId);
              const state: SessionState = {
                sessionId,
                label,
                snapshot: msg.screen,
                edits: new Map(),
                cursor: msg.screen.cursor,
                connected: true,
                readOnly: open.readOnly ?? false,
                ccsid: msg.ccsid,
                client,
                ...(meta ? { meta } : {}),
                // 起動応答で分かる範囲（装置名＝ジョブ名）は接続と同時に届く
                ...(msg.job !== undefined ? { job: msg.job } : {}),
                pcCommandEnabled: msg.pcCommand,
                pcCommands: [],
                ...(configRef !== undefined ? { configRef } : {}),
                ...(systemRef !== undefined ? { systemRef } : {})
              };
              sessionsStore.add(state);
              client.setHiddenIndexes(hiddenIndexes(msg.screen));
              workspaceStore.addSession(sessionId, systemRef);
              resolve(sessionId);
              break;
            }
            case "screen": {
              sessionsStore.updateScreen(sessionId, msg.screen);
              client.setHiddenIndexes(hiddenIndexes(msg.screen));
              setBusy(sessionId, false);
              break;
            }
            case "key-done": {
              // 画面を変えないキーでも待ちを解く。加えて**完了時点の画面を必ず反映する**——
              // タイムアウト復帰ではホストからの screen イベントが起きず、
              // keyboardLocked: true の画面が残って 🔒 が消えなくなる。
              sessionsStore.updateScreen(sessionId, msg.screen);
              client.setHiddenIndexes(hiddenIndexes(msg.screen));
              // 無応答のまま待ちが尽きたことは**明示する**。無言で戻すと「押したのに何も
              // 起きない」が不具合と区別できない（Attn は既に窓が出ていると無視される）。
              if (msg.timedOut === true) {
                const s = sessionsStore.get(sessionId);
                if (s) s.notice = MSG_NO_RESPONSE;
              }
              setBusy(sessionId, false);
              break;
            }
            // ジョブ識別子は**サーバー発だけ**（画面に触れずに取れたものが遅れて届く）。
            // 要求する口は無いので busy も動かさない
            case "jobinfo": {
              const s = sessionsStore.get(sessionId);
              if (s) s.job = msg.job;
              break;
            }
            // PC コマンド（STRPCCMD）。ホストが画面に隠して送ってくるので、
            // 何が・どこで動いたかを必ず知らせる（黙って実行しない）
            case "pc-command": {
              const s = sessionsStore.get(sessionId);
              if (!s) break;
              (s.pcCommands ??= []).push(msg.event);
              if (s.pcCommands.length > PC_COMMAND_VIEW_LIMIT) s.pcCommands.shift();
              s.notice = pcCommandNotice(msg.event);
              break;
            }
            case "closed": {
              const s = sessionsStore.get(sessionId);
              if (s) s.connected = false;
              setBusy(sessionId, false);
              break;
            }
            case "error":
              setBusy(sessionId, false);
              if (!sessionId) reject(new Error(`${msg.code}: ${msg.message}`));
              break;
          }
        }
      },
      label
    );
    client
      .connect()
      .then(() => client.send({ ...open }))
      .catch(reject);
  });
}

/** プリンターセッションを開き、stores 登録＋ワークスペース追加する（帳票を report で受信） */
export async function openPrinterSession(
  open: WsOpen,
  label: string,
  meta?: SessionMeta,
  systemRef?: string,
  configRef?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let sessionId = "";
    const client = new WsClient(
      WS_URL(),
      {
        onServerMessage(msg: WsServerMessage) {
          switch (msg.type) {
            case "printer-opened": {
              sessionId = msg.sessionId;
              // ログの絞り込みに使うため、実 ID が決まった時点で伝える
              client.setSessionId(sessionId);
              const state: SessionState = {
                sessionId,
                label,
                kind: "printer",
                snapshot: undefined,
                edits: new Map(),
                cursor: { row: 1, col: 1 },
                connected: true,
                readOnly: true,
                client,
                reports: [],
                // **待ち受けていなければ起動応答コードは無い**（接続していない）。
                // `exactOptionalPropertyTypes` 下では undefined を入れられないので、キーごと落とす
                ...(msg.startupCode !== undefined ? { startupCode: msg.startupCode } : {}),
                // **「開く」と「待ち受ける」は別。** `自動で待ち受け開始 ☐` なら
                // `stopped` で返り、利用者の開始ボタンを待つ
                state: msg.state,
                // 自動出力（PDF/印刷）の状態。設定がある場合のみ UI にトグルを出す
                outputConfigured: msg.hasOutput,
                outputEnabled: msg.outputEnabled,
                printerWarnings: [...msg.outputWarnings],
                outputStatuses: Object.fromEntries(msg.outputStatuses.map((s) => [s.spoolId, s])),
                ...(meta ? { meta } : {}),
                ...(configRef !== undefined ? { configRef } : {}),
                ...(systemRef !== undefined ? { systemRef } : {})
              };
              sessionsStore.add(state);
              workspaceStore.addSession(sessionId, systemRef);
              resolve(sessionId);
              break;
            }
            case "report": {
              sessionsStore.addReport(sessionId, msg.report);
              break;
            }
            case "printer-warn": {
              // 自動出力の失敗。画面で気づけるよう履歴に積む（上限 20）
              const s = sessionsStore.get(sessionId);
              if (s) {
                if (!s.printerWarnings) s.printerWarnings = [];
                s.printerWarnings.push({ at: msg.at, message: msg.message });
                if (s.printerWarnings.length > 20) s.printerWarnings.shift();
              }
              break;
            }
            case "printer-output-result": {
              // 自動出力の結果（成功も含む）。スプールごとに保持して一覧・詳細に出す
              const s = sessionsStore.get(sessionId);
              if (s) {
                if (!s.outputStatuses) s.outputStatuses = {};
                s.outputStatuses[msg.status.spoolId] = msg.status;
              }
              break;
            }
            case "printer-output-state": {
              const s = sessionsStore.get(sessionId);
              if (s) s.outputEnabled = msg.enabled;
              break;
            }
            case "printer-state": {
              // **黙って止まらない。** 再接続も、開始の失敗（装置使用中など）も、
              // ここが唯一の知らせ方——押した側が結果を待っていないので、これが届かないと
              // 「押したのに何も起きない」になる
              const s = sessionsStore.get(sessionId);
              if (s) {
                // **値ではなく到着を数える**（同じ理由で二度失敗しても押した側に返事が届く）
                s.stateSeq = (s.stateSeq ?? 0) + 1;
                s.state = msg.state;
                if (msg.error !== undefined) s.serviceError = msg.error;
                else delete s.serviceError;
                // 起動応答コードは待ち受けを始めたときだけ来る。停止したら消す
                if (msg.startupCode !== undefined) s.startupCode = msg.startupCode;
                else if (msg.state === "stopped") delete s.startupCode;
              }
              break;
            }
            case "closed": {
              const s = sessionsStore.get(sessionId);
              if (s) s.connected = false;
              break;
            }
            case "error":
              if (!sessionId) reject(new Error(`${msg.code}: ${msg.message}`));
              break;
          }
        }
      },
      label
    );
    client
      .connect()
      .then(() => client.send({ ...open, kind: "printer" }))
      .catch(reject);
  });
}

/** 自動出力（PDF 保存・自動印刷）の有効/無効を切り替える（サーバー応答で状態を反映） */
export function setPrinterOutput(sessionId: string, enabled: boolean): void {
  sessionsStore.get(sessionId)?.client.send({ type: "printer-output", enabled });
}

/**
 * 待ち受けを開始する（`20260801-service-start-stop`）。
 *
 * **結果は待たない**——成功すれば `printer-state` の `listening` が、
 * 失敗すれば `error` と理由が push で届く。ここで待つと、装置使用中のような
 * 数秒かかる失敗の間だけ画面が固まる。
 */
export function startPrinter(sessionId: string): void {
  sessionsStore.get(sessionId)?.client.send({ type: "printer-start", sessionId });
}

/**
 * 待ち受けを停止する。**受信済みの帳票は消えない**——
 * 停止は「いま消費しない」であって「取りこぼす」ではない（スプールはホストの OUTQ に残る）。
 */
export function stopPrinter(sessionId: string): void {
  sessionsStore.get(sessionId)?.client.send({ type: "printer-stop", sessionId });
}

/**
 * AID 送信（ローカル編集差分を fields に載せる）。
 *
 * `sysReqText` は **SysReq 専用**でシステム要求行に打たれた文字列。
 * 編集差分を一緒に送るのは SysReq/Attn でも同じ——ホストは Attn の直後に SAVE SCREEN で
 * **こちらの画面イメージ**を引き取って復元に使うため、打ちかけの文字も載せておかないと
 * F3 で戻ったときに消える。
 *
 * **マクロの記録フックはここに 1 点だけ置く**（spec D2）。キーボード・機能キー凡例ボタン・
 * ホイール・OIA ボタンの経路はすべてこの関数を通るため、コンポーネント側は無改造で済む。
 * 記録していないとき（`idle`）は `recordSend` が即 return するので**挙動は一切変わらない**。
 *
 * **再生中の手入力もここで止める**。`busy` プロテクトだけでは足りない——ホストの応答が
 * 返ってから次のステップを送るまでの**隙間で `busy` が false になる**ため、その瞬間の打鍵が
 * ホストへ抜けて再生と食い違う。再生は `sendKeyWithFields` を使うので巻き添えにならない。
 *
 * **FFW の必須検証（MANDATORY_ENTER / MANDATORY_FILL）もここで行う**。当初は
 * `EmulatorPane.onAid` に置いたが、**OIA の「⏎ 実行」ボタン（`StatusBar`）はそこを通らず
 * 直接ここへ来る**ため素通りしていた（実機ブラウザ検証で発覚。単体テストでは見えなかった）。
 * 上のコメントどおりこの関数が全送信経路の合流点なので、判定もここに 1 つだけ置く。
 *
 * @returns 必須検証で止めたときはその違反。送ったときは `undefined`
 *          （呼び出し側が該当欄へフォーカスを移せるように返す）
 */
export function sendKey(
  sessionId: string,
  key: AidKey,
  cursor?: { row: number; col: number },
  sysReqText?: string
): MandatoryFinding | undefined {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return; // 通信中は多重送信しない（プロテクト）
  if (blocksManualInput(sessionId)) return; // 再生中の手入力は通さない（spec のエッジケース）
  // **Enter のときだけ検証する**（decisions D1）。機能キーでも止めると、必須欄が空の画面から
  // F3 で抜けられなくなる——ホストはこの検証をしないので、こちらが止めれば本当に止まる。
  if (key === "Enter" && s.snapshot) {
    const hit = findMandatoryViolation(s.snapshot.fields, s.edits);
    if (hit) {
      s.notice = hit.reason === "mandatory-enter" ? MSG_MANDATORY_ENTER : MSG_MANDATORY_FILL;
      return hit;
    }
  }
  delete s.notice; // 前回の通知は次の操作で消す
  const fields = [...s.edits.entries()].map(([field, value]) => ({ field, value }));
  // 送信**前**に記録する（送信後だと edits が新画面で消えていることがある）
  recordSend(sessionId, key, cursor ?? s.cursor, sysReqText);
  s.client.send({
    type: "key",
    key,
    ...(cursor ? { cursor } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(sysReqText !== undefined ? { sysReqText } : {})
  });
  setBusy(sessionId, true);
}

/** 再生時に送る 1 欄。値そのものか、**マクロの秘密への参照**（spec D11） */
export type OutgoingField = WsKeyField;

/**
 * マクロ再生用の AID 送信。`sendKey` と違い **`s.edits` を見ず、渡された fields をそのまま送る**。
 *
 * 分けているのは秘密のため——秘密は値ではなく `secretRef` で送り、サーバーが所有者を
 * 確かめて復号し、ホストへ書く直前に差し替える。`s.edits` は `Map<number, string>` なので
 * 参照を載せられない。**記録フックも呼ばない**（再生を記録し直さない）。
 */
export function sendKeyWithFields(
  sessionId: string,
  key: string,
  cursor: { row: number; col: number },
  fields: OutgoingField[],
  sysReqText?: string
): void {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return;
  delete s.notice;
  s.client.send({
    type: "key",
    key,
    cursor,
    ...(fields.length > 0 ? { fields } : {}),
    ...(sysReqText !== undefined ? { sysReqText } : {})
  });
  setBusy(sessionId, true);
}

/**
 * GUI 選択フィールドの選択状態を変更（ローカル・ホスト送信なし）。
 *
 * **この経路もマクロに記録できない**（spec D8）。選択の切り替えはサーバー側セッションの
 * 状態変更で `s.edits` に現れないため、記録されるのは後続の AID だけになる。
 * 印を立てておかないと「選択が反映されないまま Enter が飛ぶマクロ」が黙って出来上がる。
 */
export function selectGuiChoice(
  sessionId: string,
  fieldId: number,
  choiceIndex: number,
  selected: boolean
): void {
  if (blocksManualInput(sessionId)) return; // 再生中の手入力は通さない
  noteUnrecordable(sessionId);
  sessionsStore.get(sessionId)?.client.send({ type: "gui-select", fieldId, choiceIndex, selected });
}

/**
 * GUI 選択フィールドを確定送信（AID/Enter を Read 応答として送る）。
 *
 * **この経路はマクロに記録できない**（拡張5250 のホスト宣言に依存し、`sendKey` を通らない。
 * spec D8）。記録中なら印を立てて、黙って壊れたマクロが出来上がるのを防ぐ。
 */
export function submitGuiSelection(
  sessionId: string,
  fieldId: number,
  cursor?: { row: number; col: number }
): void {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return;
  if (blocksManualInput(sessionId)) return; // 再生中の手入力は通さない
  noteUnrecordable(sessionId);
  s.client.send({ type: "gui-submit", fieldId, ...(cursor ? { cursor } : {}) });
  setBusy(sessionId, true);
}

export function closeSession(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  const timer = loadingTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    loadingTimers.delete(sessionId);
  }
  s.client.send({ type: "close" });
  s.client.close();
  sessionsStore.remove(sessionId);
  workspaceStore.closeSession(sessionId);
  // このセッションだけの表示設定も捨てる（`20260802-appearance-and-view-cascade`）。
  // 保存していないので放置しても害は無いが、開閉のたびに増え続けるのは避ける
  viewSettings.clearAll(sessionId);
}

function hiddenIndexes(screen: { fields: { index: number; hidden: boolean }[] }): number[] {
  return screen.fields.filter((f) => f.hidden).map((f) => f.index);
}
