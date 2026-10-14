/**
 * 欄の編集（打鍵・Delete・Backspace・Field Exit）を `@ts5250/tn5250/edit/*` の純関数に委ねる層。
 *
 * 編集の規則（挿入の余地・型の検査・SO/SI の補完・符号桁）は web-ui と同じ関数を呼ぶ——ここへ写し直すと
 * 結果が食い違う（`20261014-terminal-ui` decisions D7）。web-ui の `ScreenGrid.vue` から持ってきたのは
 * 「欄の値を画面のセルから組む」「編集の結果を `setField` の値へ戻す」だけの薄い糊で、Vue・DOM には触れない。
 *
 * 対応する欄: 通常の文字欄（`dbcsType` なし。行をまたぐ欄・語送り欄・継続欄〔EDTMSK の区間の並び〕を含む）と O 欄（`open`。
 * 継続でないもの）。J・E・G と、継続した O 欄・継続した語送り欄は未対応と明示して値を変えない
 * （web-ui は専用の経路を持つ。端末版は第 4 段までの範囲）。
 */
import type { Field, ScreenSnapshot } from "@ts5250/tn5250";
import { typeChar, insertChar, backspace, del, fieldExit, initEdit, editValue, type EditState } from "@ts5250/tn5250/edit/fieldEdit";
import { fieldSpan, fieldSlices, offsetOfPos, posOfOffset } from "@ts5250/tn5250/edit/fieldSlices";
import { rejectReason, isSignPosition, SO_MARK, SI_MARK, DEAD_MARK, isDeadMark, isWideForDbcs, type RejectReason } from "@ts5250/tn5250/edit/fieldValidate";
import { wordWrap, NUL as WRAP_NUL } from "@ts5250/tn5250/edit/wordWrap";
import { continuedRunOf } from "@ts5250/tn5250/edit/continuedRun";
import {
  toCells, fromCells, cellOfEntry, entryOfCell, overwrite as oOverwrite, insert as oInsert,
  del as oDel, backspace as oBackspace, eraseToEnd as oEraseToEnd, type OResult, type OCell
} from "@ts5250/tn5250/edit/oFieldCells";
import { chainInsert, chainOverwrite, chainDelete, chainBackspace, type ChainPos, type ChainResult } from "@ts5250/tn5250/edit/oChainCells";
import { splitLead, SPLIT_TAIL } from "@ts5250/tn5250/browser";
import { isFullWidth } from "@ts5250/base";
import { isJeg, jegType, jegDelete, jegBackspace, jegExit } from "./dbcsEditing.js";

export const MSG_NO_ROOM = "挿入する余地がありません";
export const MSG_PROTECTED = "カーソルが保護された区域にあるため入力できません";
export const MSG_SHIFT_POSITION = "この位置（全角の区切り）では操作できません";
export const MSG_UNSUPPORTED = "この種類の欄の編集は未対応です（継続した J・E・G・継続した語送り欄）";
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
  /** E 欄の全角・半角の状態を、空にしても保つ記憶（欄の番号 → 全角か。AID の送信で捨てる） */
  eitherMemory?: Map<number, boolean>;
  /** 全部消した open の E の欄の番号（AID の送信で捨てる） */
  jeErased?: Set<number>;
}

/** 編集 1 回の結果。`value` を `setField` へ渡し、カーソルを `cursor` へ置く。`note` は操作員への一言 */
export type EditOutcome =
  | { ok: true; value: string; cursor: { row: number; col: number }; filled?: boolean; also?: { index: number; value: string }[]; note?: string }
  | { ok: false; note?: string };

const fail = (note?: string): EditOutcome => (note === undefined ? { ok: false } : { ok: false, note });

/** 端末版が編集できる欄か */
export function editable(f: Field): boolean {
  // J・E・G: 継続・語送りは未対応（1 行に収まらない欄は dbcsEditing が知らせる）
  if (isJeg(f)) return f.continued === undefined && f.wordWrap !== true;
  if (f.dbcsType === undefined) return !(f.continued !== undefined && f.wordWrap === true);
  // O 欄: 語送りは未対応（継続した鎖は oChainCells で編集する）
  return f.dbcsType === "open" && f.wordWrap !== true;
}

const isOpen = (f: Field): boolean => f.dbcsType === "open";

