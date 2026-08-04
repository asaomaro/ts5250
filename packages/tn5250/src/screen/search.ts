/**
 * 画面の走査——**桁位置・欄・文字列検索**。純関数だけ（Node API に依存しない）。
 *
 * ## なぜここに置くか
 *
 * これまで `packages/server/src/hllapi-ps.ts` に閉じていて、**HLLAPI からしか使えなかった**。
 * スクリプトも MCP も同じことをしたい（画面から欄を見つける）ので、共有できる高さへ移す。
 *
 * `hllapi-ps.ts` はここを再輸出する。**CP932 のバイト列を扱う部分だけ**があちらに残る
 * （HLLAPI は 1 位置 = 1 バイトを要求するので、検索もバイトで比べる必要がある）。
 *
 * ## 位置は 1 起点の通し番号
 *
 * `(row-1) * cols + col`。HLLAPI の PS 位置と同じ数え方で、CP932 では 1 桁 = 1 バイトなので
 * バイト位置とも一致する。
 */
import type { Field, ScreenSnapshot } from "./types.js";

/** 画面の大きさ（`ScreenSnapshot` の一部だけを使う） */
export interface ScreenSize {
  rows: number;
  cols: number;
}

/** その画面の桁数（1 起点の通し番号の上限） */
export function screenLength(size: ScreenSize): number {
  return size.rows * size.cols;
}

/**
 * 1 起点の通し番号 → 行桁（どちらも 1 起点）。
 * **範囲外は `undefined`**——呼び出し側が意味づけする。
 */
export function posToRowCol(pos: number, size: ScreenSize): { row: number; col: number } | undefined {
  if (!Number.isInteger(pos) || pos < 1 || pos > screenLength(size)) return undefined;
  const zero = pos - 1;
  return { row: Math.floor(zero / size.cols) + 1, col: (zero % size.cols) + 1 };
}

/** 行桁（1 起点）→ 1 起点の通し番号。**範囲外は `undefined`** */
export function rowColToPos(row: number, col: number, size: ScreenSize): number | undefined {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return undefined;
  if (row < 1 || row > size.rows || col < 1 || col > size.cols) return undefined;
  return (row - 1) * size.cols + col;
}

const sizeOf = (s: ScreenSnapshot): ScreenSize => ({ rows: s.rows, cols: s.cols });

/** その位置を含む欄。無ければ `undefined` */
export function fieldAt(snapshot: ScreenSnapshot, pos: number): Field | undefined {
  const size = sizeOf(snapshot);
  if (posToRowCol(pos, size) === undefined) return undefined;
  for (const f of snapshot.fields) {
    const start = rowColToPos(f.row, f.col, size);
    if (start === undefined) continue;
    if (pos >= start && pos < start + f.length) return f;
  }
  return undefined;
}

/** 欄の先頭位置（1 起点）。求まらなければ `undefined` */
export function fieldStart(field: Field, size: ScreenSize): number | undefined {
  return rowColToPos(field.row, field.col, size);
}

/** 入力できる欄か */
export function isInputField(f: Field): boolean {
  return !f.protected;
}

/**
 * 欄の**位置由来の識別子**（`f<row>c<col>`。例 `f20c7`）。
 *
 * ## 意味的な安定は主張しない
 *
 * 5250 は欄の名前を電文で運ばない（GUI 構造体の `id` すらこちらで振っている）ので、
 * **導出した識別子はどれもレイアウト変更に耐えない**。設計の巧拙ではなくプロトコルの性質。
 *
 * そのうえで**壊れ方を局所に留める**ためにこの形にしてある:
 *
 * - `(row,col)` 由来 → **その欄が動いたときだけ**変わる
 * - `index`（連番） → **手前の欄が 1 つ増減しただけで全部ずれる**
 *
 * 用途は「いま見つけた欄をもう一度指す」「DOM のセレクタ」「重複検出」。
 * **レイアウト変更に耐える指し方が要るなら `fieldAfterLabel`**（見えている文字に錨を打つ）。
 *
 * ## なぜ `Field` に持たせないのか
 *
 * **規則を 1 か所に置く**のが目的で、それはこの関数が唯一の実装であることで達せられる。
 * 型に必須の属性として足すと、テストの器 100 箇所以上が一斉に壊れ、**churn に見合わない**。
 * 外へ出す口（MCP の `structuredContent`、DOM の属性）では**ここで derive して載せる**。
 */
