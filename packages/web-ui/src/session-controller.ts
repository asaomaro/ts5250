import type { SpoolReportMsg, WsKeyField, WsOpen, WsServerMessage } from "@ts5250/server";
import { viewSettings } from "./stores/viewSettings.js";
import type { AidKey } from "@ts5250/tn5250";
import { WsClient, wsUrl } from "./ws-client.js";
import {
  MSG_CONNECTION_LOST,
  MSG_NO_RESPONSE,
  MSG_NOT_CONNECTED,
  MSG_PC_COMMAND_DENIED,
  MSG_PC_COMMAND_DISABLED,
  MSG_PC_COMMAND_DONE,
  MSG_PC_COMMAND_FAILED,
  MSG_PC_COMMAND_RUNNING,
  MSG_RECONNECT_GAVE_UP,
  MSG_SESSION_ENDED,
  MSG_VT_CONNECTION_LOST,
  wsErrorNotice,
  openErrorText,
  startupRejectionText
} from "./composables/opMessages.js";
import {
  sessionsStore,
  type PcCommandView,
  type SessionState,
  type SessionMeta,
  type SpoolReportView,
  type SessionStateInit
} from "./stores/sessions.js";
import {
  acceptsFrame,
  acceptsFromSession,
  canSendToHost,
  isCurrentAttempt,
  isSessionClient,
  resumeVerdict,
  type Attempt,
  type Resumability
} from "./session-link.js";
import { vtStore } from "./stores/vt.js";
import { workspaceStore } from "./stores/workspace.js";
import { blocksManualInput, noteUnrecordable, recordSend } from "./macro-record.js";
import {
  findFieldViolation,
  findMandatoryEnterViolation,
  type MandatoryFinding
} from "./composables/mandatoryCheck.js";
import { fieldAt } from "./composables/useCursor.js";
import {
  MSG_MANDATORY_ENTER,
  msgHostReconnecting,
  MSG_MANDATORY_FILL,
  MSG_SELF_CHECK,
  MSG_FIELD_EXIT_REQUIRED,
  startupStartedText,
  STARTUP_NOTICE_MS
} from "./composables/opMessages.js";
import { beep } from "./beep.js";

/** `/ws` の URL（組み立ては `ws-client.ts` に 1 か所。監視コンソールも同じものを使う） */
const WS_URL = wsUrl;

/** ローディング表示までの猶予（この時間内に応答が来ればスピナーを出さない） */
const LOADING_DELAY_MS = 500;
const loadingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * **待たされている間、こちらからは何も言わない**（ACS と同じ）。
 *
 * 一時期ここに 30 秒の通知（`MSG_WAITING_LONG`）を置いていた。旧タイムアウトが同じ 30 秒で
 * 「応答がありませんでした」と**嘘をついて施錠まで解いて**いたので、廃止するにあたり
 * 「事実だけを言うもの」に置き換えたつもりだった。**やめた**（利用者の指摘）:
 *
 *   - **ACS も実機もそんなメッセージを出さない。** 応答待ちに出るのは OIA の `X SYSTEM`
 *     （こちらでは 🔒 とスピナー）だけで、何秒たっても文言は出ずに黙って待つ
 *   - 操作員メッセージは本来**打鍵への反応**（`opMessages.ts` の ACS 原文つきの定数群）。
 *     これだけが利用者の操作と無関係に勝手に出る、性質の違うものになっていた
 *   - メッセージ行はクライアント優先（`EmulatorPane` の `messageLine`）なので、
 *     **ホストが出している進捗表示を押しのけていた**（実機の `SNDPGMMSG … MSGTYPE(*STATUS)` で確認)
 *
 * 嘘をつくのをやめた時点で目的の大半は済んでいる。「時間が掛かっている」と「固まった」の
 * 区別は、ACS と同じく利用者が Attn / SysReq（システム要求メニューの「2. 前の要求の終了」）で
 * 確かめる。
 */

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
  s.loading = false;
  if (busy) {
    loadingTimers.set(
      sessionId,
      setTimeout(() => {
        const cur = sessionsStore.get(sessionId);
        if (cur?.busy) cur.loading = true;
        loadingTimers.delete(sessionId);
      }, LOADING_DELAY_MS)
    );
  }
}

/**
 * **手入力を受け付けない状態か**（`busy` ＋ ホストのキーボード施錠）。
 *
 * `busy` は「この画面が出した往復がまだ帰っていない」、`keyboardLocked` は
 * 「**ホストがまだ開けていない**」で、出所が違う。`busy` だけを見ると、ホストが施錠したまま
 * 画面を書いてきた隙間で AID が抜け、core の `assertReady` が `KEYBOARD_LOCKED` を投げる
 * ——利用者には「押したのにエラーになる」としか見えない。送信の合流点であるこの関数群で
 * 両方を見て、**ホストへ出す前に**止める。
 *
 * 再生（`sendKeyWithFields`）は通さない——あちらは自動操作の経路で、待ちも失敗の扱いも
 * マクロ側が持っている。
 */
function inputInhibited(s: SessionState): boolean {
  return s.busy === true || s.snapshot?.keyboardLocked === true;
}

/**
 * **繋がっていない相手へ送ろうとしたら止めて理由を出す**（`20260908-session-survives-disconnect`）。
 *
 * `WsClient.send` は OPEN でなければ**黙って捨てる**ので、素通しすると
 * 「押したのに何も起きない」になる。さらに送信の口の一部は送ったあと `setBusy(true)` を
 * 立てるので、**再接続中に覆いが戻り、二度と解けなくなる**（この work が消しに来た症状）。
 *
 * **5250 表示セッションの送信の入口はすべてここを通る**——1 か所にしか置かないと、
 * 経路が増えたときに漏れる（実際、`sendKey` にだけ置いていた頃は GUI 選択とマクロ再生が
 * 素通りしていた）。
 *
 * **VT とプリンターの送信口（`vt-input` / `printer-*`）は通らない**。あちらは繋ぎ直しの
 * 対象外で、切断の見せ方も自前のペインが持っている（`VtPane` の「切断されました」、
 * `PrinterPane` の待ち受け状態）。ここへ引き込むと、対象外と決めた経路の UX を
 * この work で作り替えることになる——**通す/通さないの境界は「繋ぎ直しの対象か」と同じ**。
 *
 * 理由は 2 つに分ける: 転送が落ちている（繋ぎ直せば戻る）／ホスト側が終わっている
 * （待っても戻らない）。同じ `connected === false` から逆の案内を出さないため。
 */
function refuseIfDisconnected(s: SessionState): boolean {
  const verdict = canSendToHost(s.link);
  if (verdict.ok) return false;
  // **既に出ている切断の理由を上書きしない。** 繋ぎ直しを諦めた理由・猶予切れ・
  // 対象外の経路の案内は、どれも**この汎用文より具体的**（前 work の review ラウンド2）。
  // 打鍵 1 回で「サーバーと繋がっていないため送信できません」＝**待てば戻る含み**に
  // すり替わると、ラウンド1 で潰した嘘がここで復活する。
  // 切断中は通知が消えない（送信の手前で戻るので `delete s.notice` を通らない）ので、
  // 埋まっていれば残す
  if (s.notice === undefined) {
    // **文言への写像はここ**（規則は理由の区分だけを返す。`session-link.ts` の注記）
    s.notice = verdict.reason === "hostEnded" ? MSG_SESSION_ENDED : MSG_NOT_CONNECTED;
  }
  return true;
}

