/**
 * **継続した O（DBCS open）欄の編集**——鎖（FCW 0x86nn の区間の並び）全体を 1 つの欄として、ACS と同じ手順でセルを書き換える（`20260928-cont-o-cells`）。
 *
 * 継続でない O 欄（`oFieldCells.ts`）と違い、ACS は継続した O 欄で次のように振る舞う（原典 `PS5250.insertChar` → `processCharWithDBCSOpenContField`・
 * `mergeDBCSString`・`checkWordsFitDBCSOpenContField`、`inputChar` の区間の終わりの枝と `insertDbDead`、`processDeleteChar` → `deleteCharInContField`、
 * `processBackspace`、`FFT5250.getFieldContents`）:
 * - **挿入**はカーソルから鎖の終わりまでを作り直す。カーソルの桁の操作列（継続でない O 欄の挿入の表と同じ）を先に出し、後ろのセルを続け（死んだ桁は捨てる）、
 *   SI の直後の SO を組ごと取り除いてから、区間ごとに詰め直す。全角の並びは区間をまたがない——区間の終わりで SI で閉じ、次の区間で SO から開き直す。
 *   SO が区間の最後の 3 桁以内に来たら並びごと次の区間へ送り、残りを**死んだ桁**にする。末尾の空き（NUL）だけが余地で、足りなければ 0012
 * - **上書き**は区間の中の表（継続でない O 欄と同じ）で、区間の終わりで足りなければカーソルの次から区間の終わりを死んだ桁にして、次の区間の頭で打ち直す
 * - **Delete** は鎖全体を左へ詰めてから、挿入と同じ詰め直しを操作無しで回す。**Backspace** は区間の頭なら前の区間の最後の桁を消す
 *
 * 実機の ACS のコアで 12 通りを打鍵し、ホストが受け取ったバイト列とカーソルがこの手順どおりだった（DSM の CONTOX・`scripts/acs-probe/cont-o-edit.txt`）。
 * Erase EOF・Field Exit は区間ごとの消去（`oFieldCells.eraseToEnd` と続く区間の全消去）で足りるのでここには無い。
 * 語送り（FCW 0x8680）の欄の語送りの段（`processWordWrap`）は扱わない（未測定）
 */
import { isWideForDbcs } from "./fieldValidate.js";
import { backspaceTarget, insertClassOf, overwrite, type OCell, type OCellKind } from "./oFieldCells.js";

/** 鎖の中の位置（区間の番号と、その区間のセルの桁。どちらも 0 起点） */
export interface ChainPos {
  seg: number;
  c: number;
}

/** 鎖の操作の結果（`OResult` の鎖版）。`segs` は区間ごとのセル */
export type ChainResult = { segs: OCell[][]; cursor: ChainPos } | { error: 0x05 | 0x12 | 0x65 } | { noop: true };

const empty = (): OCell => ({ k: "sb", ch: " " });
const dead = (): OCell => ({ k: "sb", ch: " ", dead: true });
const copy = (segs: readonly (readonly OCell[])[]): OCell[][] => segs.map((s) => s.map((x) => ({ ...x })));

/** 詰め直しの 1 バイトぶん（ACS の作り直したバッファの 1 要素）。`mark` はカーソルを決めるための印 */
interface Tok {
  k: OCellKind;
  ch: string;
  mark?: true;
}

const isFree = (t: Tok): boolean => t.k === "sb" && t.ch === " ";

/**
 * **カーソルから鎖の終わりまでを作り直して詰める**（ACS `processCharWithDBCSOpenContField` と `checkWordsFitDBCSOpenContField` の手順）。
 * 収まらなければ `undefined`（ACS は試し書きで判定してから書く——収まらなければ何も変えない）。`markAt` は印のトークンが着いたセル
 */