export function fieldId(field: Pick<Field, "row" | "col">): string {
  return `f${field.row}c${field.col}`;
}

/** `id`（`f<row>c<col>`）で欄を引く */
export function fieldById(snapshot: ScreenSnapshot, id: string): Field | undefined {
  return snapshot.fields.find((f) => fieldId(f) === id);
}

/** 入力欄を先頭位置の順に並べる */
function sortedInputs(snapshot: ScreenSnapshot): { f: Field; start: number }[] {
  const size = sizeOf(snapshot);
  return snapshot.fields
    .filter(isInputField)
    .map((f) => ({ f, start: fieldStart(f, size) ?? 0 }))
    .sort((a, b) => a.start - b.start);
}

/**
 * `pos` の**次の入力欄**（Tab 相当）。
 * 末尾まで無ければ**先頭へ回り込む**（5250 の Tab と同じ）。
 */
export function nextInputField(snapshot: ScreenSnapshot, pos: number): Field | undefined {
  const inputs = sortedInputs(snapshot);
  if (inputs.length === 0) return undefined;
  return (inputs.find((x) => x.start > pos) ?? inputs[0])?.f;
}

/** `pos` の**前の入力欄**（BackTab 相当）。先頭まで無ければ末尾へ回り込む */
export function prevInputField(snapshot: ScreenSnapshot, pos: number): Field | undefined {
  const inputs = sortedInputs(snapshot);
  if (inputs.length === 0) return undefined;
  const before = inputs.filter((x) => x.start < pos);
  return (before.length > 0 ? before[before.length - 1] : inputs[inputs.length - 1])?.f;
}

// ---- 文字列で探す ----

/**
 * 画面を**文字の並び**として取る（改行なしの固定長。長さは `rows * cols`）。
 *
 * **`hllapi-ps.ts` の `psBytes` とは別物。** あちらは CP932 のバイト列で、
 * 全角が 2 バイトを占める。こちらは**セル 1 つ = 文字 1 つ**（追従セルは空白で埋める）
 * ——JS の文字列として素直に扱えることを優先する。
 */
export function screenText(snapshot: ScreenSnapshot): string {
  const out: string[] = [];
  for (let r = 0; r < snapshot.rows; r++) {
    const row = snapshot.cells[r];
    for (let c = 0; c < snapshot.cols; c++) {
      const cell = row?.[c];
      // 全角の追従セルは `char` が空。**桁を保つため空白を置く**
      out.push(cell?.char !== undefined && cell.char !== "" ? cell.char : " ");
    }
  }
  return out.join("");
}

/** 画面上の文字列をすべて探す（1 起点の位置の配列。空なら探さない） */
export function findAllText(snapshot: ScreenSnapshot, text: string): number[] {
  if (text === "") return [];
  const hay = screenText(snapshot);
  const out: number[] = [];
  for (let i = hay.indexOf(text); i >= 0; i = hay.indexOf(text, i + 1)) out.push(i + 1);
  return out;
}

/** 候補の説明（例外に添えて、人がそのまま絞り込めるようにする） */
export interface MatchCandidate {
  row: number;
  col: number;
  /** その位置の周辺の文字（何と紛れているかが分かる） */
  near: string;
}

/**
 * **複数当たった**ことを伝える例外。
 *
 * 黙って先頭を取らない——実機の `WRKSPLF` では 1 つの見出し（`OPT`）が **9 個の欄**を支配し、
 * **行の内容まで重複する**（同じスプール名が 2 行）。**導出できる一意な鍵は存在しない**ので、
 * 曖昧さは利用者に返すしかない。
 *
 * Playwright の strict mode と同じ判断。
 */
export class AmbiguousMatchError extends Error {
  readonly candidates: MatchCandidate[];
  constructor(what: string, candidates: MatchCandidate[]) {
    super(
      `${what} に ${candidates.length} 個が該当します。絞り込んでください:\n` +
        candidates.map((c) => `  row=${c.row} col=${c.col}  ${c.near}`).join("\n")
    );
    this.name = "AmbiguousMatchError";
    this.candidates = candidates;
  }
}

/** 絞り込みの条件（**重ねられる**） */
export interface NarrowOptions {
  /** 行の範囲（両端を含む） */
  rows?: [number, number];
  /** 桁の範囲（両端を含む） */
  cols?: [number, number];
}