/**
 * **施錠中でも送れるキー**（5250 のフラグレコード）。ホストへは**欄データを持たないレコード**
 * として出る（ACS も同じ。`20260920-restore-screen-parity` research F17 でワイヤを実測した）。
 *
 * Attn / SysReq は「固まった要求から抜ける」ための手段そのもので、実機では応答待ちの
 * 最中にこそ使う（システム要求メニューの「2. 前の要求の終了」）。プロテクトに巻き込むと、
 * **待たされている時だけ逃げ道が消える**。画面は期限を設けずに待つようになったので
 * （`ws-handler.onKey` の `timeoutMs: "never"`）、この口が唯一の出口になる。
 *
 * そのぶん扱いが 3 つ違う: 施錠中でも通す（逃げ道）／`busy` に載せない（応答を待たない）／
 * **欄は「サーバーの画面バッファへ移すため」に載せる**。
 *
 * 最後の 1 つは ~~欄は載せない（フラグレコードは MDT を運ばないので送っても届かない）~~
 * から変えた——**届かないのはそのとおりだが、サーバー側の画面バッファに打鍵が無いと
 * SAVE SCREEN の退避に載らず、Attn → F12 で戻ったときに消える**。ACS は打鍵を表示バッファ
 * （`PS5250` の `HostPlane` / `TextPlane`）に持つので消えない（同 research F1・F4、decisions D6）。
 *
 * **施錠中は載せない**——サーバーが書かないので送っても捨てられ、打ちかけの値を無駄に流すだけ。
 * ⚠ このとき、**施錠より前に打った内容は失われる**（`s.edits` には残るが、次にホストの画面が
 * 来た時点で捨てられる）。施錠中に逃げる場面で打鍵を保つには、打鍵ごとにサーバーへ送る形が要る
 * ——この work の範囲外（`acs-parity.md` に起票）。
 */
function isFlagKey(key: AidKey): boolean {
  return key === "Attn" || key === "SysReq";
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

/**
 * **繋ぎ直しの待ち時間**（ms）。1 秒から倍々に伸ばし、5 回で打ち切る。
 *
 * **サーバー側の猶予（`DEFAULT_RECONNECT_GRACE_MS` ＝ 90 秒）の内側に収める**。
 * 最悪ケースの壁時計は **(1+2+4+8+16) × 1.2 ＝ 37.2 秒 ＋ 5 × `RESUME_ATTEMPT_TIMEOUT_MS`
 * ＝ 87.2 秒**。猶予が切れたあとに叩いても「そのセッションはもう無い」と言われるだけで、
 * 回線に無駄な負荷を掛ける。**ここを増やすなら猶予も見直すこと**（`20260908-session-survives-disconnect` の `decisions.md` D12）。
 *
 * **倍々にするのは、繋がらない相手を叩き続けないため。** サーバーの再起動では
 * 全タブが同時に落ちるので、間隔を空けないと復帰しかけたサーバーを揃って殴りに行く。
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/**
 * 待ち時間に掛けるゆらぎ（±20%）。
 *
 * **同時に落ちたタブを散らす**ためだけのもの。揃ったまま再試行すると、
 * 1 台のサーバーに対して山が立つ（`RECONNECT_DELAYS_MS` の注記と同じ理由）。
 */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * **1 回の試行に掛ける上限**（ms）。
 *
 * 繋がったのに `opened` も `error` も返らない、という黙り方がありうる。`WsClient` の
 * 半開き見張りは**最初の `ping` を受けてから**しか張らず、サーバーは `attach` 成功後にしか
 * 心拍を始めないので、**この窓だけは誰も見ていない**。放っておくと、ソケットが自然に
 * 閉じるまで（分単位もある）ループが止まったままになる。
 */
const RESUME_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * **いまの繋ぎ直しの試行**（セッションごとに高々 1 つ。規則は `session-link.ts`）。
 *
 * 畳み込み前は「待ちタイマー」と「飛行中の口」を**別の Map** に分けていたが、
 * 同じ試行の 2 つの相でしかない（`20260908-session-lifetime-rules-fold`）。
 * 分けていたせいで「待ちだけ畳んで飛行中が残る」が作れ、
 * 「この試行はまだ有効か」を答える判定が **5 系統**に散っていた（research.md F4）。
 * **この Map が畳むのはそのうち 3 つ**（`settled` / `pendingResumes` / `reconnectTimers`）で、
 * 残り 2 つの行き先は `session-link.ts` の `Attempt` に記してある。
 *
 * 掴んでおく理由は 2 つ。**利用者がタブを閉じたあとに `opened` が返ると、サーバー側では
 * `cancelHold` と `claim` が済んでいる**（＝閉じたはずのセッションが持ち主不在で生き残る）ので、
 * こちらからも畳む必要がある。もう 1 つは、**打ち切ったあとに遅れて `onClose` が来ても
 * 「次の間隔へ」を走らせない**ため——`settled` がその印。
 */
const attempts = new Map<string, Attempt>();

/**
 * この試行が張っているタイマーを畳む（成功・打ち切り・利用者が閉じた、のいずれでも）。
 *
 * **待ちと飛行中で対象が変わる**——`Attempt.timer` は待ち中なら「次の間隔まで」、
 * 飛行中なら「黙り込みの打ち切り」で、同時には持たない（`session-link.ts` の `Attempt`）。
 * 畳み込み前は前者だけがこの関数の担当で、後者は試行ローカルの `deadline` を
 * `cancel()` が畳んでいた。枠が 1 つになったので**どちらの相でも畳める**が、
 * **いま呼ぶのは `abortReconnect` だけ**——成功・失敗の各経路は代表を降ろす
 * （`attempts` から外す）のと同じブロックで自分のタイマーも畳むので、ここを通らない。
 */
function clearReconnectTimer(sessionId: string): void {
  const a = attempts.get(sessionId);
  if (a?.timer !== undefined) {
    clearTimeout(a.timer);
    a.timer = undefined;
  }
}

/** 待ちも飛行中の口も畳む（利用者が閉じた・別経路でやり直す） */
function abortReconnect(sessionId: string): void {
  clearReconnectTimer(sessionId);
  const a = attempts.get(sessionId);
  if (a?.client !== undefined) {
    const inflight = a.client;
    attempts.delete(sessionId);
    a.settled = true; // 遅れて届く `onClose` で next() が走らないようにしてから閉じる
    // **座を引き取っていたら返す。** サーバーは `open { resume }` を受けた時点で
    // `cancelHold` と `claim` を済ませているので、黙って口を閉じると
    // **利用者が閉じたはずのセッションが猶予ぶん生き残る**。`close` は
    // まだ開いていなければ捨てられ、開いていれば `dispose` が畳む——どちらの順でも正しい
    // （前 work の review ラウンド2。`opened` 側のガードだけでは、配送済みの `opened` を取りこぼす）
    inflight.send({ type: "close" });
    inflight.close();
  } else {
    attempts.delete(sessionId);
  }
}

/**
 * **表示セッションの繋ぎ直しの適性**（開く時点で決まる。以後変わらない）。
 *
 * 畳み込み前は `startReconnect` の門1 が「プリンターか・3270 か・見に来ただけか」を
 * 毎回組み立てていた。3 つとも**開いたときに決まる性質**なので `resumability` に載せる。
 * **ここが答えるのはうち 2 つ**——プリンターは表示セッションを開かないので、
 * `openPrinterSession` が状態を組み立てる時点で `"not-resumable"` を直に置く。
 */
function displayResumability(meta: SessionMeta | undefined, attachedToExisting: boolean): Resumability {
  // **見に来ただけのタブは繋ぎ直さない**（座を引き取らない約束。
  // `20260908-session-survives-disconnect` の D4 / D13）
  if (attachedToExisting) return "not-resumable";
  return meta?.terminal === "3270" ? "not-resumable" : "resumable";
}

/**
 * **繋ぎ直しを始める**（`20260908-session-survives-disconnect` design「2. 復帰」）。
 *
 * 呼ぶのは WebSocket が閉じたとき。**利用者が閉じた場合は呼ばれない**——
 * `closeSession` が先に store から消しているので、ここで見つからずに戻る。
 *
 * サーバー側はこの間セッションを猶予として保持している。繋ぎ直せれば
 * **同じホストセッションの続き**から操作できる。
 *
 * **打ちかけの入力（`edits`）は捨てる**（`20260908-session-survives-disconnect` の `decisions.md` D11。当初は「残る」と設計していた）。
 * 繋ぎ直しで返るのは留守中にホストが書いた「いまの画面」で、こちらが打っていた画面とは
 * 限らない——残したまま反映すると**別の画面の欄に打鍵が載る**。`updateScreen` が
 * 新画面で `edits` を捨てる既存の規則がそのまま効く。
 */
function startReconnect(sessionId: string, label: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  // **切断として見せるのは、繋ぎ直すかどうかに関わらず先に済ませる。**
  // 下の門で戻る場合（対象外・諦め済み・走行中）も応答待ちは解けていなければならない
  // ——ここを門の内側に置いていた頃は、対象外の経路でスピナーが残った
  setBusy(sessionId, false);
  sessionsStore.markLost(sessionId, "transport");
  // **切断より前の通知は捨てる**（前 work の review ラウンド3）。`refuseIfDisconnected` は
  // 「この切断について出した理由」を守るが、条件が「何か出ていれば」なので、
  // 直前の `MSG_NO_RESPONSE` 等が居座ると**切断の理由が一度も出ない**
  delete s.notice;
  // **繋ぎ直してよいかは規則が答える**（`session-link.ts` の `resumeVerdict`）。
  // 畳み込み前はここに 4 つの門が並んでおり、1 つ直すと隣が壊れた
  const v = resumeVerdict(s.link, s.resumability);
  if (v.resume) {
    abortReconnect(sessionId); // 取り残しがあれば畳んでから始める
    scheduleReconnect(sessionId, label, 0);
    return;
  }
  // **繋ぎ直さない枝のうち、通知を出すのは「対象外の端末・見に来ただけ」だけ**
  // （前 work の review ラウンド2）。ここは開き直す以外に手が無いので、待てば戻る含みの汎用文を
  // 出すと嘘になる——だから汎用文ではなく「接続が切れました」を出す。
  //
  // **残り（ホストが終わった／もう無いと言われた／既に走っている）は黙る。**
  // ホストが終わった場合は次の打鍵で `refuseIfDisconnected` が固有の理由を出す
  // （`canSendToHost` が写像を持つのは `hostEnded` だけ）。**もう無いと言われた場合は違う**
  // ——`giveUpReconnect` が書いた具体的な文言がそのまま残っているので、ここで
  // 汎用文に塗り替えないことが要る。走行中は表示を触ると再接続中の案内が消える。
  //
  // **理由は規則から受け取る**（`v.why`）。`s.resumability` を読み直すと門1 の写しが
  // ここに出る——requirements AC1 が禁じる形（本 work の review ラウンド1 の must）
  if (v.why === "notResumable") s.notice = MSG_CONNECTION_LOST;
}

/** 次の試行を予約する。回数が尽きたら手動の繋ぎ直しに委ねる */
function scheduleReconnect(sessionId: string, label: string, index: number): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  const delay = RECONNECT_DELAYS_MS[index];
  if (delay === undefined) {
    // **転送が繋がらないまま尽きた。** 時間が経てば直りうるので、押し直せる口を出す
    giveUpReconnect(sessionId, MSG_RECONNECT_GAVE_UP, "retry");
    return;
  }
  sessionsStore.beginReconnect(sessionId, index + 1, RECONNECT_DELAYS_MS.length);
  // **試行はここで生まれる**（待ちの相）。発火したら同じ試行が飛行中の相へ移る。
  // **既存エントリを畳まずに上書きする**——「セッションごとに高々 1 つ」を壊しうる唯一の場所。
  // 呼び手は 2 つで、`startReconnect` は**直前の行の `abortReconnect`** が代表を降ろしている。
  // `next()` は代表のときしか降ろさない（`attempts.get(id) === a` のときだけ delete）が、
  // **代表でない生きた試行は作れない**——代表を差し替えるのはこの `set` だけで、
  // それは必ず「直前に代表を降ろした」経路からしか走らないため、帰納的に到達しない。
  // 畳み込み前の `reconnectTimers.set` も同じ形
  const a: Attempt = { index, client: undefined, timer: undefined, settled: false };
  attempts.set(sessionId, a);
  a.timer = setTimeout(() => {
    a.timer = undefined;
    tryResume(sessionId, label, a);
  }, withJitter(delay));
}

