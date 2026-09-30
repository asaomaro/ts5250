/**
 * **O（DBCS open）欄のセルの編集**——ACS の O 欄の規則をセルの並びの上で行う（`20260928-o-field-cells`）。
 *
 * ACS の O 欄は SO・SI・全角（前半と後半の 2 セル）・半角（空と空白を含む）をセルとして直接書き換える
 * （`PS5250.inputChar` / `insertChar` / `reserveRoomForInsert` / `processDeleteChar` / `processBackspace` / `eraseToEOF_Work`）。
 * 論理値（SO/SI 無し）から SO/SI を付け直す形では、挿入で分かれた並び・全角を消した後の空の SO/SI・SO や SI の上のカーソルを表せない。
 *
 * 編集の値（`EditState.chars`）は、SO/SI を印（`SO_MARK` / `SI_MARK`）として持つ並びで、全角は 1 要素（2 桁）。ここでは操作のときだけ
 * セル（全角は前半・後半の 2 セル）に展開し、ACS の表どおりに書き換えて戻す。規則は原典の読み（research F1〜F6）と、実機の ACS のコアで
 * 打鍵したバイト列（DSM の OEDIT・`scripts/acs-probe/o-field-edit.txt`）で確かめた。表の中の「黙って何もしない」は ACS の表のどの行にも
 * 当たらない形で、値もカーソルも変えずエラーも出さない（`noop`）
 */
import { SO_MARK, SI_MARK, DEAD_MARK, hasShiftMarks, isDeadMark, isWideForDbcs } from "./fieldValidate.js";
import { splitLead, isSplitLead, splitLeadChar, SPLIT_TAIL, isSplitTail } from "@ts5250/tn5250/browser";

export type OCellKind = "sb" | "so" | "si" | "lead" | "tail";
/**
 * 1 桁ぶんのセル。`sb` の空きは半角空白（ACS の NUL と同じに扱う）。`lead` が全角の字を持ち、`tail` は空。
 * `dead` は継続した O 欄の死んだ桁（`sb` の空き。`DEAD_MARK`）——種類は半角なので、継続でない O 欄の表では空きの半角と同じに見える（ACS も DBCSPlane 8 は S に分類する）
 */
export interface OCell {
  k: OCellKind;
  ch: string;
  dead?: true;
  /**
   * **空きの桁（NUL。ホストが何も書かなかった桁・消して空にした桁）**。ACS は空き（0x00）と空白（0x40）を区別し、詰め直しでは空白を**中身**として押し出し、
   * READ MDT ALT は途中の空きを 00 のまま送り、末尾の空白は送る（実機の ACS のコア `scripts/acs-probe/cont-o-paste.txt` の P4・P7・P8、`space-typed.txt`）。
   * 継続した O 欄の鎖は `20260930-cont-o-nul`、継続でない O 欄は `20260930-nul-typed-space` で持たせた。値の文字は U+0000（`fromCells`）
   */
  nul?: true;
}

/** 空きの桁（NUL）のセル */
export const nulCell = (): OCell => ({ k: "sb", ch: " ", nul: true });

/** 操作の結果。`cursor` はセルの桁（0 起点）。`error` は ACS のエラー（0x05・0x12・0x65）。`noop` は黙って何もしない */
export type OResult = { cells: OCell[]; cursor: number } | { error: 0x05 | 0x12 | 0x65 } | { noop: true };


/**
 * 編集の値をセルへ展開する。印があればその位置を SO/SI とし（明示の並び）、無ければ全角の連なりを SO…SI で挟む（暗黙の並び——印を持たない古い値）。
 * 桁が `length` に満たなければ空きで埋め、越えれば切る
 */