/** 語送りの欄か（ACS は DBCS・非表示・継続の欄に掛けない。web-ui `isWrapEdit` と同じ条件） */
const isWrap = (f: Field): boolean => f.wordWrap === true && f.dbcsType === undefined && f.hidden !== true && f.continued === undefined;

/** 継続した（EDTMSK の）SBCS 欄か。区間の並びを 1 つの欄として編集する */
const isContinued = (f: Field): boolean => f.continued !== undefined && f.dbcsType === undefined;

/** 継続した O 欄（鎖）か */
const isOChain = (f: Field): boolean => f.continued !== undefined && f.dbcsType === "open";

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
    const chain = f.continued !== undefined;
    if (chain && cell.dead === true) s += DEAD_MARK;
    // 鎖: 区間の最後の桁の全角の前半・区間の頭の後半は、区間の間で割れた全角の半分
    else if (chain && cell.kind === "dbcs-lead" && i === f.length - 1) s += splitLead(cell.char) ?? cell.char;
    else if (chain && cell.kind === "dbcs-tail" && i === 0) s += SPLIT_TAIL;
    else if (cell.kind === "sbcs" && cell.char === " " && cell.rawByte === undefined) s += "\u0000";
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
  if (isWrap(f)) {
    // 語送りの欄は空きを NUL で持つ（実空白と区別する。core は途中の NUL を DEAD_MARK で運ぶ）
    const chars = [...f.value].map((c) => (isDeadMark(c) ? WRAP_NUL : c)).slice(0, span);
    while (chars.length < span) chars.push(WRAP_NUL);
    return { chars, cursor: Math.min(off, span), insertMode: env.insertMode, pad: WRAP_NUL };
  }
  const st = initEdit(f.value, span, off);
  return { ...st, insertMode: env.insertMode };
}

/** 編集の後に語送りを掛ける（`at` は打った桁・消した桁。最終桁に打ったときは掛けない） */
function wrapAfter(f: Field, st: EditState, at: number, env: EditEnv): EditState {
  const span = st.chars.length;
  if (!isWrap(f) || at >= span - 1) return st;
  const rowEnds = fieldSlices(f, env.cols, env.rows).map((sl) => sl.offset + sl.width - 1);
  const w = wordWrap(st.chars, at, st.cursor, rowEnds, env.cols);
  return w ? { ...st, chars: w.chars, cursor: w.cursor } : st;
}

/** 画面の位置 → 欄内の桁。O 欄は桁がセルの並びと 1 対 1 なので、編集の要素の位置へ直す */
function offsetAt(f: Field, pos: { row: number; col: number }, env: EditEnv): number | undefined {
  return offsetOfPos(f, pos.row, pos.col, env.cols, env.rows);
}