/**
 * **繋ぎ直しを諦める**（理由つき。状態の書き込みはここ 1 か所に寄せる）。
 *
 * `reason` が `"retry"` なら押し直す口を出す。`"gone"` は**出さない**うえ、
 * 以後この経路に入り直さない——押しても同じ理由で失敗するため。
 */
function giveUpReconnect(sessionId: string, notice: string, reason: "retry" | "gone"): void {
  abortReconnect(sessionId);
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  // **諦めた先でも応答待ちを残さない。** 解いているのが `startReconnect` の先頭だけだと、
  // 諦めるまでの間に何かが `setBusy(true)` を立てるとスピナーが永久に残る
  setBusy(sessionId, false);
  // 諦めの理由は確定扱い——以後の転送断（`transport`）では上書きされない（`nextLink`）
  sessionsStore.markLost(sessionId, reason === "retry" ? "gaveUp" : "gone");
  s.notice = notice;
}

/** 1 回ぶんの繋ぎ直し。成功すれば `client` を差し替え、失敗すれば次の間隔へ回す */
function tryResume(sessionId: string, label: string, a: Attempt): void {
  // **この枝だけ `attempts` にエントリを残す**（畳み込み前はタイマー発火時に
  // `reconnectTimers.delete` を先に打っていたので両方空になった）。到達しない——
  // `sessionsStore.remove` の呼び手は `closeSession` だけで、その手前の `abortReconnect` が
  // タイマーごと外すため、この `setTimeout` はそもそも発火しない
  if (!sessionsStore.get(sessionId)) return;
  // **この試行の後始末は 1 度だけ。** `connect()` の失敗と `onClose` は両方来うる
  const next = (): void => {
    if (a.settled) return;
    a.settled = true;
    if (a.timer !== undefined) clearTimeout(a.timer);
    a.timer = undefined;
    if (attempts.get(sessionId) === a) attempts.delete(sessionId);
    scheduleReconnect(sessionId, label, a.index + 1);
  };
  // **黙り込んだ試行を捨てる**（`RESUME_ATTEMPT_TIMEOUT_MS` の注記）
  a.timer = setTimeout(() => {
    if (a.settled) return;
    client.close();
    // **`close()` だけでは足りない。** `connect()` が pending のまま（CONNECTING の
    // ソケット）だと `close` イベントが飛ぶかはブラウザ実装依存で、`onClose` も
    // `connect()` の reject も来ないことがある。そのとき試行が宙に浮くので、
    // ここからも次の間隔へ回す（`next()` は 1 度しか効かない）
    next();
  }, RESUME_ATTEMPT_TIMEOUT_MS);
  const client = new WsClient(
    WS_URL(),
    {
      onServerMessage(msg: WsServerMessage) {
        if (msg.type === "opened") {
          // **ここだけは `isCurrentAttempt` のまま**（`acceptsFrame` に寄せない）。問いが違う——
          // あちらは「この口から届いたフレームを受け取ってよいか」、ここは
          // 「**この試行の成功を採用してよいか**」。寄せると現役の口からの 2 度目の `opened` で
          // `attempts.delete` と `setClient` が二重に走る（`acceptsFrame` の注記も同じことを言う）。
          //
          // **打ち切った試行の `opened` はここまで届きうる**（仕組みは `session-link.ts` の
          // `acceptsFrame` の注記。以前ここには「閉じたソケットには配送されない」と書いてあったが、
          // **その根拠は誤りだった**——`20260910-session-reconnect-freeze` の `decisions.md` D12）。
          // 届いても `isCurrentAttempt` が偽なので弾かれる——**ガードが効いている**のであって、
          // 配送が来ないのではない
          if (!isCurrentAttempt(attempts.get(sessionId), a)) return;
          a.settled = true;
          if (a.timer !== undefined) clearTimeout(a.timer);
          a.timer = undefined;
          attempts.delete(sessionId);
          const cur = sessionsStore.get(sessionId);
          if (!cur) {
            // **利用者が先にタブを閉じていた。** サーバー側はもう `cancelHold` と `claim` を
            // 済ませているので、こちらから畳まないと**持ち主不在のセッションが生き残る**
            client.send({ type: "close" });
            client.close();
            return;
          }
          client.setSessionId(sessionId);
          // **差し替えるのは口だけ。** `edits`（打ちかけの入力）には触らない。
          // 差し替えは store 経由——`markRaw` の不変条件をここに写さないため（`setClient` の注記）
          sessionsStore.setClient(sessionId, client);
          sessionsStore.markConnected(sessionId);
          delete cur.notice;
          // 留守中にホストが書いた画面がそのまま返る（サーバーの `attach` が現在の画面を返す）
          sessionsStore.updateScreen(sessionId, msg.screen);
          client.setHiddenIndexes(hiddenIndexes(msg.screen));
          // **画面以外も取り込む。** `opened` には予約・PC コマンド・ジョブが載っている。
          // 予約を落とすと、**切れている間に解除されていても覆いが残って打てない**
          // （逆も同じで、始まっていたのに打ててしまう）。PC コマンドを落とすと
          // 「黙って実行しない」が繋ぎ直しでだけ破れる
          sessionsStore.setReserved(sessionId, msg.reservedBy);
          cur.pcCommandEnabled = msg.pcCommand;
          // **ホストへの繋ぎ直しの状態も上書きする**（`20260921-auto-reconnect`）。留守中に繋ぎ直せていたら
          // `host-reconnected` は届いていない——残すと以後の送信が黙って捨てられる（独立点検の指摘）
          if (msg.hostReconnect) {
            cur.hostReconnect = msg.hostReconnect;
            cur.notice = msgHostReconnecting(msg.hostReconnect.attempt);
          } else delete cur.hostReconnect;
          // **通知は「留守中に増えた分」だけ。** `opened` に載るのはサーバー側の履歴全体なので、
          // 最後の 1 件をそのまま知らせると**切断前に一度見せたものを毎回出し直す**
          const lastSeenAt = cur.pcCommands?.at(-1)?.at;
          cur.pcCommands = (msg.pcCommands ?? []).slice(-PC_COMMAND_VIEW_LIMIT);
          const missed = cur.pcCommands.at(-1);
          if (missed && missed.at !== lastSeenAt) cur.notice = pcCommandNotice(missed);
          if (msg.job !== undefined) cur.job = msg.job;
          noteStartup(sessionId, msg.startupCode);
          // **`ccsid` と `readOnly` は上書きしない。** サーバーの `attach` は `ccsid` に
          // 既定（37）を返すだけで、`readOnly` はそもそも載せない——どちらも
          // **開いたときの設定に属する**もので、繋ぎ直しで変わる値ではない
          // （`ws-handler.attach` の注記）
          setBusy(sessionId, false);
          return;
        }
        if (msg.type === "error" && !a.settled) {
          // **繋がったが引き取れなかった**（猶予切れ・他人のもの）。時間が経っても
          // 回復しないので再試行しない。~~理由はサーバーのものをそのまま見せる~~
          // → **`wsErrorNotice` が code から作る見出しを見せる**
          // （`20260920-field-error-no-value` decisions D2。サーバーの message は出さない）
          a.settled = true;
          if (a.timer !== undefined) clearTimeout(a.timer);
          a.timer = undefined;
          attempts.delete(sessionId);
          giveUpReconnect(sessionId, wsErrorNotice(msg.code, msg.message), "gone");
          client.close();
          return;
        }
        // **受け取ってよい口からの更新だけを通す**（R4 の `acceptsFrame`）。通す口は 2 つ——
        // **まだ代表の試行**と、**成功して現役になり、いま繋がっているこの口**。
        //
        // 打ち切った試行を通さないのは、とくに `screen` が `updateScreen` 経由で
        // 「繋がっている」に戻すため。はしごが回っている最中に接続中へ戻ると、以後の送信が
        // 死んだ口へ落ちる（`20260908-session-survives-disconnect` の review ラウンド3）。
        //
        // **現役の口を通すのは、ここが代表の試行だけを見ていたから**——`opened` は成功時に
        // 試行を退役させるので、繋ぎ直しに成功した瞬間から**以後の全フレームが落ちていた**
        // （`20260908-session-lifetime-rules-fold` の `decisions.md` D13）
        const held = sessionsStore.get(sessionId);
        if (!acceptsFrame(attempts.get(sessionId), a, held?.client, client, held?.link)) return;
        applyDisplayMessage(sessionId, client, msg);
      },
      onClose() {
        if (!a.settled) {
          next(); // この試行が失敗した。次の間隔へ
          return;
        }
        // 一度は繋がったのに、また切れた。**最初からやり直す**
        // （セッションがいま抱えている口が自分のときだけ——古い試行の後始末で巻き込まない）。
        // **問いは共通ガードの第 2 項と同じ**なので、同じ述語で答える（生の `===` を置かない）。
        //
        // **この門は保険で、外しても現行のテストは落ちない**（`20260910-session-reconnect-freeze` の
        // review ラウンド2 で実測）。畳まれた口の `close` がここへ落ちても、その先の
        // `startReconnect` は `resumeVerdict` が `running` を返して弾く／セッションが消えていれば
        // 先頭で早期 return する。**効いている項が別に在る**という意味で
        // `isCurrentAttempt` の `!a.settled` と同じ性質——テストではなくこの注記が唯一の記録。
        // `openSession` 側の同じ門（`add` の差し替えで踏める）はテストで固定してある
        if (isSessionClient(sessionsStore.get(sessionId)?.client, client)) startReconnect(sessionId, label);
      }
    },
    label
  );
  // 待ちの相から飛行中の相へ。**止めたら止まる**——打ち切りは `settled` が印で、
  // 遅れて `onClose` が来ても `next()` は走らない（`cancel` の閉包を持たなくてよくなった）
  a.client = client;
  client
    .connect()
    .then(() => client.send({ type: "open", sessionId, resume: true }))
    .catch(() => next());
}