export function toCells(chars: readonly string[], length: number): OCell[] {
  const out: OCell[] = [];
  if (hasShiftMarks(chars)) {
    for (const ch of chars) {
      if (ch === SO_MARK) out.push({ k: "so", ch: "" });
      else if (ch === SI_MARK) out.push({ k: "si", ch: "" });
      else if (isDeadMark(ch)) out.push({ k: "sb", ch: " ", dead: true });
      else if (ch === "\u0000") out.push(nulCell());
      // 区間の間で割れた全角の半分（継続した O 欄。前半は字を運ぶ 1 セル・後半は目印の 1 セル）
      else if (isSplitLead(ch)) out.push({ k: "lead", ch: splitLeadChar(ch) });
      else if (isSplitTail(ch)) out.push({ k: "tail", ch: "" });
      else if (isWideForDbcs(ch)) out.push({ k: "lead", ch }, { k: "tail", ch: "" });
      else out.push({ k: "sb", ch });
    }
  } else {
    let inRun = false;
    for (const ch of chars) {
      const wide = isWideForDbcs(ch);
      if (wide && !inRun) out.push({ k: "so", ch: "" });
      if (!wide && inRun) out.push({ k: "si", ch: "" });
      inRun = wide;
      if (wide) out.push({ k: "lead", ch }, { k: "tail", ch: "" });
      else out.push(ch === "\u0000" ? nulCell() : { k: "sb", ch });
    }
    if (inRun) out.push({ k: "si", ch: "" });
  }
  while (out.length < length) out.push(nulCell());
  return out.slice(0, length);
}

/**
 * セルを編集の値へ戻す。SO/SI は印に、全角は前半の字（後半は捨てる）。**前半・後半の組が崩れたセル**（挿入の押し出しで全角空白の組が割れたときなど。
 * ACS の原典どおりの結果）は空きにする——字として表せないため（ACS は割れたままのバイトを持つ。差として記録）
 */
export function fromCells(cells: readonly OCell[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    if (c.k === "so") out.push(SO_MARK);
    else if (c.k === "si") out.push(SI_MARK);
    else if (c.k === "lead") {
      if (cells[i + 1]?.k === "tail") {
        out.push(c.ch);
        i++;
      } else out.push((i === cells.length - 1 && c.ch !== "" ? splitLead(c.ch) : undefined) ?? " "); // 区間の最後の桁の前半は、次の区間へ割れた全角の前半
    } else if (c.k === "tail") out.push(i === 0 ? SPLIT_TAIL : " "); // 区間の頭の後半は、前の区間から割れてきた全角の後半
    else out.push(c.dead ? DEAD_MARK : c.nul ? "\u0000" : c.ch);
  }
  return out;
}

/**
 * 編集の値の要素 `index` のセルの桁（全角は前半の桁。要素の数なら値の終わり）。印は 1 桁、全角は 2 桁。
 * **印の無い値（暗黙の並び）では、`toCells` が足す SO/SI の桁も数える**——並びの最初の全角は SO の次、並びの直後の半角は SI の次。
 * 値の終わりで並びが閉じていなければ、終わりは SI の桁（`dbcsViewLayout` の末尾のキャレットが SI の手前に止まるのと同じ）
 */
export function cellOfEntry(chars: readonly string[], index: number): number {
  if (hasShiftMarks(chars)) {
    let col = 0;
    for (let i = 0; i < index && i < chars.length; i++) col += isWideForDbcs(chars[i]!) ? 2 : 1;
    return col;
  }
  let col = 0;
  let inRun = false;
  for (let i = 0; i < chars.length; i++) {
    const wide = isWideForDbcs(chars[i]!);
    if (wide !== inRun) col++; // 暗黙の SO（並びの始まり）か SI（並びの終わり）
    inRun = wide;
    if (i === index) return col;
    col += wide ? 2 : 1;
  }
  return col;
}

/** セルの桁 `col` を含む要素の添字（全角の後半は前半の要素へ。欄の終わりは要素の数） */
export function entryOfCell(chars: readonly string[], col: number): number {
  let acc = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = isWideForDbcs(chars[i]!) ? 2 : 1;
    if (col < acc + w) return i;
    acc += w;
  }
  return chars.length;
}

