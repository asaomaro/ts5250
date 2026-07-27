/**
 * 機能キー凡例（`F3=終了` 等）の検出。
 *
 * ホストは凡例を**単なるテキスト**として送ってくる（拡張5250 の画面でも同じ。research F4）。
 * 利用者から見れば「押せる操作」なので、テキストから機械的に拾ってボタンにする。
 *
 * 【この実装が桁（column）を基準にする理由 — spec D1】
 * DBCS があると**文字列インデックスと桁がずれる**（実測: 同じ行で `F12` が文字列 37 桁 43）。
 * 桁がずれるとボタンの位置・幅が実際の文字とずれるため、`cells`（1 セル = 1 桁、DBCS は
 * lead + tail の 2 セル）を基準に「表示文字列」と「文字列 index → 桁」の対応を同時に作る。
 */
import type { AidKey, Cell, ScreenSnapshot } from "@as400web/core";

/** 検出した凡例 1 件。座標は 1 始まりの桁。 */
export interface FkeySpan {
  row: number;
  /** "F" が始まる桁 */
  col: number;
  /** 凡例全体（"F3= 終了"）が占める桁数 */
  width: number;
  key: AidKey;
  /** ラベル（前後空白・末尾の罫線を除去済み） */
  label: string;
}

/** 窓の**内側**（1 始まり・閉区間）。窓が無ければ null。 */
export interface WindowRect {
  row1: number;
  row2: number;
  col1: number;
  col2: number;
}

/** 横罫（窓の上下端）。IBM i の既定ヘルプ窓は `.` を使う（research F8 で実測）。 */
const BORDER_H = new Set([".", "-", "─", "━", "═", "_", "＿"]);
/** 縦罫（窓の左右端）。同上、既定は `:`。 */
const BORDER_V = new Set([":", "：", "|", "｜", "│", "┃", "║"]);
/** ラベル末尾に食い込む罫線・区切り（除去する） */
const TRAILING_BORDER = /[.:：|｜│┃║─━═┌┐└┘├┤┬┴┼\s]+$/u;
/** 窓の上下端とみなす横罫の最小長（桁）。見出しの点線 `. . . .` は連続しないので拾わない。 */
const MIN_BORDER_RUN = 8;
/**
 * 反転枠の上下端とみなす反転の最小長（桁）。
 * `MIN_BORDER_RUN` と同じ値だが**共有しない**——将来どちらかだけ調整したくなったときに、
 * 片方を触って両方動くのを避ける。
 */
const MIN_REVERSE_FRAME = 8;

/** `F<n>=` の開始位置。直前が英数字なら凡例ではない（`REF3=` `XF1=` を弾く）。 */
const LEGEND_RE = /(?<![A-Za-z0-9])F(\d{1,2})\s*=\s*/g;

/** セルの表示文字を取り出す関数。呼び出し側（ScreenGrid）が SO/SI マーク・カナ表示の
 *  設定を反映した文字を返せるようにする（設定と検出結果を食い違わせないため）。 */
export type CharOf = (cell: Cell) => string;

const defaultCharOf: CharOf = (c) => (c.char === "" ? " " : c.char);

/** 1 行の「表示文字列」と「文字列 index → 桁(1 始まり)」の対応。DBCS の tail は文字を持たない。 */
interface RowText {
  text: string;
  /** colOf[i] = text[i] が始まる桁 */
  colOf: number[];
  /** widthOf[i] = text[i] が占める桁数（DBCS なら 2） */
  widthOf: number[];
}

/** 行を桁空間のモデルへ変換する（spec D1）。 */
export function rowText(cells: readonly Cell[], cols: number, charOf: CharOf = defaultCharOf): RowText {
  let text = "";
  const colOf: number[] = [];
  const widthOf: number[] = [];
  for (let c = 0; c < cols; c++) {
    const cell = cells[c];
    if (!cell) continue;
    // tail は lead 側が 2 桁ぶんを担うので文字を持たない（持たせると桁と文字数が合わなくなる）
    if (cell.kind === "dbcs-tail") {
      if (widthOf.length > 0) widthOf[widthOf.length - 1] = 2;
      continue;
    }
    text += charOf(cell);
    colOf.push(c + 1);
    widthOf.push(1);
  }
  return { text, colOf, widthOf };
}