function describe(snapshot: ScreenSnapshot, pos: number): MatchCandidate {
  const size = sizeOf(snapshot);
  const rc = posToRowCol(pos, size) ?? { row: 0, col: 0 };
  const line = screenText(snapshot).slice((rc.row - 1) * size.cols, rc.row * size.cols);
  return { row: rc.row, col: rc.col, near: line.trim().slice(0, 60) };
}

function withinNarrow(snapshot: ScreenSnapshot, pos: number, opts: NarrowOptions): boolean {
  const rc = posToRowCol(pos, sizeOf(snapshot));
  if (!rc) return false;
  if (opts.rows && (rc.row < opts.rows[0] || rc.row > opts.rows[1])) return false;
  if (opts.cols && (rc.col < opts.cols[0] || rc.col > opts.cols[1])) return false;
  return true;
}

/**
 * ラベルと**同じ行**の、その後ろにある入力欄を引く。
 *
 * **これがレイアウト変更に耐える唯一の指し方。** 欄が動いても、ラベルとの関係は変わらない。
 * 壊れるのは**文言が変わったとき**で、それは「画面が本当に変わった」ということなので
 * **壊れるべき場面で壊れる**。
 *
 * ## なぜ「同じ行」に限るのか
 *
 * ラベルと欄が 1 対 1 で並ぶのは**同じ行**のとき（`ユーザー . . . : ___`）。
 * 一覧画面の見出し（`OPT`）は**その下の列に並ぶ N 個**を支配していて、関係が違う。
 * 行をまたいで「次の入力欄」を取ると、**9 個の先頭を黙って返す**——避けたい挙動そのもの。
 *
 * 一覧の欄を指すなら `fieldInRowWith`（行の内容で選ぶ）を使うこと。
 *
 * **同じラベルが複数の行にあれば `AmbiguousMatchError`**。`nth` は用意しない
 * （順序依存で事故の元）ので、`rows` / `cols` で絞ること。
 */
export function fieldAfterLabel(
  snapshot: ScreenSnapshot,
  label: string,
  opts: NarrowOptions = {}
): Field | undefined {
  const size = sizeOf(snapshot);
  const hits = findAllText(snapshot, label).filter((p) => withinNarrow(snapshot, p, opts));
  const found: Field[] = [];
  for (const pos of hits) {
    const rc = posToRowCol(pos, size);
    if (!rc) continue;
    const after = rc.col + label.length;
    // **同じ行で、ラベルより後ろ**にある入力欄のうち、いちばん近いもの
    const onRow = snapshot.fields
      .filter((f) => isInputField(f) && f.row === rc.row && f.col >= after)
      .sort((a, b) => a.col - b.col);
    const f = onRow[0];
    if (f && !found.some((x) => fieldId(x) === fieldId(f))) found.push(f);
  }
  if (found.length === 0) return undefined;
  if (found.length > 1) {
    throw new AmbiguousMatchError(
      `「${label}」と同じ行の入力欄`,
      found.map((f) => describe(snapshot, rowColToPos(f.row, f.col, size) ?? 1))
    );
  }
  return found[0];
}

/**
 * **その文字列を含む行**の入力欄を引く（一覧の行を指す）。
 *
 * **複数当たれば `AmbiguousMatchError`**——実機では行の内容も重複する
 * （同じスプール名が 2 行）。`col` で列を絞るか、より特徴的な文字列を使うこと。
 */
export function fieldInRowWith(
  snapshot: ScreenSnapshot,
  text: string,
  opts: { col?: number } = {}
): Field | undefined {
  const size = sizeOf(snapshot);
  const rowsWith = new Set(
    findAllText(snapshot, text)
      .map((p) => posToRowCol(p, size)?.row)
      .filter((r): r is number => r !== undefined)
  );
  const found = snapshot.fields.filter(
    (f) => isInputField(f) && rowsWith.has(f.row) && (opts.col === undefined || f.col === opts.col)
  );
  if (found.length === 0) return undefined;
  if (found.length > 1) {
    throw new AmbiguousMatchError(
      `「${text}」を含む行の入力欄`,
      found.map((f) => describe(snapshot, rowColToPos(f.row, f.col, size) ?? 1))
    );
  }
  return found[0];
}