// ---- セルの種類（ACS `ECLPS.IsSOChar` ほか。`n === cells.length` は欄の次の桁＝属性） ----
const isS = (cells: readonly OCell[], n: number): boolean => cells[n]?.k === "sb";
const isO = (cells: readonly OCell[], n: number): boolean => cells[n]?.k === "so";
const isI = (cells: readonly OCell[], n: number): boolean => cells[n]?.k === "si";
const isT = (cells: readonly OCell[], n: number): boolean => cells[n]?.k === "tail";
const isEnd = (cells: readonly OCell[], n: number): boolean => n === cells.length;
/** その桁から欄の終わりへ、SO より先に SI に会うか（ACS `IsInDBCSSubfield`。SO/SI の桁そのものは偽） */
function inRun(cells: readonly OCell[], n: number): boolean {
  if (isO(cells, n) || isI(cells, n)) return false;
  for (let i = n; i < cells.length; i++) {
    if (cells[i]!.k === "so") return false;
    if (cells[i]!.k === "si") return true;
  }
  return false;
}
/** 並びの中の全角（前半・後半とも。ACS `IsDBC00`） */
const isD = (cells: readonly OCell[], n: number): boolean => (cells[n]?.k === "lead" || cells[n]?.k === "tail") && inRun(cells, n);

/**
 * 挿入の表で見るセルの種類（ACS `insertChar` の判定の順: 半角 → SO → SI → 並びの中の全角）。どれでもない（並びの外の全角・欄の外）は `undefined`。
 * 継続した O 欄の挿入（`oChainCells.ts`）も同じ表を使う
 */
export function insertClassOf(cells: readonly OCell[], c: number): "S" | "O" | "I" | "D" | undefined {
  if (isS(cells, c)) return "S";
  if (isO(cells, c)) return "O";
  if (isI(cells, c)) return "I";
  if (isD(cells, c)) return "D";
  return undefined;
}

/** 書き込みの 1 手（ACS の `putSO` / `putSI` / `putDBChar` / `putSBChar`）。`at` はカーソルからの相対 */
type Op = { at: number; w: "so" | "si" | "db" | "sp" | "ch" };

function apply(cells: readonly OCell[], c: number, ops: readonly Op[], ch: string): OCell[] {
  const out = cells.map((x) => ({ ...x }));
  const put = (n: number, cell: OCell): void => {
    if (n >= 0 && n < out.length) out[n] = cell;
  };
  for (const op of ops) {
    const n = c + op.at;
    if (op.w === "so") put(n, { k: "so", ch: "" });
    else if (op.w === "si") put(n, { k: "si", ch: "" });
    else if (op.w === "sp") put(n, { k: "sb", ch: " " });
    else if (op.w === "ch") put(n, { k: "sb", ch });
    else {
      put(n, { k: "lead", ch });
      put(n + 1, { k: "tail", ch: "" });
    }
  }
  return out;
}

/** 進んだ先が欄の最後のセルの SI なら、さらに 1 つ進む（ACS: `IsSIChar(c+adv) && IsFA(c+adv+1)`——欄の次の桁は属性とみなす） */
function skipClosingSi(cells: readonly OCell[], c: number, adv: number): number {
  return isI(cells, c + adv) && c + adv === cells.length - 1 ? adv + 1 : adv;
}

const done = (cells: OCell[], c: number, adv: number): OResult => ({ cells, cursor: c + skipClosingSi(cells, c, adv) });

/**
 * **上書きで 1 字**（ACS `PS5250.inputChar` の O 欄の枝。research F2）。`c` はカーソルのセル
 */