/**
 * **手動で繋ぎ直す**（試行が尽きたあとの逃げ道。AC-I2）。
 *
 * 自動の再試行と同じ経路を最初から回す。押せる状態になっているのは
 * 「転送が繋がらないまま尽きた」ときだけで、猶予切れでは出していない。
 */
export function retryReconnect(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  abortReconnect(sessionId);
  // **走行中の印と諦めの印を先に落とす。** 落とさずに `startReconnect` へ入ると
  // 「既に走っている」で弾かれ、**タイマーは畳んだのに印だけ残る**＝二度と動かない
  // （ボタン連打やキーリピートで踏める）。`gone` を素通りできるのも同じ理由
  sessionsStore.requestRetry(sessionId);
  startReconnect(sessionId, s.label);
}

/**
 * **`opened` 以外の 5250 受信処理**。呼び手は 2 つ——`tryResume` の共通ガードと
 * `applyFromSessionClient` で、**どちらも先に「受け取ってよい口か」を確かめている**。
 *
 * 新規に開いたときと**繋ぎ直したとき**で同じ処理が要る（`20260908-session-survives-disconnect`）。
 * 分岐を 2 か所に写すと、片方だけ直された瞬間に「繋ぎ直したタブでだけ通知が来ない」という
 * 壊れ方をする——`ws-handler.subscribeSession` が 1 か所にまとめてあるのと同じ理由。
 *
 * **`opened` と、開く前の `error` はここに入れない**。あちらは呼び出し側の事情
 * （状態を作るのか差し替えるのか／`openSession` の Promise を落とすのか）で分かれる。
 */