function reflow(segs: readonly (readonly OCell[])[], pos: ChainPos, ops: readonly Tok[]): { segs: OCell[][]; markAt?: ChainPos } | undefined {
  // 1. 作り直すバッファ: 操作列＋カーソルから鎖の終わりのセル（死んだ桁は捨てる。空き・空白は普通のバイトとして残す）
  const rest: Tok[] = [];
  for (let s = pos.seg; s < segs.length; s++) {
    const cells = segs[s]!;
    for (let i = s === pos.seg ? pos.c : 0; i < cells.length; i++) {
      const x = cells[i]!;
      if (!x.dead) rest.push({ k: x.k, ch: x.ch });
    }
  }
  // 操作列の先頭が SO でカーソルのセルが SO なら（SI と SI も）、既存のその 1 つを食う（二重にしない）
  const first = segs[pos.seg]![pos.c];
  if (ops.length > 0 && first !== undefined && !first.dead && (first.k === "so" || first.k === "si") && ops[0]!.k === first.k) rest.shift();
  const buf: Tok[] = [...ops, ...rest];
  // 2. SI の直後の SO を組ごと取り除く（区間をまたいで割れていた並びを 1 つに繋ぐ。ACS `mergeDBCSString`）
  for (let i = 0; i + 1 < buf.length; ) {
    // 取り除いたら 1 つ戻って見直す（`SI SI SO SO` の外側の組も繋ぐ——ACS は頭から探し直す）
    if (buf[i]!.k === "si" && buf[i + 1]!.k === "so") {
      buf.splice(i, 2);
      i = Math.max(0, i - 1);
    } else i++;
  }
  // 3. 中身の長さ（末尾の空きだけが余地）と余地（カーソルから区間の終わり＋後続の区間の全長。死んだ桁も数える）
  let len = buf.length;
  while (len > 0 && isFree(buf[len - 1]!)) len--;
  let room = segs[pos.seg]!.length - pos.c;
  for (let s = pos.seg + 1; s < segs.length; s++) room += segs[s]!.length;
  if (room < len) return undefined;
  // 4. カーソルから区間の終わり・後続の区間を空にしてから、区間ごとに書く
  const out = copy(segs);
  for (let s = pos.seg; s < out.length; s++) {
    const cells = out[s]!;
    for (let i = s === pos.seg ? pos.c : 0; i < cells.length; i++) cells[i] = empty();
  }
  let idx = 0;
  let carrySO = false;
  let markAt: ChainPos | undefined;
  for (let s = pos.seg; s < out.length && idx < len; s++) {
    const cells = out[s]!;
    const start = s === pos.seg ? pos.c : 0;
    let base = start;
    // 前の区間で閉じた並びは、この区間の頭の SO から開き直す（SO が 1 桁を取る）
    if (carrySO) {
      cells[base++] = { k: "so", ch: "" };
      carrySO = false;
    }
    const budget = Math.min(len - idx, cells.length - base);
    for (let k = 0; k < budget; k++) {
      const t = buf[idx]!;
      const left = budget - k;
      const at = base + k;
      const put = (n: number, cell: OCell): void => {
        cells[n] = cell;
      };
      const take = (): void => {
        put(at, { k: t.k, ch: t.ch });
        if (t.mark) markAt = { seg: s, c: at };
        idx++;
      };
      if (t.k === "so") {
        // 区間の最後の 3 桁以内に並びを始めない: 残りを死んだ桁にして SO ごと次の区間へ
        if (left <= 3) {
          for (let n = at; n < base + budget; n++) put(n, dead());
          break;
        }
        take();
      } else if (t.k === "lead" && left === 2) {
        // 後半が区間の最後の桁に来て SI の桁が無い: ここで閉じて（SI＋死んだ桁）、字は次の区間へ
        put(at, { k: "si", ch: "" });
        put(at + 1, dead());
        carrySO = true;
        break;
      } else if (t.k === "lead" && left === 1) {
        // 前半が区間の最後の桁に来る（SI の上の全角で、SI が区間の最後の桁のとき）。ACS は前半をここに、後半を次の区間の頭に書き、
        // 並びを閉じない（実機: `…4488 44 | 81 4484 0f…`・画面は崩れる。`scripts/acs-probe/cont-o-last-lead.txt`）。
        // 当 PJ の値は 1 字を区間の間で割って持てないので 0012 で止める（既知の差。台帳）
        return undefined;
      } else if (t.k === "tail" && left === 3 && buf[idx + 1]?.k !== "si") {
        take();
        put(at + 1, { k: "si", ch: "" });
        put(at + 2, dead());
        carrySO = true;
        break;
      } else if (t.k === "tail" && left === 2 && buf[idx + 1]?.k !== "si") {
        take();
        put(at + 1, { k: "si", ch: "" });
        carrySO = true;
        break;
      } else take();
    }
  }
  if (idx < len) return undefined; // 死んだ桁の分だけ溢れた（ACS の試し書きが偽）
  return markAt === undefined ? { segs: out } : { segs: out, markAt };
}