export function overwrite(cells: readonly OCell[], c: number, ch: string): OResult {
  const wide = isWideForDbcs(ch);
  const run = (ops: Op[], adv: number): OResult => done(apply(cells, c, ops, ch), c, adv);
  const SO_DB_SI: Op[] = [{ at: 0, w: "so" }, { at: 1, w: "db" }, { at: 3, w: "si" }];
  /** 後ろの `O` の次（`k`）が SI なら空白、並びの中の全角なら空白＋SO（次の並びの最初の字を潰す）。どちらでもなければ何もしない */
  const tailFix = (base: Op[], k: number, adv: number): OResult => {
    if (isI(cells, c + k)) return run([...base, { at: k, w: "sp" }], adv);
    if (isD(cells, c + k)) return run([...base, { at: k, w: "sp" }, { at: k + 1, w: "so" }], adv);
    return { noop: true };
  };
  if (wide) {
    if (isS(cells, c)) {
      if (isS(cells, c + 1)) {
        if (isS(cells, c + 2)) {
          if (isS(cells, c + 3)) return run(SO_DB_SI, 3);
          if (isO(cells, c + 3)) return tailFix(SO_DB_SI, 4, 3);
          if (isEnd(cells, c + 3)) return { error: 0x05 };
          return { noop: true };
        }
        if (isO(cells, c + 2)) return run([{ at: 0, w: "so" }, { at: 1, w: "db" }], 3);
        if (isEnd(cells, c + 2)) return { error: 0x05 };
        return { noop: true };
      }
      if (isO(cells, c + 1)) {
        if (isI(cells, c + 2)) {
          if (isS(cells, c + 3)) return run(SO_DB_SI, 3);
          if (isO(cells, c + 3)) return tailFix(SO_DB_SI, 4, 3);
          if (isEnd(cells, c + 3)) return { error: 0x05 };
          return { noop: true };
        }
        // `S O D`: 原典は c+3 ではなく c+4 を見る（research F2 の注）
        if (isD(cells, c + 2)) return tailFix(SO_DB_SI, 4, 3);
        return { noop: true };
      }
      if (isEnd(cells, c + 1)) return { error: 0x05 };
      return { noop: true };
    }
    if (isO(cells, c)) {
      if (isI(cells, c + 1)) {
        if (isS(cells, c + 2)) {
          if (isS(cells, c + 3)) return run(SO_DB_SI, 3);
          if (isO(cells, c + 3)) return tailFix(SO_DB_SI, 4, 3);
          if (isEnd(cells, c + 3)) return { error: 0x05 };
          return { noop: true };
        }
        if (isO(cells, c + 2)) return run([{ at: 0, w: "so" }, { at: 1, w: "db" }], 3);
        if (isEnd(cells, c + 2)) return { error: 0x05 };
        return { noop: true };
      }
      if (isD(cells, c + 1)) return run([{ at: 0, w: "so" }, { at: 1, w: "db" }], 3);
      return { noop: true };
    }
    if (isI(cells, c)) {
      if (isS(cells, c + 1)) {
        const DB_SI: Op[] = [{ at: 0, w: "db" }, { at: 2, w: "si" }];
        if (isS(cells, c + 2)) return run(DB_SI, 2);
        if (isO(cells, c + 2)) return tailFix(DB_SI, 3, 2);
        if (isEnd(cells, c + 2)) return { error: 0x05 };
        return { noop: true };
      }
      if (isO(cells, c + 1)) return run([{ at: 0, w: "db" }], 2);
      if (isEnd(cells, c + 1)) return { error: 0x05 };
      return { noop: true };
    }
    if (isD(cells, c)) return run([{ at: 0, w: "db" }], 2);
    return { noop: true };
  }
  // 半角（原典は S → 後半 → SO → SI → 並びの中の全角の順に見る）
  if (isS(cells, c)) return run([{ at: 0, w: "ch" }], 1);
  if (isT(cells, c)) return run([{ at: 0, w: "ch" }, { at: -1, w: "sp" }], 1);
  if (isO(cells, c)) {
    if (isI(cells, c + 1)) return run([{ at: 0, w: "ch" }, { at: 1, w: "sp" }], 1);
    if (isD(cells, c + 1)) return run([{ at: 0, w: "ch" }, { at: 1, w: "sp" }, { at: 2, w: "so" }], 1);
    return { noop: true };
  }
  if (isI(cells, c)) {
    if (isS(cells, c + 1)) return run([{ at: 0, w: "si" }, { at: 1, w: "ch" }], 2);
    if (isO(cells, c + 1)) {
      const base: Op[] = [{ at: 0, w: "si" }, { at: 1, w: "ch" }];
      if (isI(cells, c + 2)) return run([...base, { at: 2, w: "sp" }], 2);
      if (isD(cells, c + 2)) return run([...base, { at: 2, w: "sp" }, { at: 3, w: "so" }], 2);
      return { noop: true };
    }
    if (isEnd(cells, c + 1)) return { error: 0x65 };
    return { noop: true };
  }
  if (isD(cells, c)) {
    const base: Op[] = [{ at: 0, w: "si" }, { at: 1, w: "ch" }];
    if (isI(cells, c + 2)) return run([...base, { at: 2, w: "sp" }], 2);
    if (isD(cells, c + 2)) return run([...base, { at: 2, w: "sp" }, { at: 3, w: "so" }], 2);
    return { noop: true };
  }
  return { noop: true };
}

