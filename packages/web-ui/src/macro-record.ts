import { sessionsStore, type DraftStep, type MacroRuntime, type SessionState } from "./stores/sessions.js";
import { macrosStore, type CreateMacroStep, type SecretChoice } from "./stores/macros.js";
import type { PublicMacro } from "@as400web/server";

/**
 * マクロの**記録側**と、記録・再生に共通の状態ヘルパ。
 *
 * **このファイルは `session-controller` に依存しない**——依存の向きを
 * `session-controller → macro-record` の一方向に保つため（逆向きにすると循環 import になる。
 * 再生側は送信が要るので `macro-engine.ts` に分けてある。decisions D1）。
 *
 * 記録は `sendKey` の送信直前に `recordSend()` を呼ぶだけで成立する（spec D2）。
 * 5250 の送信はもともと「AID ＋ そのフォーマットで編集したフィールド値」で、新しい画面が
 * 届くとローカル編集差分が消える。この画面境界がそのままステップの区切りになる（spec D1）。
 * だからキーボード・機能キー凡例ボタン・ホイール・OIA ボタンのどの経路から送られても、
 * コンポーネントを一切変えずに記録できる。
 *
 * **秘密（パスワード）の扱いがこのファイルの要**（spec D5）。`sendKey` にフックを置くと
 * ユーザーが打ったパスワードは `s.edits` 経由で手に入ってしまう。`DraftStep.secrets` に隔離し、
 * 保存時にユーザーが選ぶまで draft の外へ出さない。localStorage には決して書かない。
 */

function runtimeOf(s: SessionState): MacroRuntime {
  if (!s.macro) s.macro = { mode: "idle", steps: [], index: 0 };
  return s.macro;
}

/** そのセッションのマクロ状態（未開始なら undefined＝ idle 相当） */
export function macroStateOf(sessionId: string): MacroRuntime | undefined {
  return sessionsStore.get(sessionId)?.macro;
}

export function isRecording(sessionId: string): boolean {
  const m = macroStateOf(sessionId)?.mode;
  return m === "recording" || m === "recordPaused";
}

export function isPlaying(sessionId: string): boolean {
  const m = macroStateOf(sessionId)?.mode;
  return m === "playing" || m === "playPaused";
}

/** 再生中はユーザーの手入力を通さない（`busy` プロテクトに加えた二重の歯止め） */
export function blocksManualInput(sessionId: string): boolean {
  return macroStateOf(sessionId)?.mode === "playing";
}

// ---- 記録 ----

export function startRecording(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  // 記録と再生は排他。走っているものがあれば無視する（spec の状態遷移）
  if (runtimeOf(s).mode !== "idle") return;
  s.macro = { mode: "recording", steps: [], index: 0 };
}

export function pauseRecording(sessionId: string): void {
  const rt = macroStateOf(sessionId);
  if (rt?.mode === "recording") rt.mode = "recordPaused";
}

export function resumeRecording(sessionId: string): void {
  const rt = macroStateOf(sessionId);
  if (rt?.mode === "recordPaused") rt.mode = "recording";
}

/**
 * 記録中に「記録できない操作」（拡張5250 の GUI 選択）が起きたことを控える（spec D8）。
 * 黙って落とすと**再生できないマクロが黙って出来上がる**ので、印を立てて保存時に警告する。
 */
export function noteUnrecordable(sessionId: string): void {
  const rt = macroStateOf(sessionId);
  if (rt?.mode === "recording" || rt?.mode === "recordPaused") {
    rt.incomplete = true;
    rt.message = "記録できない操作（選択フィールド）が含まれます";
  }
}

/**
 * 送信直前のフック（`sendKey` から呼ばれる）。**`recording` 以外では何もしない**。
 *
 * 非表示（パスワード）欄は `secrets` へ分けて隔離する。`snapshot.fields[i].hidden` は
 * セルの `nonDisplay` を優先した実測ベースの判定なので、属性だけを見るより取りこぼしが少ない。
 */
