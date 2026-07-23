import type { WsOpen, WsServerMessage } from "@as400web/server";
import type { AidKey } from "@as400web/core";
import { WsClient } from "./ws-client.js";
import { sessionsStore, type SessionState, type SessionMeta } from "./stores/sessions.js";
import { workspaceStore } from "./stores/workspace.js";

const WS_URL = (): string => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
};

/** ローディング表示までの猶予（この時間内に応答が来ればスピナーを出さない） */
const LOADING_DELAY_MS = 500;
const loadingTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
                startupCode: msg.startupCode,
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

/** AID 送信（ローカル編集差分を fields に載せる） */
export function sendKey(sessionId: string, key: AidKey, cursor?: { row: number; col: number }): void {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return; // 通信中は多重送信しない（プロテクト）
  const fields = [...s.edits.entries()].map(([field, value]) => ({ field, value }));
  s.client.send({
    type: "key",
    key,
    ...(cursor ? { cursor } : {}),
    ...(fields.length > 0 ? { fields } : {})
  });
  setBusy(sessionId, true);
}

/** GUI 選択フィールドの選択状態を変更（ローカル・ホスト送信なし） */
export function selectGuiChoice(
  sessionId: string,
  fieldId: number,
  choiceIndex: number,
  selected: boolean
): void {
  sessionsStore.get(sessionId)?.client.send({ type: "gui-select", fieldId, choiceIndex, selected });
}

/** GUI 選択フィールドを確定送信（AID/Enter を Read 応答として送る） */
export function submitGuiSelection(
  sessionId: string,
  fieldId: number,
  cursor?: { row: number; col: number }
): void {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return;
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
}

function hiddenIndexes(screen: { fields: { index: number; hidden: boolean }[] }): number[] {
  return screen.fields.filter((f) => f.hidden).map((f) => f.index);
}