/** 挿入の空き（ACS `reserveRoomForInsert`）: 欄の終わりからカーソルまで、NUL・空白・全角空白が続く桁数（SO/SI は空きにならない） */
function freeCells(cells: readonly OCell[], c: number): number {
  let n = 0;
  for (let i = cells.length - 1; i >= c; i--) {
    const x = cells[i]!;
    const free = (x.k === "sb" && (x.ch === " " || x.ch === "\u0000" || x.ch === "\u3000")) || (x.k === "lead" && x.ch === "\u3000") || (x.k === "tail" && cells[i - 1]?.ch === "\u3000");
    if (!free) break;
    n++;
  }
  return n;
}

/**
 * **挿入で 1 字**（ACS `PS5250.insertChar` の表と `reserveRoomForInsert`。research F3）。
 * 全角は半角の上で SO 字 SI（4 桁）、SO の上で SO の直後（2 桁）、SI の上・並びの中で字の前（2 桁）。半角は半角・SO の上で 1 桁、SI の上で SI の後ろ（1 桁・進み 2）、
 * 並びの中で SI 字 SO（3 桁）。カーソルが最終のセルなら・空きが足りなければ 0012（`allowLastCell` は選択の置き換え——最終のセルの判定だけ外す）
 */
export function insert(cells: readonly OCell[], c: number, ch: string, opts: { allowLastCell?: boolean } = {}): OResult {
  const wide = isWideForDbcs(ch);
  let adv: number;
  let room: number;
  let ops: Op[];
  if (wide) {
    if (isS(cells, c)) [adv, room, ops] = [3, 4, [{ at: 0, w: "so" }, { at: 1, w: "db" }, { at: 3, w: "si" }]];
    else if (isO(cells, c)) [adv, room, ops] = [3, 2, [{ at: 0, w: "so" }, { at: 1, w: "db" }]];
    else if (isI(cells, c) || isD(cells, c)) [adv, room, ops] = [2, 2, [{ at: 0, w: "db" }]];
    else return { error: 0x12 };
  } else if (isS(cells, c) || isO(cells, c)) [adv, room, ops] = [1, 1, [{ at: 0, w: "ch" }]];
  else if (isI(cells, c)) [adv, room, ops] = [2, 1, [{ at: 0, w: "si" }, { at: 1, w: "ch" }]];
  else if (isD(cells, c)) [adv, room, ops] = [2, 3, [{ at: 0, w: "si" }, { at: 1, w: "ch" }, { at: 2, w: "so" }]];
  else return { error: 0x12 };
  // 選択の置き換え（当 PJ の操作。ACS の GUI は未測定）は消した跡を埋めるだけなので、最終のセルの判定を掛けない（SBCS・DBCS 欄と同じ決め）。空きは数える
  if ((c >= cells.length - 1 && !opts.allowLastCell) || c >= cells.length || freeCells(cells, c) < room) return { error: 0x12 };
  // 空きの分だけ右へずらす（末尾の空きが落ちる）。そのうえでカーソルから書く
  const shifted = [...cells.slice(0, c), ...Array.from({ length: room }, () => nulCell()), ...cells.slice(c, cells.length - room)];
  return done(apply(shifted, c, ops, ch), c, adv);
}