/** 行から長さ MIN_BORDER_RUN 以上の横罫の連なりを拾う（桁は 1 始まりの閉区間）。 */
function horizontalRuns(rt: RowText): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let i = 0;
  while (i < rt.text.length) {
    if (!BORDER_H.has(rt.text[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < rt.text.length && BORDER_H.has(rt.text[j]!)) j++;
    if (j - i >= MIN_BORDER_RUN) out.push({ from: rt.colOf[i]!, to: rt.colOf[j - 1]! });
    i = j;
  }
  return out;
}

/** 行から「反転が途切れず続く区間」を拾う（桁は 1 始まりの閉区間）。 */
function reverseRuns(cells: readonly Cell[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let i = 0;
  while (i < cells.length) {
    if (!cells[i]!.reverse) {
      i++;
      continue;
    }
    let j = i;
    while (j < cells.length && cells[j]!.reverse) j++;
    out.push({ from: i + 1, to: j });
    i = j;
  }
  return out;
}

/**
 * **反転表示が途切れなく閉じた矩形**を作っていればその外周を返す。
 *
 * ホストの ATNPGM の窓（Attn の「コマンド入力」）は枠を反転表示の空白セルで描き、罫線文字を
 * 1 つも使わないため `horizontalRuns` では拾えない。判定できないと、窓が出ている間も
 * **背面の F キー凡例がボタンとして残り**、押すと窓側の文脈で解釈されてラベルと食い違う。
 *
 * 反転は見出し行・メッセージ行・選択行の強調にも使われるので、**閉じていることを厳しく要求する**:
 *
 * 1. 上端: 途切れない反転の連なり（`MIN_REVERSE_FRAME` 桁以上）
 * 2. 下端: 2 行以上下に、**同じ桁範囲**の途切れない反転の連なり
 * 3. 側面: その間の**すべての行**で左右端の桁が両方とも反転
 * 4. **内側: 反転でないセルが 1 つ以上ある（＝中が空いている）**
 *
 * 「上下 2 本の反転バー」だけでは 3 を満たさないので弾ける。
 * **4 が要るのは、1〜3 が「全部が反転した塗り潰しブロック」でも成立してしまうから**——
 * 全面反転なら上端も下端も途切れず、側面の 2 桁も当然反転している。枠として本質的なのは
 * 中が空いていることで、見出しや選択行の強調が数行続くと実際に誤判定した（実機報告）。
 *
 * 4 は「**内側のどこかに** 1 つでも非反転があれば可」という緩い条件にしてある。
 * 窓の中に**全幅の反転強調行**（選択中の行）が入るのは普通なので、
 * 「内側の全行に非反転を要求する」と本物の窓を弾いてしまう。
 *
 * 上下端を完全一致にしているのは、
 * 反転枠は属性そのもので描かれるため桁がずれる理由が無いから（実機で確認）。
 * 罫線経路が重なり率で判定しているのは端の記号（`:`）の有無でずれるからで、事情が違う。
 *
 * **矩形は削らずそのまま返す。** 上下端の行は枠ではなく中身（タイトル・F キー凡例が載る）で、
 * 削ると凡例が落ちる（拡張5250 の窓で削らないのと同じ理由）。
 */
function detectReverseFrame(snap: ScreenSnapshot): WindowRect | null {
  const runs = snap.cells.map((cells) => reverseRuns(cells));
  if (!runs.some((r) => r.length > 0)) return null; // 反転が無い画面は即やめる
  const isRev = (r: number, col: number): boolean => snap.cells[r]?.[col - 1]?.reverse === true;

  let best: WindowRect | null = null;
  let bestArea = 0;
  for (let top = 0; top < snap.rows; top++) {
    for (const t of runs[top] ?? []) {
      if (t.to - t.from + 1 < MIN_REVERSE_FRAME) continue;
      for (let bottom = top + 2; bottom < snap.rows; bottom++) {
        // 下端は同じ桁範囲の「途切れない」連なりであること
        if (!(runs[bottom] ?? []).some((b) => b.from === t.from && b.to === t.to)) continue;
        // 側面: 間のすべての行で左右端が反転
        let closed = true;
        for (let r = top + 1; r < bottom && closed; r++) {
          closed = isRev(r, t.from) && isRev(r, t.to);
        }
        if (!closed) continue;
        // 4. 内側が空いていること。**塗り潰しブロックを弾く唯一の条件**なので外さない
        let hollow = false;
        for (let r = top + 1; r < bottom && !hollow; r++) {
          for (let col = t.from + 1; col < t.to; col++) {
            if (!isRev(r, col)) {
              hollow = true;
              break;
            }
          }
        }
        if (!hollow) continue;
        const area = (bottom - top) * (t.to - t.from);
        if (area > bestArea) {
          bestArea = area;
          best = { row1: top + 1, row2: bottom + 1, col1: t.from, col2: t.to };
        }
      }
    }
  }
  return best;
}

/** 指定桁の文字（無ければ空文字）。桁は 1 始まり。 */
function charAtCol(rt: RowText, col: number): string {
  const i = rt.colOf.indexOf(col);
  return i < 0 ? "" : rt.text[i]!;
}

/**
 * 最前面の窓の内側を返す（spec D3）。
 *
 * 1. `gui.windows` があればその最後（＝最前面）を使う。
 * 2. 無ければ罫線から検出する。**通常のヘルプ窓は `gui.windows` に出ない**ため
 *    （research F3。文字で描かれる）、この経路が実際にはほとんどを占める。
 */
export function detectWindowRect(snap: ScreenSnapshot, charOf: CharOf = defaultCharOf): WindowRect | null {
  const win = snap.gui?.windows;
  if (win && win.length > 0) {
    const w = win[win.length - 1]!;
    // **ホストが送る位置は窓の「中身」ではなく枠の左上。**
    // 中身はその **1 行下・3 桁右**から始まり、大きさは宣言どおり（深さ × 幅）。
    // 枠は中身の上下に 1 行・左右に 2 桁を使い、さらにその左に枠の属性バイトが 1 桁入る。
    //
    // 実機（）で 2 つの窓から確かめた。ホストが窓の中の定数を書いた位置が根拠:
    //   GRIDCL4: SBA(16,19) 40x5 に `2 3'EXPLICIT BORDER CHARS'` → 行 18 桁 24
    //   GRIDCL5: SBA(8,24)  30x8 に `2 3'WINDOW CONTENT'`        → 行 10 桁 29
    // どちらも窓相対 (2,3) が絶対 (row+2, col+4) ＝ 中身の原点は (row+1, col+3)。
    //
    // 宣言された位置をそのまま中身と見なしていたため、枠の装飾・スモーク・凡例の
    // 絞り込みが**1 行上・3 桁左**にずれ、窓の最終行と右端 4 桁が範囲から外れていた。
    return {
      row1: w.row + 1,
      row2: w.row + w.height,
      col1: w.col + 3,
      col2: w.col + w.width + 2
    };
  }

  const rows = snap.cells.map((cells) => rowText(cells, snap.cols, charOf));
  const edges: { r: number; from: number; to: number }[] = [];
  rows.forEach((rt, r) => horizontalRuns(rt).forEach((run) => edges.push({ r, ...run })));

  let best: { top: number; bottom: number; from: number; to: number; area: number } | null = null;
  for (let a = 0; a < edges.length; a++) {
    for (let b = edges.length - 1; b > a; b--) {
      const t = edges[a]!;
      const bo = edges[b]!;
      if (bo.r - t.r < 2) continue;
      // 上下の縁は「大きく重なる」ことを条件にする。端の記号（`:`）の有無で 1〜2 桁ずれるため、
      // 厳密一致にすると実データ（F1 ヘルプ）で対にならない。
      const ov = Math.min(t.to, bo.to) - Math.max(t.from, bo.from) + 1;
      const shorter = Math.min(t.to - t.from + 1, bo.to - bo.from + 1);
      if (ov <= 0 || ov / shorter < 0.8) continue;
      // 間の行に縦罫が立っているか（半数以上）。点線の見出し等を窓と誤認しないための条件。
      let v = 0;
      let n = 0;
      for (let r = t.r + 1; r < bo.r; r++) {
        const rt = rows[r];
        if (!rt) continue;
        n++;
        if (BORDER_V.has(charAtCol(rt, t.from)) || BORDER_V.has(charAtCol(rt, t.to))) v++;
      }
      if (n === 0 || v / n < 0.5) continue;
      const area = (bo.r - t.r) * (t.to - t.from);
      if (!best || area > best.area) best = { top: t.r, bottom: bo.r, from: t.from, to: t.to, area };
    }
  }
  // 罫線が見つからなければ**反転で閉じた矩形**を試す（ATNPGM の窓は枠を反転で描く）
  if (!best) return detectReverseFrame(snap);
  // top/bottom は 0 始まりの行 index。内側は枠の 1 つ内なので +2 / そのまま（1 始まり換算）
  return { row1: best.top + 2, row2: best.bottom, col1: best.from + 1, col2: best.to - 1 };
}

/** 1 行から凡例を拾う（窓・宣言行の絞り込みは呼び出し側）。 */
function legendsInRow(rt: RowText, row: number): FkeySpan[] {
  const out: FkeySpan[] = [];
  const heads: { key: AidKey; at: number; labelFrom: number }[] = [];
  LEGEND_RE.lastIndex = 0;
  for (let m = LEGEND_RE.exec(rt.text); m !== null; m = LEGEND_RE.exec(rt.text)) {
    const n = Number(m[1]);
    if (n < 1 || n > 24) continue; // AID に存在しないキーは拾わない
    heads.push({ key: `F${n}` as AidKey, at: m.index, labelFrom: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const hardEnd = i + 1 < heads.length ? heads[i + 1]!.at : rt.text.length;
    const seg = rt.text.slice(h.labelFrom, hardEnd);
    // ラベルの終わりは「空白 2 個以上」。1 個の空白は日本語ラベル内にも出る（実測: `F13= この画面の使用法`）。
    const cut = seg.search(/\s{2,}/);
    const raw = cut >= 0 ? seg.slice(0, cut) : seg;
    // **ラベルと占有幅は同じ切り出しから求める**（review R1）。別々に求めると、末尾の罫線を
    // ラベルからは除いたのに幅には残り、描画は幅で切り出すので**ボタンが隣の罫線を飲み込む**
    // （実測: `|F3=終了|` で末尾の `|` まで巻き込んでいた）。
    const kept = raw.replace(TRAILING_BORDER, "");
    const label = kept.trim();
    if (!label) continue; // `F3=` だけで中身が無いものは凡例と見なさない
    const endIdx = h.labelFrom + kept.length - 1;
    const col = rt.colOf[h.at]!;
    const lastCol = (rt.colOf[endIdx] ?? rt.colOf[rt.colOf.length - 1]!) + (rt.widthOf[endIdx] ?? 1) - 1;
    out.push({ row, col, width: lastCol - col + 1, key: h.key, label });
  }
  return out;
}

/**
 * 画面全体から凡例を検出する。
 *
 * - 窓があれば**内側だけ**（spec D3）。窓の外＝下の画面の凡例は、ラベルが切れていたり
 *   （`F13= この画`）、押すと前面の窓の文脈で解釈されてラベルと食い違う（`F3= 終了` → 実際はヘルプ終了）。
 * - `gui.selectionFields` がある行は**ホストの宣言を優先**して検出しない（spec FR-8）。
 */
export function detectFkeyLegends(snap: ScreenSnapshot, charOf: CharOf = defaultCharOf): FkeySpan[] {
  const rect = detectWindowRect(snap, charOf);
  const declaredRows = new Set((snap.gui?.selectionFields ?? []).map((f) => f.row));
  const out: FkeySpan[] = [];
  for (let r = 0; r < snap.rows; r++) {
    const row = r + 1;
    if (declaredRows.has(row)) continue;
    if (rect && (row < rect.row1 || row > rect.row2)) continue;
    const cells = snap.cells[r];
    if (!cells) continue;
    for (const s of legendsInRow(rowText(cells, snap.cols, charOf), row)) {
      if (rect && (s.col < rect.col1 || s.col + s.width - 1 > rect.col2)) continue;
      out.push(s);
    }
  }
  return out;
}