/** 入れた字の次のセル。そこが区間の最後のセルの SI なら飛ばし、区間の外なら次の区間の頭へ（ACS: adv と `IsSIChar(c+adv) && IsFA(c+adv+1)`・区間の終わりで次の区間へ） */
function afterMark(segs: readonly (readonly OCell[])[], at: ChainPos): ChainPos {
  const cells = segs[at.seg]!;
  let c = at.c + 1;
  if (c === cells.length - 1 && cells[c]!.k === "si") c++;
  if (c >= cells.length && at.seg + 1 < segs.length) return { seg: at.seg + 1, c: 0 };
  return { seg: at.seg, c };
}

/**
 * **挿入で 1 字**（ACS `insertChar` の操作列 → `processCharWithDBCSOpenContField`）。操作列は継続でない O 欄の挿入の表と同じ:
 * 全角は 半角の上 SO 字 SI・SO の上 SO 字・SI の上と並びの中 字、半角は 半角と SO の上 字・SI の上 SI 字・並びの中 SI 字 SO。表に無い位置と、収まらないときは 0012。
 * 継続でない O 欄と違い、区間の最後のセルでも入る（ACS の継続した O 欄は余地だけを見る）
 */
export function chainInsert(segs: readonly (readonly OCell[])[], pos: ChainPos, ch: string): ChainResult {
  const cells = segs[pos.seg];
  if (cells === undefined || pos.c >= cells.length) return { error: 0x12 };
  const cls = insertClassOf(cells, pos.c);
  const SO: Tok = { k: "so", ch: "" };
  const SI: Tok = { k: "si", ch: "" };
  let ops: Tok[];
  if (isWideForDbcs(ch)) {
    // 字の印は後半に付ける（カーソルは字の次のセル）
    const db: Tok[] = [{ k: "lead", ch }, { k: "tail", ch: "", mark: true }];
    if (cls === "S") ops = [SO, ...db, SI];
    else if (cls === "O") ops = [SO, ...db];
    else if (cls === "I" || cls === "D") ops = db;
    else return { error: 0x12 };
  } else {
    const sb: Tok = { k: "sb", ch, mark: true };
    if (cls === "S" || cls === "O") ops = [sb];
    else if (cls === "I") ops = [SI, sb];
    else if (cls === "D") ops = [SI, sb, SO];
    else return { error: 0x12 };
  }
  const r = reflow(segs, pos, ops);
  if (r === undefined || r.markAt === undefined) return { error: 0x12 };
  return { segs: r.segs, cursor: afterMark(r.segs, r.markAt) };
}

/**
 * **上書きで 1 字**（ACS `inputChar`）。区間の中は継続でない O 欄の表どおり。区間の終わりで足りない（継続でない O 欄なら 0005・0065 の行）とき、
 * 次の区間があればカーソルの次から区間の終わりを死んだ桁にして（カーソルのセルはそのまま）次の区間の頭で打ち直す。詰め直しはしない
 */