function applyDisplayMessage(sessionId: string, client: WsClient, msg: WsServerMessage): void {
  switch (msg.type) {
    // 予約（HLLAPI の Reserve）の開始・解除。**画面と別に届く**——
    // 予約は画面を変えずに始まり・終わるため
    case "reserved": {
      sessionsStore.setReserved(sessionId, msg.by);
      break;
    }
    // **ホストに切られて、サーバーが自動で繋ぎ直している**（`20260921-auto-reconnect`）。
    // 溜めた先打ちは捨てる（送り先が無い間に打ったキーを、繋ぎ直した新しい画面へ流さない）
    case "host-reconnecting": {
      const s = sessionsStore.get(sessionId);
      if (!s) break;
      s.hostReconnect = { attempt: msg.attempt };
      s.notice = msgHostReconnecting(msg.attempt);
      delete s.typeAhead;
      setBusy(sessionId, false);
      break;
    }
    case "host-reconnected": {
      const s = sessionsStore.get(sessionId);
      if (!s) break;
      delete s.hostReconnect;
      if (s.notice?.startsWith(msgHostReconnecting(1))) delete s.notice;
      // ACS は繋ぎ直しでも開始の文言を出す
      noteStartup(sessionId, msg.startupCode);
      break;
    }
    // ホストの警報（CC2 0x04）。**画面と別に届く**——画面が変わらないレコードでも鳴るため
    case "alarm": {
      beep();
      break;
    }
    case "screen": {
      sessionsStore.updateScreen(sessionId, msg.screen);
      client.setHiddenIndexes(hiddenIndexes(msg.screen));
      // **施錠されたままの画面では待ちを解かない。** ホストは応答の途中でも画面を
      // 書いてくる（時間の掛かる CALL の前置き等）。それで待ちを解くと 0.5 秒の
      // 猶予タイマーごと潰れ、**どれだけ待たされてもスピナーが出ない**うえ、
      // 入力プロテクトまで外れる（利用者の報告）。解くのは実際に開いた画面か
      // `key-done`（送信の完了そのもの）だけにする。
      if (!msg.screen.keyboardLocked) setBusy(sessionId, false);
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
      if (s) {
        // **ホストが本当に終わったときだけそう記録する**（`WsClosed.ended`）。
        // サーバーは**心拍の死判定で猶予を張ったあとにも** `closed` を送るので、
        // 無条件に `hostEnded` にすると「保持されているのに二度と繋ぎ直さない」うえ、
        // 次の打鍵で「セッションは終了しています」と**嘘の理由**を出す
        sessionsStore.markLost(sessionId, msg.ended === true ? "hostEnded" : "transport");
        // **切断より前の通知は捨てる**（`startReconnect` と同じ理由。前 work の review ラウンド3）
        delete s.notice;
        // **起動応答で断られて終わったときは、その理由を出す**（自動の繋ぎ直しがホストに断られた等。`20260921-startup-codes-japanese` の
        // 節目の点検の指摘——理由は `closed` の `reason` にしか載らず、捨てていた。ACS もコードごとの文言を出す）
        const rejected = startupRejectionText(msg.reason);
        if (rejected !== undefined) s.notice = rejected;
      }
      setBusy(sessionId, false);
      break;
    }
    case "error": {
      setBusy(sessionId, false);
      // **開いた後のエラーは操作員に見せる。** 待ちを解くだけで黙っていると、
      // 送信が拒否されても画面は何も変わらず「Enter が効かない」としか見えない
      // （実機で数字専用欄に `.` を入れて Enter → `FIELD_TYPE` で 1 バイトも
      // 飛ばないまま無反応だった）。致命的なものは `closed` 側が別に扱う。
      const s = sessionsStore.get(sessionId);
      if (s) s.notice = wsErrorNotice(msg.code, msg.message);
      break;
    }
  }
}

/**
 * **表示セッションが繋がった知らせ**（起動応答のコードつき。`20260921-startup-code-status`）。コードを覚え、通知が空いていれば開始の文言を出して
 * 3 秒で消す（ACS の状態行と同じ）。**間に別の通知（エラー等）が出ていたら消さない**——当 PJ の通知欄は操作員エラーと共用なので
 */
function noteStartup(sessionId: string, code: string | undefined): void {
  const s = sessionsStore.get(sessionId);
  if (!s || code === undefined) return;
  s.startupCode = code;
  if (s.notice !== undefined) return;
  const text = startupStartedText(code);
  s.notice = text;
  setTimeout(() => {
    const cur = sessionsStore.get(sessionId);
    if (cur?.notice === text) delete cur.notice;
  }, STARTUP_NOTICE_MS);
}

/**
 * **セッションの口からの更新だけを通してから共用の処理へ渡す**（R4 の `acceptsFromSession`）。
 *
 * 初回接続の口には `Attempt` が無いので `tryResume` の共通ガード（`acceptsFrame`）を呼べないが、
 * **塞ぐ穴は同じ**——1 回目のはしごを駆動するのはこの口で、`SessionState.client` は繋ぎ直しが
 * 成功するまで差し替わらない。門が無いと、はしごの最中に届いたフレームが `updateScreen` へ落ちて
 * 「繋がっている」へ戻し、以後の打鍵が非 OPEN のソケットへ黙って捨てられる
 * （届く仕組みは `session-link.ts` の `acceptsFrame` の注記。`20260910-session-reconnect-freeze` の `decisions.md` D13）。
 */
