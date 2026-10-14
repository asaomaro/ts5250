/**
 * 欄の編集（打鍵・Delete・Backspace・Field Exit）を `@ts5250/tn5250/edit/*` の純関数に委ねる層。
 *
 * 編集の規則（挿入の余地・型の検査・SO/SI の補完・符号桁）は web-ui と同じ関数を呼ぶ——ここへ写し直すと
 * 結果が食い違う（`20261014-terminal-ui` decisions D7）。web-ui の `ScreenGrid.vue` から持ってきたのは
 * 「欄の値を画面のセルから組む」「編集の結果を `setField` の値へ戻す」だけの薄い糊で、Vue・DOM には触れない。
 *
 * 対応する欄: 通常の文字欄（`dbcsType` なし）と O 欄（`open`）。どちらも**継続欄・語送り欄は対象外**
 * （web-ui は鎖全体・語送りの専用経路を持つ。端末版は未対応と明示して値を変えない）。J・E・G も同様。
 */
import type { Field, ScreenSnapshot } from "@ts5250/tn5250";
import { typeChar, insertChar, backspace, del, fieldExit, initEdit, editValue, type EditState } from "@ts5250/tn5250/edit/fieldEdit";
import { fieldSpan, offsetOfPos, posOfOffset } from "@ts5250/tn5250/edit/fieldSlices";
import { rejectReason, isSignPosition, SO_MARK, SI_MARK, isWideForDbcs, type RejectReason } from "@ts5250/tn5250/edit/fieldValidate";
import {
  toCells, fromCells, cellOfEntry, entryOfCell, overwrite as oOverwrite, insert as oInsert,
  del as oDel, backspace as oBackspace, eraseToEnd as oEraseToEnd, type OResult, type OCell
} from "@ts5250/tn5250/edit/oFieldCells";
import { isFullWidth } from "@ts5250/base";

export const MSG_NO_ROOM = "挿入する余地がありません";
export const MSG_PROTECTED = "カーソルが保護された区域にあるため入力できません";
export const MSG_SHIFT_POSITION = "この位置（全角の区切り）では操作できません";
export const MSG_UNSUPPORTED = "この種類の欄の編集は未対応です（継続・語送り・J・E・G）";
export const MSG_FIELD_EXIT_KEY = "この項目は最終桁まで入力されています（Field Exit か Tab で項目を出てください）";

/** 欄に打てない理由の表示（web-ui の `MSG_BY_REASON` と同じ文言） */
export const MSG_BY_REASON: Record<RejectReason, string> = {
  numeric: "数字項目には数字しか入力できません",
  alphanumeric: "この項目には半角文字しか入力できません",
  "dbcs-required": "この項目には全角文字しか入力できません",
  "alpha-only": "この項目には英字しか入力できません",
  "kbd-inhibited": "この項目はキーボードから入力できません",
  "sign-position": "符号桁には数字を入力できません（符号は - / + キーで入れます）",
  "katakana-invalid": "このキーは定義されていないため入力できません"
};

export interface EditEnv {
  cols: number;
  rows: number;
  insertMode: boolean;
  /** DBCS の CCSID でないセッション。幅の判定（`rejectReason`）を SBCS 向けにする */
  sbcsOnly: boolean;
}

/** 編集 1 回の結果。`value` を `setField` へ渡し、カーソルを `cursor` へ置く。`note` は操作員への一言 */
export type EditOutcome =
  | { ok: true; value: string; cursor: { row: number; col: number }; filled?: boolean }
  | { ok: false; note?: string };

const fail = (note?: string): EditOutcome => (note === undefined ? { ok: false } : { ok: false, note });

/** 端末版が編集できる欄か */
export function editable(f: Field): boolean {
  if (f.continued !== undefined || f.wordWrap === true) return false;
  return f.dbcsType === undefined || f.dbcsType === "open";
}

const isOpen = (f: Field): boolean => f.dbcsType === "open";

/** MONOCASE 欄は 1 バイト文字を大文字にする（web-ui の `inputChar`。µ と全角は変えない） */
function inputChar(ch: string, f: Field, env: EditEnv): string {
  if (f.monocase !== true) return ch;
  if (ch === "µ" || (!env.sbcsOnly && isFullWidth(ch))) return ch;
  const up = ch.toUpperCase();
  return up.length === 1 ? up : ch;
}

/** 打鍵で埋められる最後の桁（符号付き数値は符号桁の手前） */
const lastTypeable = (f: Field, span: number): number => span - 1 - (f.signedNumeric === true ? 1 : 0);

/**
 * O 欄の値を画面のセルから組む（SO/SI は印、ホストが書かなかった桁は NUL）。
 * web-ui `logicalFromCells` の継続でない O 欄の枝と同じ手順
 */
function openValue(f: Field, snap: ScreenSnapshot): string {
  const row = snap.cells[f.row - 1];
  let s = "";
  if (!row) return s;
  for (let i = 0; i < f.length; i++) {
    const cell = row[f.col - 1 + i];
    if (!cell) continue;
    if (cell.kind === "sbcs" && cell.char === " " && cell.rawByte === undefined) s += "\u0000";
    else if (cell.kind === "sbcs" || cell.kind === "dbcs-lead") s += cell.char;
    else if (cell.kind === "so") s += SO_MARK;
    else if (cell.kind === "si") s += SI_MARK;
    // dbcs-tail は lead が持つ。attr は O 欄の中に現れない
  }
  return s.replace(/\u0000+$/, "");
}