function finish(f: Field, st: EditState, env: EditEnv, filled = false): EditOutcome {
  // 末尾の詰め物だけ落とす。打った空白は中身として残す（O 欄は NUL が空き）
  const raw = editValue(st);
  let value: string;
  if (isWrap(f)) {
    // 末尾の NUL だけ落とす（打った空白は残す）。途中の NUL は core が運ぶセンチネルにする
    const cs = [...raw];
    while (cs.length > 0 && cs[cs.length - 1] === WRAP_NUL) cs.pop();
    value = cs.map((c) => (c === WRAP_NUL ? DEAD_MARK : c)).join("");
  } else value = isOpen(f) ? raw.replace(/\u0000+$/, "") : raw.replace(/ +$/, "");
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

/** 継続欄の並びを 1 つの欄として編集するための寸法（先頭 → 最終。区間ごとの長さと、合成バッファ内の開始位置） */
interface RunGeom {
  run: Field[];
  lens: number[];
  offsets: number[];
  at: number;
}

function runGeom(f: Field, snap: ScreenSnapshot, env: EditEnv): RunGeom {
  const run = continuedRunOf(snap.fields, f);
  const lens = run.map((x) => fieldSpan(x, env.cols, env.rows));
  const offsets: number[] = [];
  let acc = 0;
  for (const n of lens) {
    offsets.push(acc);
    acc += n;
  }
  return { run, lens, offsets, at: Math.max(0, run.findIndex((x) => x.index === f.index)) };
}

const padTo = (cs: readonly string[], n: number): string[] => {
  const out = cs.slice(0, n);
  while (out.length < n) out.push(" ");
  return out;
};

/**
 * 継続欄の並びを合成バッファへつないで `apply` を掛け、区間ごとに割り戻す（web-ui `editAcrossContinued` と同じ手順）。
 * `preferNext` は挿入・打鍵用: 区間の終わりに着いたら次の区間の先頭へ置く。`apply` が undefined（余地なし）なら値を変えない
 */
function acrossRun(
  f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv,
  apply: (s: EditState) => EditState | undefined, preferNext: boolean, noRoom = MSG_NO_ROOM
): EditOutcome & { merged?: number } {
  const g = runGeom(f, snap, env);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail();
  const merged = g.run.flatMap((x, k) => padTo([...x.value], g.lens[k]!));
  const res = apply({ chars: merged, cursor: g.offsets[g.at]! + off, insertMode: env.insertMode });
  if (!res) return fail(noRoom);
  let target = g.run.length - 1;
  for (let k = 0; k < g.run.length; k++) {
    const end = g.offsets[k]! + g.lens[k]!;
    if (preferNext ? res.cursor < end : res.cursor <= end) {
      target = k;
      break;
    }
  }
  const slice = (k: number): string => res.chars.slice(g.offsets[k]!, g.offsets[k]! + g.lens[k]!).join("").replace(/ +$/, "");
  const tf = g.run[target]!;
  const also = g.run.flatMap((x, k) => (x.index === f.index ? [] : [{ index: x.index, value: slice(k) }]));
  const cursor = posOfOffset(tf, Math.min(res.cursor - g.offsets[target]!, g.lens[target]!), env.cols, env.rows);
  return { ok: true, value: slice(g.at), cursor, also, merged: res.cursor };
}

/** 継続した O 欄の操作を鎖全体で行い、区間ごとの値へ割り戻す（web-ui `oChainApply`・`oChainCommit`） */
function chainOp(
  f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv,
  op: (segs: OCell[][], at: ChainPos) => ChainResult
): EditOutcome {
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail();
  const g = runGeom(f, snap, env);
  const segs = g.run.map((x, k) => toCells([...openValue(x, snap)], g.lens[k]!));
  const r = op(segs, { seg: g.at, c: off });
  if ("error" in r) return fail(r.error === 0x12 ? MSG_NO_ROOM : r.error === 0x05 ? MSG_PROTECTED : MSG_SHIFT_POSITION);
  if ("noop" in r) return fail();
  const values = r.segs.map((cells) => fromCells(cells).join("").replace(/\u0000+$/, ""));
  const target = g.run[r.cursor.seg]!;
  const also = g.run.flatMap((x, k) => (x.index === f.index ? [] : [{ index: x.index, value: values[k]! }]));
  const cursor = posOfOffset(target, Math.min(r.cursor.c, g.lens[r.cursor.seg]!), env.cols, env.rows);
  return { ok: true, value: values[g.at]!, cursor, also, ...(r.warn !== undefined ? { note: MSG_SHIFT_POSITION } : {}) };
}

/** 1 文字を打つ */
export function typeInto(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, raw: string, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail("ここには入力できません");
  if (isJeg(f)) return jegType(f, snap, pos, raw, env, { noRoom: MSG_NO_ROOM, byReason: (w) => MSG_BY_REASON[w] });
  const ch = inputChar(raw, f, env);
  const why = rejectReason(f, ch, { sbcsOnly: env.sbcsOnly });
  if (why) return fail(MSG_BY_REASON[why]);
  const span = fieldSpan(f, env.cols, env.rows);

  if (isContinued(f)) {
    // 並び全体を 1 つの欄として数え、押し出す（実機の ACS。web-ui `ScreenGrid` の継続欄の枝）
    const total = runGeom(f, snap, env).lens.reduce((a, b) => a + b, 0);
    const r = acrossRun(
      f, snap, pos, env,
      (s) => (env.insertMode ? insertChar(s, ch, s.chars.length - 1) : typeChar(s, ch)),
      true
    );
    if (!r.ok) return r;
    // 並びの最終桁に打った：満杯
    const { merged, ...out } = r;
    return merged !== undefined && merged >= total ? { ...out, filled: true } : out;
  }
  if (isOChain(f)) return chainOp(f, snap, pos, env, (segs, at) => (env.insertMode ? chainInsert(segs, at, ch) : chainOverwrite(segs, at, ch)));
  const st = stateOf(f, snap, off, env);

  if (isOpen(f)) {
    const r = oApply(f, st, env, (cells, c) => (env.insertMode ? oInsert(cells, c, ch) : oOverwrite(cells, c, ch)));
    return isOutcome(r) ? r : finish(f, r, env);
  }
  if (env.insertMode) {
    const t = insertChar(st, ch, lastTypeable(f, span));
    return t ? finish(f, wrapAfter(f, t, st.cursor, env), env) : fail(MSG_NO_ROOM);
  }
  if (isSignPosition(f, st.cursor, span)) return fail(MSG_BY_REASON["sign-position"]);
  const t = typeChar(st, ch);
  // 最終桁（符号付き数値は符号桁の手前）に打った：満杯。Field Exit が必須の欄は留まる
  const filled = st.cursor === lastTypeable(f, span);
  return finish(f, wrapAfter(f, t, st.cursor, env), env, filled);
}

/** Delete */
export function deleteAt(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail();
  if (isJeg(f)) return jegDelete(f, snap, pos, env);
  if (isContinued(f)) return acrossRun(f, snap, pos, env, del, false);
  if (isOChain(f)) return chainOp(f, snap, pos, env, (segs, at) => chainDelete(segs, at));
  const st = stateOf(f, snap, off, env);
  if (isOpen(f)) {
    const r = oApply(f, st, env, (cells, c) => oDel(cells, c));
    return isOutcome(r) ? r : finish(f, r, env);
  }
  return finish(f, wrapAfter(f, del(st), st.cursor, env), env);
}

/** Backspace（並び・欄の先頭では呼び出し側が前の桁へ動かす） */
export function backspaceAt(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail();
  if (isJeg(f)) return jegBackspace(f, snap, pos, env);
  if (isContinued(f)) {
    // 並びの先頭（先頭区間の桁 0）まで戻っていれば戻れない（0005）
    const g = runGeom(f, snap, env);
    if (g.offsets[g.at]! + off === 0) return fail(MSG_PROTECTED);
    return acrossRun(f, snap, pos, env, backspace, false);
  }
  if (isOChain(f)) return chainOp(f, snap, pos, env, (segs, at) => chainBackspace(segs, at));
  if (off === 0) return fail();
  const st = stateOf(f, snap, off, env);
  if (isOpen(f)) {
    const r = oApply(f, st, env, (cells, c) => oBackspace(cells, c));
    return isOutcome(r) ? r : finish(f, r, env);
  }
  return finish(f, wrapAfter(f, backspace(st), st.cursor - 1, env), env);
}

/** Field Exit: カーソル以降を消し、右寄せ（ADJUST）を掛ける。O 欄はセルの並びを閉じる。継続欄は続く区間も空にする */
export function exitAt(f: Field, snap: ScreenSnapshot, pos: { row: number; col: number }, env: EditEnv): EditOutcome {
  if (!editable(f)) return fail(MSG_UNSUPPORTED);
  const off = offsetAt(f, pos, env);
  if (off === undefined) return fail();
  if (isJeg(f)) return jegExit(f, snap, pos, env);
  const st = stateOf(f, snap, off, env);
  if (isOpen(f)) {
    const span = fieldSpan(f, env.cols, env.rows);
    const cells = oEraseToEnd(toCells(st.chars, span), cellOfEntry(st.chars, st.cursor));
    const done = finish(f, { ...st, chars: fromCells(cells), cursor: st.cursor }, env);
    if (!done.ok || !isOChain(f)) return done;
    // 続く区間は全桁を空きにする（web-ui `fillFollowingSegments`）
    const g = runGeom(f, snap, env);
    return { ...done, also: g.run.slice(g.at + 1).map((x) => ({ index: x.index, value: "" })) };
  }
  const done = finish(f, fieldExit(st, f), env);
  if (!done.ok || !isContinued(f)) return done;
  // 続く区間は全桁を消す（実機の ACS のコア: `processEraseEOF` が続く区間まで消す。web-ui `fillFollowingSegments`）
  const g = runGeom(f, snap, env);
  const also = g.run.slice(g.at + 1).map((x) => ({ index: x.index, value: "" }));
  return { ...done, also };
}

export { isWideForDbcs };