function applyFromSessionClient(sessionId: string, client: WsClient, msg: WsServerMessage): void {
  const held = sessionsStore.get(sessionId);
  if (!acceptsFromSession(held?.link, held?.client, client)) return;
  applyDisplayMessage(sessionId, client, msg);
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
              const state: SessionStateInit = {
                sessionId,
                label,
                snapshot: msg.screen,
                edits: new Map(),
                cursor: msg.screen.cursor,
                link: { state: "connected" },
                // **繋ぎ直しの適性は開く時点で決まる**（`session-link.ts`）。
                // 3270 はサーバー側に共有・再取得の経路が無く（`20260908-session-survives-disconnect` の D3）、
                // 見に来ただけのタブは座を引き取らない約束なので繋ぎ直せない
                // （`20260908-session-survives-disconnect` の D4 / D13）
                resumability: displayResumability(meta, open.sessionId !== undefined),
                readOnly: open.readOnly ?? false,
                // **後から入ったタブでも今の予約状態から始める**（開始の push は聞き逃している）
                ...(msg.reservedBy !== undefined ? { reservedBy: msg.reservedBy } : {}),
                // 後から入ったタブが、繋ぎ直しの途中に開いた（経過の通知は聞き逃している）
                ...(msg.hostReconnect ? { hostReconnect: msg.hostReconnect, notice: msgHostReconnecting(msg.hostReconnect.attempt) } : {}),
                ccsid: msg.ccsid,
                client,
                ...(meta ? { meta } : {}),
                // 起動応答で分かる範囲（装置名＝ジョブ名）は接続と同時に届く
                ...(msg.job !== undefined ? { job: msg.job } : {}),
                pcCommandEnabled: msg.pcCommand,
                ...(msg.ibmI !== undefined ? { ibmI3270: msg.ibmI } : {}),
                // **留守中に実行された分から始める。** `pc-command` の push は
                // 繋いでいる間しか届かないので、閉じている間の実行は
                // ここで受け取らないと**誰にも知らされないまま消える**
                pcCommands: (msg.pcCommands ?? []).slice(-PC_COMMAND_VIEW_LIMIT),
                ...(configRef !== undefined ? { configRef } : {}),
                ...(systemRef !== undefined ? { systemRef } : {})
              };
              sessionsStore.add(state);
              // **黙って実行しない**は繋ぎ直しでも同じ——留守中の分も最後の 1 件を知らせる
              const missed = state.pcCommands?.at(-1);
              if (missed) state.notice = pcCommandNotice(missed);
              noteStartup(sessionId, msg.startupCode);
              client.setHiddenIndexes(hiddenIndexes(msg.screen));
              workspaceStore.addSession(sessionId, systemRef);
              resolve(sessionId);
              break;
            }
            // **開く前のエラーだけは呼び出し側で受ける**（この Promise を落とす必要がある）
            case "error": {
              if (!sessionId) {
                setBusy(sessionId, false);
                reject(new Error(openErrorText(msg.code, msg.message)));
                break;
              }
              applyFromSessionClient(sessionId, client, msg);
              break;
            }
            // 開いたあとの受信は共用の処理へ（繋ぎ直しでも同じものを通す）
            default:
              applyFromSessionClient(sessionId, client, msg);
          }
        },
        /**
         * **接続が死んだら待ちを解き、繋ぎ直しに入る。**
         *
         * `closed`（サーバー発）と違い、WebSocket が閉じただけのときは何も届かない。
         * 以前はここに口が無く、`busy` / `loading` が立ったまま残っていた——実機で
         * 「応答待ちのスピナーが消えず、操作ログの最後は closed」という報告になった
         * （ホストへの往復が長いほど当たりやすい）。覆いが残ると Attn / SysReq の
         * 逃げ道も押せず、しかも押せたところで送り先はもう無い。
         *
         * **切れたことは黙って飲み込まない。** ただし言い方は OIA の再接続表示に任せる
         * ——サーバーはこの間セッションを猶予として保持しているので、
         * 「開き直してください」と言う前にこちらで戻せる（だから 5250 では
         * `MSG_CONNECTION_LOST` を使わない）。戻せなかったときだけ `giveUpReconnect` が
         * 理由を出す。待ちの解除と切断表示は `startReconnect` が先頭で済ませる。
         */
        onClose() {
          // **この口がまだセッションのものである間だけ回し直す**（`tryResume` の `onClose` と同じ問い）。
          // 同じ id で開き直すと `sessionsStore.add` が口ごと差し替えるので、あとから届く
          // 古い口の `close` で**健全な口を抱えたままはしごが始まる**（`20260910-session-reconnect-freeze` の
          // `decisions.md` D14）。門が付いた今それをやると、画面が追従せず固まる側へ倒れる
          if (isSessionClient(sessionsStore.get(sessionId)?.client, client)) startReconnect(sessionId, label);
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

/**
 * **VT セッションを開く。**
 *
 * 5250 / プリンターと別の関数にしているのは、**やり取りするメッセージが丸ごと違う**ため
 * （`vt-opened` / `vt-frame` / `vt-title`）。同じ関数に押し込むと、5250 の分岐の中に
 * VT だけ通る道が増えて読めなくなる。
 *
 * 画面の中身は `vtStore` に置き、`sessionsStore` には**タブとして並ぶための最小限**だけ入れる
 * （`snapshot` は持たない——VT に `ScreenSnapshot` は無い）。
 */
export async function openVtSession(
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
            case "vt-opened": {
              sessionId = msg.sessionId;
              client.setSessionId(sessionId);
              vtStore.create(sessionId, msg.frame, {
                encoding: msg.encoding,
                ibmI: msg.ibmI,
                hostEchoes: msg.hostEchoes
              });
              sessionsStore.add({
                sessionId,
                label,
                snapshot: undefined,
                edits: new Map(),
                cursor: { row: 1, col: 1 },
                link: { state: "connected" },
                // VT は繋ぎ直さない（画面を共有する経路がそもそも無い。前 work の対象外）
                resumability: "not-resumable",
                readOnly: open.readOnly ?? false,
                client,
                pcCommandEnabled: false,
                pcCommands: [],
                ...(meta ? { meta } : {}),
                ...(configRef !== undefined ? { configRef } : {}),
                ...(systemRef !== undefined ? { systemRef } : {})
              });
              workspaceStore.addSession(sessionId, systemRef);
              resolve(sessionId);
              break;
            }
            case "vt-frame": {
              vtStore.apply(sessionId, msg.frame);
              break;
            }
            case "vt-title": {
              vtStore.setTitle(sessionId, msg.title);
              break;
            }
            case "vt-echo": {
              vtStore.setHostEchoes(sessionId, msg.hostEchoes);
              break;
            }
            case "closed": {
              // **理由まで記録するのは畳み込みで増えた分**（旧 VT 経路は `connected = false` だけで
              // `endedByHost` を立てなかった）。`hostEnded` を読むのは `canSendToHost` /
              // `resumeVerdict` / `nextLink` の 3 つだが、**VT はどれにも届かない**——
              // `resumability` が `not-resumable` なので `resumeVerdict` は理由を見る前に落ち、
              // 送信は `VtPane.vue` が `client.send` を直に呼んで `refuseIfDisconnected` を通らない。
              // だから**現状は同値**。将来 VT に送信ガードを付けたときに正しい理由が出るよう揃えておく
              sessionsStore.markLost(sessionId, msg.ended === true ? "hostEnded" : "transport");
              // **理由をそのまま渡す。** サーバーは「何を確かめればよいか」まで添えてくる
              // （画面が届かないまま閉じた IBM i など）。捨てると利用者は真っ白な画面と
              // 「切断されました」の 5 文字だけを見ることになる
              vtStore.setConnected(sessionId, false, msg.reason);
              break;
            }
            case "error":
              if (!sessionId) reject(new Error(openErrorText(msg.code, msg.message)));
              break;
          }
        },
        /**
         * **VT は繋ぎ直さない**（`20260908-session-survives-disconnect` の対象外）。
         *
         * 猶予保持は 5250 表示セッションだけで、VT はサーバー側の `dispose` が転送断で
         * その場で閉じる（画面を共有する経路がそもそも無い）。戻る先が無いので、
         * 5250 と違ってここでは「開き直してください」を出す。
         *
         * **理由は上書きしない**——ホスト都合で閉じた場合は `closed` が詳しい理由を
         * 添えて先に届いており（`vtStore.closeReason`）、汎用文で潰すと
         * 「切断されました」の 5 文字だけに戻る。
         */
        onClose() {
          const s = sessionsStore.get(sessionId);
          if (!s) return; // 利用者が閉じた（store から消えている）
          sessionsStore.markLost(sessionId, "transport");
          const known = vtStore.get(sessionId)?.closeReason;
          vtStore.setConnected(sessionId, false, known ?? MSG_VT_CONNECTION_LOST);
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

/**
 * 電文の帳票を画面の形へ（`20260802-printer-report-history`）。
 *
 * **`receivedAt` はサーバー由来を優先する。** live の push はこのあと
 * `addReport` が「無ければ現在時刻」を押すので、版の古いサーバーでも従来どおり動く。
 *
 * 開き直しの配り直しでは**押さない**——いつ届いたか分からないものに現在時刻を書けば、
 * 夜中に出た帳票が全部「いま届いた」になる。**分からないなら空**のほうが正しい。
 */
function toReportView(r: SpoolReportMsg): SpoolReportView {
  return {
    id: r.id,
    pages: r.pages,
    ...(r.receivedAt !== undefined ? { receivedAt: r.receivedAt } : {})
  };
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
              const state: SessionStateInit = {
                sessionId,
                label,
                kind: "printer",
                snapshot: undefined,
                edits: new Map(),
                cursor: { row: 1, col: 1 },
                link: { state: "connected" },
                // プリンターは自前の `onClose` を持つ（繋ぎ直しのはしごには乗らない）
                resumability: "not-resumable",
                readOnly: true,
                client,
                // **閉じている間に届いた帳票を捨てない**（`20260802-printer-report-history`）。
                // サーバーは `20260801-printer-attach-by-ref` から送っていたのに、
                // ここが `[]` と書いて捨てていた——常駐が夜のうちに受け取った帳票が、
                // 朝ブラウザを開くと 1 件も無い状態になっていた
                reports: msg.reports.map(toReportView),
                // **開いた直後に空のビューアを出さない。** 選ぶのは先頭＝一覧の `#1`
                // （live の `addReport` と同じ規則。restore だけ「最新を選ぶ」にすると規則が 2 つになる）
                ...(msg.reports[0] ? { selectedReportId: msg.reports[0].id } : {}),
                // 累計（**サーバー側で落ちた分も含む**）。保持数との差が落ちた数
                receivedTotal: msg.receivedTotal,
                // **未読は 0 のまま。** ここで受け取るのは「閉じている間に届いた既存分」で、
                // いま開いて見ているもの。`addReport` を回すと件数ぶんバッジが光り、
                // 「新着 50 件」と嘘をつくことになる
                // **待ち受けていなければ起動応答コードは無い**（接続していない）。
                // `exactOptionalPropertyTypes` 下では undefined を入れられないので、キーごと落とす
                ...(msg.startupCode !== undefined ? { startupCode: msg.startupCode } : {}),
                // **「開く」と「待ち受ける」は別。** `自動で待ち受け開始 ☐` なら
                // `stopped` で返り、利用者の開始ボタンを待つ
                state: msg.state,
                // **止まった理由を捨てない。** `printer-state` の push は繋いでいる間しか
                // 届かないので、ここで受けないと「エラーとだけ出て理由が無い」になる
                ...(msg.error !== undefined ? { serviceError: msg.error } : {}),
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
              sessionsStore.addReport(sessionId, toReportView(msg.report));
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
              // 理由まで記録するのは畳み込みで増えた分。**プリンターにも送信経路はある**
              // （`setPrinterOutput` / `startPrinter` / `stopPrinter`）が、いずれも `client.send` を
              // 直に呼んで `refuseIfDisconnected` を通らない——VT と同じ理由で現状は同値
              // （`resumability` も `not-resumable` なので `resumeVerdict` にも届かない）
              sessionsStore.markLost(sessionId, msg.ended === true ? "hostEnded" : "transport");
              break;
            }
            case "error":
              if (!sessionId) reject(new Error(openErrorText(msg.code, msg.message)));
              break;
          }
        },
        /**
         * **プリンターは繋ぎ直さない**（`20260908-session-survives-disconnect` の対象外）。
         *
         * 理由は「戻る先が無い」ことではなく、**`resume` の口が無い**こと——
         * サーバーの `attach` は 5250 専用で、プリンターの繋ぎ直しは設定（`ref`）で
         * 開き直す別の経路（`20260801-printer-attach-by-ref`）に載っている。
         *
         * **`notice` は書くが、いまのプリンターペインはそれを描いていない**
         * （`PrinterPane` は `state` と `serviceError` を出す）。利用者に届くのは
         * タブの接続状態だけ——ここは残課題として `retro.md` に送る。書き込み自体は
         * `SessionState` の規約どおりなので、描く側が足りていないだけ。
         *
         * **受信済みの帳票は消さない**——見ている途中で接続だけ切れることがあり、
         * 消すと読みかけの帳票ごと消える。
         */
        onClose() {
          const s = sessionsStore.get(sessionId);
          if (!s) return; // 利用者が閉じた（store から消えている）
          sessionsStore.markLost(sessionId, "transport");
          s.notice = MSG_CONNECTION_LOST;
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
/**
 * 予約（HLLAPI の `Reserve`）を強制的に外す——利用者の非常口。
 *
 * **結果は待たない**——外れれば `reserved` が push で届く。
 * 自動化が落ちると `Release` が来ないので、期限（2 分）を待たずに取り戻す口が要る。
 */
export function breakReservation(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  // **繋がっていなければ送らない。** 死んだ口へ投げても捨てられるだけで、
  // 覆いが外れたように見えて実際は外れていない、という食い違いになる
  if (!s || refuseIfDisconnected(s)) return;
  s.client.send({ type: "reserve-break" });
}

export function setPrinterOutput(sessionId: string, enabled: boolean): void {
  sessionsStore.get(sessionId)?.client.send({ type: "printer-output", enabled });
}

/**
 * **出力に失敗して応答を止めている帳票**の再試行・取消（ACS のプリンター・エラーの「再試行」「取消」。
 * `20260921-printer-hold-response`）。結果は `printer-output-result` で届く
 */
export function retryPrinterOutput(sessionId: string): void {
  sessionsStore.get(sessionId)?.client.send({ type: "printer-output-retry" });
}
export function cancelPrinterOutput(sessionId: string): void {
  sessionsStore.get(sessionId)?.client.send({ type: "printer-output-cancel" });
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
/**
 * **3270 のキーの読み替えは画面では行わない。**
 *
 * 割り当てはホストの種類で変わる——IBM i では 3270 の `PF3` は F3 ではなく
 * 「画面の消去」で、F1〜F12 は `PA1` ＋ `PFn` で送る。メインフレームは `PFn` がそのまま Fn。
 * **どちらのホストかを知っているのはサーバーだけ**なので、表をここにも置くと必ずずれる。
 *
 * 以前はここで `PageUp` を `F7` に写していたが、F キーの送り方が変わると
 * **ページ送りが F7 になって壊れる**。読み替えごとサーバーへ移した
 * （`server/src/tn3270-adapt.ts` の `planKey3270`）。
 *
 * 送れないキーは**サーバーが理由を返す**。
 */


/** 検査で止めたときの操作員メッセージ */
const MSG_BY_VIOLATION: Record<MandatoryFinding["reason"], string> = {
  "mandatory-fill": MSG_MANDATORY_FILL,
  "field-exit-required": MSG_FIELD_EXIT_REQUIRED,
  "self-check": MSG_SELF_CHECK,
  "mandatory-enter": MSG_MANDATORY_ENTER
};

/** その AID キーが SOH で申告された CA キー（欄データを返さない F キー）か */
function isCaKey(key: AidKey, caKeys: readonly number[] | undefined): boolean {
  const m = /^F(\d+)$/.exec(key);
  return m !== null && caKeys !== undefined && caKeys.includes(Number(m[1]));
}

/**
 * AID の前の検査（順序は ACS `PS5250.processAIDCode`）。止めるならその違反を返す。
 * 0020 の待ち（`awaitingFieldExit`）はペインが付け外しする（カーソルがその欄にいる間だけ付いている）。
 */
function checkBeforeAid(
  s: SessionState,
  key: AidKey,
  pos: { row: number; col: number }
): MandatoryFinding | undefined {
  const snap = s.snapshot!;
  const here = fieldAt(pos.row, pos.col, snap.fields, snap.cols, snap.rows);
  const fill = findFieldViolation(here, s.edits, snap.fields);
  if (fill?.reason === "mandatory-fill") return fill;
  if (s.awaitingFieldExit !== undefined) {
    const f = snap.fields.find((x) => x.index === s.awaitingFieldExit);
    if (f) return { field: f, reason: "field-exit-required" };
  }
  if (fill) return fill; // 自己点検
  // ME は CA キーでは見ない（`DS5250.isSOH_PF`。実機: ME が空でも F3＝CA03 で抜けられた）
  if (isCaKey(key, snap.caKeys)) return undefined;
  return findMandatoryEnterViolation(snap.fields, s.edits);
}

export function sendKey(
  sessionId: string,
  key: AidKey,
  cursor?: { row: number; col: number },
  sysReqText?: string
): MandatoryFinding | undefined {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  // **繋がっていなければ理由を出して止める。** `WsClient.send` は OPEN でなければ黙って
  // 捨てるので、そのまま通すと「押したのに何も起きない」になる。フラグキー（Attn / SysReq）も
  // 同じ——送り先が無いのだから逃げ道にならない
  if (refuseIfDisconnected(s)) return;
  // **ホストへ繋ぎ直している間は送らない**（フラグキーも。送り先が無い——サーバーの core が断る）
  if (s.hostReconnect !== undefined) return;
  // 通信中・ホスト施錠中は送らない（プロテクト）。**フラグキーだけは通す**（`isFlagKey`）
  if (inputInhibited(s) && !isFlagKey(key)) return;
  if (blocksManualInput(sessionId)) return; // 再生中の手入力は通さない（spec のエッジケース）
  // **AID の前の検査**（ACS `PS5250.processAIDCode` と同じ順。`20260921-mandatory-check-acs`）:
  //   1) カーソル下の欄の MF  2) 0020（欄を出ずに AID）  3) カーソル下の欄の自己点検  4) ME（CA キーは見ない）
  // **Enter に限らない**——F キー・Roll でも止まる（実機の ACS で確かめた）。原典が外すのは Help・Clear・
  // Record Backspace だけ（`processAIDCode` の 243・189・248。フラグキーは AID ではない）。
  // ~~Enter のときだけ検証する（`20260729-ffw-behavior-bits` D1）~~ は破棄した
  if (!isFlagKey(key) && key !== "Help" && key !== "Clear" && key !== "RecordBackspace" && s.snapshot) {
    const hit = checkBeforeAid(s, key, cursor ?? s.cursor);
    if (hit) {
      s.notice = MSG_BY_VIOLATION[hit.reason];
      return hit;
    }
  }
  // **読み替えはしない**（上の注記）。3270 の割り当てはサーバーが決める
  const outKey = key;
  delete s.notice; // 前回の通知は次の操作で消す
  // **フラグキー（Attn / SysReq）にも欄を載せる。** ホストへ送るレコードには載らない
  // （`buildFlagRecord` は欄データを持たない）——載せるのは**サーバー側の画面バッファへ
  // 打鍵を移すため**。ACS は打鍵した文字を表示バッファ（`PS5250` の `HostPlane`/`TextPlane`）に
  // 持ち、それが SAVE SCREEN の退避に入るので、Attn → F12 で戻っても消えない
  // （`20260920-restore-screen-parity` research F1・F4・F11、decisions D6）。
  //
  // **入力が止まっているときは載せない。** サーバーは施錠中に書かない（SysReq という逃げ道を
  // 未送信の入力で塞がないため）ので、送っても捨てられるだけ——打ちかけの値を無駄に流すことになる。
  //
  // ⚠ **こちらの条件はサーバーより広い**——`inputInhibited` は `busy`（応答待ち）でも真になるが、
  // サーバーのゲートは `keyboardLocked` だけ。`key-done` が届く前にホストが解錠した画面を
  // push した窓では、**サーバーは書けるのに欄が届かない**。広い側に倒しているのは
  // 「打ちかけの値を無駄に流さない」を優先したため（`20260920-restore-screen-parity` review ラウンド 3）。
  const carryFields = !isFlagKey(key) || !inputInhibited(s);
  const fields = carryFields ? [...s.edits.entries()].map(([field, value]) => ({ field, value })) : [];
  // 送信**前**に記録する（送信後だと edits が新画面で消えていることがある）
  // **記録は送った側のキー**——再生したときに同じことが起きるように
  recordSend(sessionId, outKey, cursor ?? s.cursor, sysReqText);
  s.client.send({
    type: "key",
    key: outKey,
    ...(cursor ? { cursor } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    ...(sysReqText !== undefined ? { sysReqText } : {})
  });
  // **フラグキーは busy に載せない。** 応答を待たないキーなので待ちようが無く、
  // 載せると「応答待ちの最中に押した Attn」が**元の待ちの busy を解いて**しまう
  // （サーバーもフラグキーには `key-done` を返さない）。プロテクトは施錠（`keyboardLocked`）が
  // 引き続き効くので、押せるようになるわけではない
  if (!isFlagKey(key)) setBusy(sessionId, true);
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
  if (refuseIfDisconnected(s)) return;
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
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  if (refuseIfDisconnected(s)) return;
  if (blocksManualInput(sessionId)) return; // 再生中の手入力は通さない
  noteUnrecordable(sessionId);
  s.client.send({ type: "gui-select", fieldId, choiceIndex, selected });
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
  if (!s || inputInhibited(s)) return;
  if (refuseIfDisconnected(s)) return;
  if (blocksManualInput(sessionId)) return; // 再生中の手入力は通さない
  noteUnrecordable(sessionId);
  s.client.send({ type: "gui-submit", fieldId, ...(cursor ? { cursor } : {}) });
  setBusy(sessionId, true);
}

export function closeSession(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  // **繋ぎ直しは待ちも飛行中の口も畳む。** 待ちだけ消しても、発火済みの試行は
  // 走り続けて `opened` を受け取ってしまう（サーバー側は引き取り済みになる）
  abortReconnect(sessionId);
  // 閉じた id の記憶を残さない（`setBusy` と同じものを畳む）
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
