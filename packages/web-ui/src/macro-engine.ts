import type { Field, ScreenSnapshot } from "@as400web/core";
import type { PublicMacroStep } from "@as400web/server";
import { sessionsStore, type MacroStopReason, type SessionState } from "./stores/sessions.js";
import { macrosStore } from "./stores/macros.js";
import { sendKeyWithFields, type OutgoingField } from "./session-controller.js";
import { macroStateOf } from "./macro-record.js";

/**
 * マクロの**再生側**。
 *
 * 記録側（`macro-record.ts`）と分けてあるのは依存の向きのため——記録は
 * `session-controller` から呼ばれる側、再生は `session-controller` を呼ぶ側なので、
 * 1 ファイルにすると循環 import になる（decisions D1）。
 *
 * 再生の核は 2 つだけ:
 *   - **`busy` が false に戻るまで待ってから次を送る**（spec D3）。`sendKey` 自身が
 *     `busy` 中の送信を弾くため、待たないと黙って取りこぼす
 *   - **打ち込む先が記録時と同じ形で在るかを照合してから送る**（spec D4）。
 *     無照合だと違う画面にパスワードを流す事故が起きる
 *
 * 秘密は**値を持たずに参照（`secretRef`）だけ**を送り、サーバーが所有者を確かめて
 * 復号し、ホストへ書く直前に差し替える（spec D11）。平文はブラウザに一度も現れない。
 */

/** 応答待ちの上限。超えたら止める（ホスト無応答で永久に待たない。spec D9） */
const PLAY_WAIT_TIMEOUT_MS = 120_000;
/** `busy` の監視間隔 */
const POLL_MS = 25;

/**
 * 記録時と同じ欄が、同じ座標・同じ長さで**入力可能に**存在するか（spec D4）。
 *
 * 画面全体のテキストは照合しない（サブファイルの行数変動などで誤検知が多い）。
 * 逆に無照合だと「違う画面に打ち込む」事故が起きるため、**これから書き込む欄だけ**を厳格に見る。
 */
export function screenMatches(snap: ScreenSnapshot, step: PublicMacroStep): boolean {
  if (snap.rows !== step.screen.rows || snap.cols !== step.screen.cols) return false;
  return step.screen.targets.every((t) => {
    const f: Field | undefined = snap.fields.find((x) => x.index === t.field);
    return f !== undefined && !f.protected && f.row === t.row && f.col === t.col && f.length === t.len;
  });
}

function stop(s: SessionState, reason: MacroStopReason, message?: string): void {
  s.macro = { mode: "idle", steps: [], index: 0, stopReason: reason, ...(message ? { message } : {}) };
}

/** `busy` が解けるのを待つ。切断・停止・上限で打ち切る */
async function waitIdle(sessionId: string): Promise<"ok" | "timeout" | "disconnected" | "stopped"> {
  const deadline = Date.now() + PLAY_WAIT_TIMEOUT_MS;
  for (;;) {
    const s = sessionsStore.get(sessionId);
    if (!s || !s.connected) return "disconnected";
    if (s.macro?.mode !== "playing") return "stopped";
    if (!s.busy) return "ok";
    if (Date.now() > deadline) return "timeout";
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * 再生を開始する。既に何か走っていれば無視する（記録と再生は排他）。
 * 実行は非同期に進み、UI は `s.macro` を見て状態を出す。
 */
export function play(sessionId: string, macroId: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  if (s.macro && s.macro.mode !== "idle") return;
  if (!s.connected) return stop(s, "disconnected", "切断されています");
  if (s.readOnly) return stop(s, "readonly", "閲覧のみのセッションでは再生できません");
  if (!macrosStore.get(macroId)) return stop(s, "mismatch", "マクロが見つかりません");
  s.macro = { mode: "playing", macroId, steps: [], index: 0 };
  void runFrom(sessionId);
}

export function pausePlay(sessionId: string): void {
  const rt = macroStateOf(sessionId);
  if (rt?.mode === "playing") rt.mode = "playPaused";
}

export function resumePlay(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  if (s?.macro?.mode !== "playPaused") return;
  s.macro.mode = "playing";
  delete s.macro.message;
  void runFrom(sessionId);
}

export function stopPlay(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  const mode = s?.macro?.mode;
  if (!s || (mode !== "playing" && mode !== "playPaused")) return;
  stop(s, "user");
}

/** 現在の `index` から順に流す。休止・停止・異常で抜ける */
async function runFrom(sessionId: string): Promise<void> {
  for (;;) {
    const s = sessionsStore.get(sessionId);
    if (!s) return;
    const rt = s.macro;
    if (!rt || rt.mode !== "playing" || rt.macroId === undefined) return;

    const macro = macrosStore.get(rt.macroId);
    if (!macro) return stop(s, "mismatch", "マクロが見つかりません");
    if (rt.index >= macro.steps.length) return stop(s, "completed");

    // 前の送信の応答を待ってから照合する（古い画面と突き合わせない）
    const waited = await waitIdle(sessionId);
    if (waited === "stopped") return;
    if (waited === "timeout") return stop(s, "timeout", "ホストの応答がありません");
    if (waited === "disconnected") return stop(s, "disconnected", "切断されました");

    const step = macro.steps[rt.index]!;
    const snap = s.snapshot;
    if (!snap) return stop(s, "mismatch", "画面がありません");
    if (!screenMatches(snap, step)) {
      return stop(s, "mismatch", `画面が一致しません（ステップ ${rt.index + 1}）`);
    }

    // 「毎回入力する」欄に来たら自動で休止し、ユーザーの入力と再開を待つ（spec D5）
    if (step.promptFields && step.promptFields.length > 0) {
      rt.mode = "playPaused";
      rt.message = `入力してから再開してください（ステップ ${rt.index + 1}）`;
      return;
    }

    const outgoing: OutgoingField[] = step.fields.map((f) => ({ field: f.field, value: f.value }));
    // 秘密は**値を持たずに参照だけ**送る。サーバーが所有者を確かめて復号し差し替える（spec D11）
    for (const field of step.secretFields ?? []) {
      outgoing.push({ field, secretRef: { macroId: macro.id, step: rt.index, field } });
    }

    sendKeyWithFields(sessionId, step.key, step.cursor, outgoing, step.sysReqText);
    rt.index += 1;

    // 送信が busy を立てるまでの隙間で次の周回に入らないよう 1 tick 譲る
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