/** 欄の編集の状態を組む（O 欄は印入りの値、通常欄は空白で詰めた値） */
function stateOf(f: Field, snap: ScreenSnapshot, off: number, env: EditEnv): EditState {
  const span = fieldSpan(f, env.cols, env.rows);
  if (isOpen(f)) {
    // O 欄の詰め物は空き（NUL）。空白で詰めると打っていない桁が中身として送られる。全角は 1 要素で 2 桁
    const chars = [...openValue(f, snap)];
    let used = chars.reduce((n, c) => n + (isWideForDbcs(c) ? 2 : 1), 0);
    while (used < span) {
      chars.push("\u0000");
      used++;
    }
    return { chars, cursor: entryOfCell(chars, off), insertMode: env.insertMode };
  }
  const st = initEdit(f.value, span, off);
  return { ...st, insertMode: env.insertMode };
}

/** 画面の位置 → 欄内の桁。O 欄は桁がセルの並びと 1 対 1 なので、編集の要素の位置へ直す */
function offsetAt(f: Field, pos: { row: number; col: number }, env: EditEnv): number | undefined {
  return offsetOfPos(f, pos.row, pos.col, env.cols, env.rows);
}

function finish(f: Field, st: EditState, env: EditEnv, filled = false): EditOutcome {
  // 末尾の詰め物だけ落とす。打った空白は中身として残す（O 欄は NUL が空き）
  const raw = editValue(st);
  const value = isOpen(f) ? raw.replace(/\u0000+$/, "") : raw.replace(/ +$/, "");
  const at = isOpen(f) ? cellOfEntry(st.chars, st.cursor) : st.cursor;
  return { ok: true, value, cursor: posOfOffset(f, Math.min(at, fieldSpan(f, env.cols, env.rows)), env.cols, env.rows), ...(filled ? { filled } : {}) };
}

/** O 欄の操作をセルの上で行い、編集の状態へ戻す */
function oApply(f: Field, st: EditState, env: EditEnv, op: (cells: OCell[], c: number) => OResult): EditState | EditOutcome {
  const span = fieldSpan(f, env.cols, env.rows);
  const cells = toCells(st.chars, span);
  const r = op(cells, cellOfEntry(st.chars, st.cursor));
  if ("error" in r) {
    return fail(r.error === 0x12 ? MSG_NO_ROOM : r.error === 0x05 ? MSG_PROTECTED : MSG_SHIFT_POSITION);
  }
  if ("noop" in r) return fail();
  const chars = fromCells(r.cells);
  return { ...st, chars, cursor: entryOfCell(chars, r.cursor) };
}

const isOutcome = (x: EditState | EditOutcome): x is EditOutcome => "ok" in x;

/** 1 文字を打つ */
export function typeInto(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, raw: string, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail("ここには入力できません");
  const ch = inputChar(raw, f, env);
  const why = rejectReason(f, ch, { sbcsOnly: env.sbcsOnly });
  if (why) return fail(MSG_BY_REASON[why]);
  const span = fieldSpan(f, env.cols, env.rows);
  const st = stateOf(f, snap, off, env);

  if (isOpen(f)) {
    const r = oApply(f, st, env, (cells, c) => (env.insertMode ? oInsert(cells, c, ch) : oOverwrite(cells, c, ch)));
    return isOutcome(r) ? r : finish(f, r, env);
  }
  if (env.insertMode) {
    const t = insertChar(st, ch, lastTypeable(f, span));
    return t ? finish(f, t, env) : fail(MSG_NO_ROOM);
  }
  if (isSignPosition(f, st.cursor, span)) return fail(MSG_BY_REASON["sign-position"]);
  const t = typeChar(st, ch);
  // 最終桁（符号付き数値は符号桁の手前）に打った：満杯。Field Exit が必須の欄は留まる
  const filled = st.cursor === lastTypeable(f, span);
  return finish(f, t, env, filled);
}

/** Delete */
export function deleteAt(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail();
  const st = stateOf(f, snap, off, env);
  if (isOpen(f)) {
    const r = oApply(f, st, env, (cells, c) => oDel(cells, c));
    return isOutcome(r) ? r : finish(f, r, env);
  }
  return finish(f, del(st), env);
}

/** Backspace（欄の先頭では呼び出し側が前の桁へ動かす） */
export function backspaceAt(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined || off === 0) return fail();
  const st = stateOf(f, snap, off, env);
  if (isOpen(f)) {
    const r = oApply(f, st, env, (cells, c) => oBackspace(cells, c));
    return isOutcome(r) ? r : finish(f, r, env);
  }
  return finish(f, backspace(st), env);
}

/** Field Exit: カーソル以降を消し、右寄せ（ADJUST）を掛ける。O 欄はセルの並びを閉じる */
export function exitAt(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail();
  const st = stateOf(f, snap, off, env);
  if (isOpen(f)) {
    const span = fieldSpan(f, env.cols, env.rows);
    const cells = oEraseToEnd(toCells(st.chars, span), cellOfEntry(st.chars, st.cursor));
    return finish(f, { ...st, chars: fromCells(cells), cursor: st.cursor }, env);
  }
  return finish(f, fieldExit(st, f), env);
}

export { isWideForDbcs };
