/**
 * SQL 欄のキー操作（コメントの切り替え・インデント）。
 *
 * **`textarea` のまま実装する。** CodeMirror / Monaco は入れない
 * （AGENTS.md のバンドル規律。`@ts5250/scs` のバレル参照で 359,853 → 1,458,480 バイトに
 * した実例がある）。必要なのは行単位の文字列操作だけで、それは純関数で書ける。
 *
 * **描画から切り離した純関数**にしてあるので、選択範囲の維持まで含めてテストできる。
 * `SqlPane` 側は「新しい文字列と新しい選択範囲」を受け取って流し込むだけ。
 */

/** 1 段のインデント。**空白 2 つ**（タブ文字はホストへ送る SQL に混ぜたくない） */
export const INDENT = "  ";

/** SQL の行コメント。`--` の後ろに空白を 1 つ置く（`--文` は読みにくい） */
const COMMENT = "--";
const COMMENT_ADD = "-- ";

/** 編集の結果。呼び出し側はこれを `textarea` に流し込む */
export interface EditResult {
  text: string;
  /** 適用後の選択開始（`textarea.selectionStart`） */
  start: number;
  /** 適用後の選択終了 */
  end: number;
}

/** 選択範囲が掛かっている行の、最初の行頭と最後の行末（改行は含まない） */
function lineRange(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // 行頭で終わる選択は**その行を含めない**（行を丸ごと選んだときに 1 行余計に掛かる）
  const tail = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nl = text.indexOf("\n", tail);
  return { from, to: nl === -1 ? text.length : nl };
}

/** 行頭の空白の長さ */
function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * 選択している行のコメントを切り替える（Ctrl+/）。
 *
 * **判断は行ごと**——コメントの行は外し、素の行は付ける。混ざった範囲を選ぶと
 * それぞれが反転する:
 *
 * ```
 * -- A        A
 * B      →    -- B
 * ```
 *
 * エディタ一般（VS Code 等）は「1 行でも素のものがあれば全部付ける」だが、
 * それだと `-- A` が `-- -- A` になって**コメントが二重に積み上がる**。
 * 利用者の指摘で行ごとの反転に変えた。
 *
 * 付ける位置は**これから付ける行の中で一番浅いインデント**に揃える。行ごとの位置に
 * 付けると段差がコメント記号でばらけて読めなくなる。空行は触らない。
 */
export function toggleLineComment(text: string, start: number, end: number): EditResult {
  const { from, to } = lineRange(text, start, end);
  const block = text.slice(from, to);
  const lines = block.split("\n");
  const meaningful = lines.filter((l) => l.trim() !== "");
  // 選択が空行だけなら何もしない（`--` だけの行を作らない）
  if (meaningful.length === 0) return { text, start, end };

  const commented = (l: string): boolean => l.trimStart().startsWith(COMMENT);
  // **これから付ける行だけ**で揃える位置を決める（外す行の字下げに引っ張られない）
  const adding = meaningful.filter((l) => !commented(l));
  const column = adding.length > 0 ? Math.min(...adding.map((l) => indentWidth(l))) : 0;

  const next = lines.map((line) => {
    if (line.trim() === "") return line;
    if (commented(line)) {
      const at = indentWidth(line);
      const rest = line.slice(at + COMMENT.length);
      // `-- ` で付けたものは空白ごと外す（往復して字下げが増えない）
      return line.slice(0, at) + (rest.startsWith(" ") ? rest.slice(1) : rest);
    }
    return line.slice(0, column) + COMMENT_ADD + line.slice(column);
  });

  const replaced = next.join("\n");
  const delta = replaced.length - block.length;
  // **選択は「掛かっていた行」を選び直す**。文字数がずれるので端の位置は当てにできない
  return { text: text.slice(0, from) + replaced + text.slice(to), start: from, end: to + delta };
}

/**
 * 選択している行を 1 段下げる（Tab）。
 *
 * 選択が無い（キャレットだけ）ときは**その位置に空白を差し込む**——
 * 行頭に飛ばすと、書いている途中のカーソルが行頭へ戻って驚く。
 */
export function indentLines(text: string, start: number, end: number): EditResult {
  if (start === end) {
    return {
      text: text.slice(0, start) + INDENT + text.slice(start),
      start: start + INDENT.length,
      end: start + INDENT.length
    };
  }
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const replaced = lines.map((l) => (l.trim() === "" ? l : INDENT + l)).join("\n");
  const delta = replaced.length - (to - from);
  return { text: text.slice(0, from) + replaced + text.slice(to), start: from, end: to + delta };
}

/**
 * 選択している行を 1 段戻す（Shift+Tab）。
 *
 * **1 段に満たない字下げはあるだけ外す**（空白 1 つで止まっている行が取り残されない）。
 */
export function outdentLines(text: string, start: number, end: number): EditResult {
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const replaced = lines
    .map((l) => {
      const drop = Math.min(indentWidth(l), INDENT.length);
      return l.slice(drop);
    })
    .join("\n");
  const delta = replaced.length - (to - from);
  if (delta === 0) return { text, start, end };
  return {
    text: text.slice(0, from) + replaced + text.slice(to),
    // キャレットだけのときは行頭より前へ戻さない
    start: start === end ? Math.max(from, start + delta) : from,
    end: start === end ? Math.max(from, start + delta) : to + delta
  };
}