export function recordSend(
  sessionId: string,
  key: string,
  cursor: { row: number; col: number },
  sysReqText?: string
): void {
  const s = sessionsStore.get(sessionId);
  const rt = s?.macro;
  // recordPaused 中は積まない（spec D5 の「一時的に記録を止める」）
  if (!s || !rt || rt.mode !== "recording") return;
  const snap = s.snapshot;
  if (!snap) return;

  const step: DraftStep = {
    screen: { rows: snap.rows, cols: snap.cols, targets: [] },
    fields: [],
    secrets: [],
    cursor: { ...cursor },
    key
  };
  if (sysReqText !== undefined) step.sysReqText = sysReqText;

  for (const [index, value] of s.edits) {
    const f = snap.fields.find((x) => x.index === index);
    // 画面から消えた欄は照合材料を作れない。書き込み先が特定できないものは記録しない
    if (!f) continue;
    step.screen.targets.push({ field: index, row: f.row, col: f.col, len: f.length });
    if (f.hidden) step.secrets.push({ field: index, value });
    else step.fields.push({ field: index, value });
  }

  rt.steps.push(step);
}

/** 保存ダイアログ用: 記録中の秘密の在りか（値は返さない） */
export interface PendingSecret {
  /** 選択のキー。`stopRecording` の `choices` と対応する */
  key: string;
  step: number;
  field: number;
  row: number;
  col: number;
}

export function pendingSecrets(sessionId: string): PendingSecret[] {
  const rt = macroStateOf(sessionId);
  if (!rt) return [];
  const out: PendingSecret[] = [];
  rt.steps.forEach((s, i) => {
    for (const sec of s.secrets) {
      const t = s.screen.targets.find((x) => x.field === sec.field);
      out.push({ key: `${i}:${sec.field}`, step: i, field: sec.field, row: t?.row ?? 0, col: t?.col ?? 0 });
    }
  });
  return out;
}

/**
 * 記録を終了する。`save=false` なら**平文ごと破棄**して何も送らない。
 *
 * `choices` は欄ごとの秘密の扱い（`"<step>:<field>"` → store / prompt / skip）。
 * 未指定の欄は、サーバーに鍵があれば `store`、無ければ `prompt` を既定にする——
 * 鍵が無いのに `store` を選ぶと保存自体が 400 で落ち、記録がまるごと失われるため。
 */
export async function stopRecording(
  sessionId: string,
  save: boolean,
  name?: string,
  choices?: Record<string, SecretChoice>
): Promise<PublicMacro | undefined> {
  const s = sessionsStore.get(sessionId);
  const rt = s?.macro;
  if (!s || !rt || (rt.mode !== "recording" && rt.mode !== "recordPaused")) return undefined;

  const steps = rt.steps;
  const incomplete = rt.incomplete === true;
  // **先に状態を戻す**: 保存の途中で失敗しても「記録中」のまま取り残されないように
  s.macro = { mode: "idle", steps: [], index: 0 };

  if (!save || steps.length === 0 || name === undefined || name === "") {
    discard(steps);
    return undefined;
  }

  const fallback: SecretChoice = macrosStore.canStoreSecrets ? "store" : "prompt";
  const payload: CreateMacroStep[] = steps.map((d, i) => {
    const step: CreateMacroStep = { screen: d.screen, fields: d.fields, key: d.key, cursor: d.cursor };
    if (d.sysReqText !== undefined) step.sysReqText = d.sysReqText;

    const plain: { field: number; value: string }[] = [];
    const prompts: number[] = [];
    for (const sec of d.secrets) {
      const choice = choices?.[`${i}:${sec.field}`] ?? fallback;
      if (choice === "store") plain.push({ field: sec.field, value: sec.value });
      else if (choice === "prompt") prompts.push(sec.field);
      // skip は何も残さない（欄ごと記録しない）
    }
    if (plain.length > 0) step.plainSecrets = plain;
    if (prompts.length > 0) step.promptFields = prompts;
    return step;
  });

  try {
    return await macrosStore.create({ name, ...(incomplete ? { incomplete } : {}), steps: payload });
  } finally {
    // 平文を確実に手放す（例外で抜けても残さない）
    discard(steps);
  }
}

/** draft から平文を消す。参照が他所に渡っていても中身は空になる */
function discard(steps: DraftStep[]): void {
  for (const d of steps) d.secrets.length = 0;
  steps.length = 0;
}