/**
 * **Delete**（ACS `processDeleteChar`。research F4）: SO+SI・SI+SO は 2 桁、単独の SO・SI は 0065、全角は 2 桁、半角は 1 桁を消し、後ろを詰めて末尾を空きにする。
 * 全角の並びの最後の字を消しても SO/SI は残る（空の組）
 */
export function del(cells: readonly OCell[], c: number): OResult {
  if (c >= cells.length) return { error: 0x05 };
  let k: number;
  const x = cells[c]!.k;
  if (x === "so") k = isI(cells, c + 1) ? 2 : 0;
  else if (x === "si") k = isO(cells, c + 1) ? 2 : 0;
  else if (x === "lead" || x === "tail") k = 2;
  else k = 1;
  if (k === 0) return { error: 0x65 };
  const out = [...cells.slice(0, c), ...cells.slice(c + k)].map((y) => ({ ...y }));
  while (out.length < cells.length) out.push(nulCell());
  return { cells: out, cursor: c };
}

/**
 * **Backspace**（ACS `processBackspace`。research F4）: 直前が全角なら 2 桁、今と直前が SO/SI なら直前から、直前が SO/SI で 2 つ前も SO/SI ならその組、
 * 直前が単独の SO/SI なら 0065。欄の先頭は 0005（呼び出し側が先に止める——`backspace-dbcs-field-start.txt` の実測）
 */
export function backspace(cells: readonly OCell[], c: number): OResult {
  const n = backspaceTarget(cells, c);
  return typeof n === "number" ? del(cells, n) : n;
}

/** Backspace が消す桁（`backspace` の判定だけ。継続した O 欄は区間の頭だけ別の規則なので、区間の中はこれを使う——`oChainCells.ts`） */
export function backspaceTarget(cells: readonly OCell[], c: number): number | { error: 0x05 | 0x65 } {
  if (c <= 0) return { error: 0x05 };
  const sosi = (n: number): boolean => isO(cells, n) || isI(cells, n);
  let n: number;
  if (sosi(c) && sosi(c - 1)) n = c - 1;
  else if (cells[c - 1]?.k === "lead" || cells[c - 1]?.k === "tail") n = c - 2;
  else if (sosi(c - 1)) {
    if (c - 1 > 0 && sosi(c - 2)) n = c - 2;
    else return { error: 0x65 };
  } else n = c - 1;
  if (n < 0) return { error: 0x05 };
  return n;
}

/**
 * **Erase EOF・Field Exit・Field+ の消去**（ACS `eraseToEOF_Work`。research F5）: カーソルから欄の終わりを空きにし、カーソルが SI の上か並びの中なら、
 * カーソルの桁に SI を置いて並びを閉じる（SO の上からなら並びごと消える）
 */
export function eraseToEnd(cells: readonly OCell[], c: number, fill: OCell = nulCell()): OCell[] {
  const close = isI(cells, c) || inRun(cells, c);
  const out = cells.map((x, i) => (i >= c ? { ...fill } : { ...x }));
  if (close && c < out.length) out[c] = { k: "si", ch: "" };
  return out;
}