export function chainOverwrite(segs: readonly (readonly OCell[])[], pos: ChainPos, ch: string): ChainResult {
  const cells = segs[pos.seg];
  if (cells === undefined) return { noop: true };
  const r = overwrite(cells, pos.c, ch);
  if ("error" in r) {
    if (pos.seg + 1 >= segs.length) return r;
    const out = copy(segs);
    for (let i = pos.c + 1; i < out[pos.seg]!.length; i++) out[pos.seg]![i] = dead();
    return chainOverwrite(out, { seg: pos.seg + 1, c: 0 }, ch);
  }
  if ("noop" in r) return r;
  const out = copy(segs);
  out[pos.seg] = r.cells;
  const cursor = r.cursor >= cells.length && pos.seg + 1 < segs.length ? { seg: pos.seg + 1, c: 0 } : { seg: pos.seg, c: r.cursor };
  return { segs: out, cursor };
}

/**
 * **Delete**（ACS `processDeleteChar` → `deleteCharInContField`）。消す桁数 k は SO+SI・SI+SO・全角・死んだ桁が 2、単独の SO/SI は 0065、ほかは 1
 * （次のセルは区間の中だけを見る——区間の最後の SO/SI の次は属性）。区間ごとに k 左へ詰め、**区間の最後の k 桁は次の区間の頭の k 桁**
 * （カーソルが区間の最後の k 桁の中でもそう書く——ACS の詰め方のまま）、最終区間の最後の k 桁は空き。そのあと操作無しの詰め直し（収まらなければ詰めたまま）。
 * 単独の SO/SI（0065）で ACS はそれでも詰め直しを回すが、ここでは値を変えない（未測定）
 */
export function chainDelete(segs: readonly (readonly OCell[])[], pos: ChainPos): ChainResult {
  const cells = segs[pos.seg];
  if (cells === undefined || pos.c >= cells.length) return { error: 0x05 };
  const x = cells[pos.c]!;
  const next = cells[pos.c + 1]?.k;
  let k: number;
  if (x.k === "so") k = next === "si" ? 2 : 0;
  else if (x.k === "si") k = next === "so" ? 2 : 0;
  else if (x.k === "lead" || x.k === "tail" || x.dead) k = 2;
  else k = 1;
  if (k === 0) return { error: 0x65 };
  const out = copy(segs);
  for (let s = pos.seg; s < out.length; s++) {
    const orig = segs[s]!;
    const dst = out[s]!;
    const len = dst.length;
    for (let i = s === pos.seg ? pos.c : 0; i < len - k; i++) dst[i] = { ...orig[i + k]! };
    for (let j = 0; j < k && len - k + j >= 0; j++) {
      const from = segs[s + 1]?.[j];
      dst[len - k + j] = from !== undefined ? { ...from } : empty();
    }
  }
  const r = reflow(out, pos, []);
  return { segs: r?.segs ?? out, cursor: pos };
}

/**
 * **Backspace**（ACS `processBackspace`）。カーソルが区間の頭（2 つ目以降の区間）なら、前の区間の最後のセルを消す（そのセルが何でも）。
 * ほかは継続でない O 欄と同じ対象の桁（`backspaceTarget`）。鎖の頭は 0005。消した桁にカーソルを置く
 */
export function chainBackspace(segs: readonly (readonly OCell[])[], pos: ChainPos): ChainResult {
  let target: ChainPos;
  if (pos.c === 0) {
    if (pos.seg === 0) return { error: 0x05 };
    target = { seg: pos.seg - 1, c: segs[pos.seg - 1]!.length - 1 };
  } else {
    const n = backspaceTarget(segs[pos.seg]!, pos.c);
    if (typeof n !== "number") return n;
    target = { seg: pos.seg, c: n };
  }
  const r = chainDelete(segs, target);
  return "segs" in r ? { segs: r.segs, cursor: target } : r;
}
