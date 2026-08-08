import { describe, it, expect } from "vitest";
import { toggleLineComment, indentLines, outdentLines, INDENT } from "../src/sqlEdit.js";

/**
 * SQL 欄のキー操作。**描画から切り離した純関数**なので、選択範囲の維持まで試せる
 * （`sqlEdit.ts` の注記）。
 *
 * `|` をキャレット、`[…]` を選択範囲として書き、位置を数えるのはヘルパーに任せる
 * ——数字を直に書くと、文面を直したときに全部ずれる。
 */
function at(marked: string): { text: string; start: number; end: number } {
  const start = marked.indexOf("[");
  if (start >= 0) {
    const rest = marked.replace("[", "");
    const end = rest.indexOf("]");
    return { text: rest.replace("]", ""), start, end };
  }
  const caret = marked.indexOf("|");
  return { text: marked.replace("|", ""), start: caret, end: caret };
}

describe("コメントの切り替え（Ctrl+/）", () => {
  it("キャレットのある行にコメントを付ける", () => {
    const { text, start, end } = at("SELECT 1|\nSELECT 2");
    expect(toggleLineComment(text, start, end).text).toBe("-- SELECT 1\nSELECT 2");
  });

  it("もう一度で外れる（`-- ` で付けた空白ごと）", () => {
    const once = toggleLineComment("SELECT 1", 0, 0);
    expect(toggleLineComment(once.text, 0, once.text.length).text).toBe("SELECT 1");
  });

  it("選択した複数行をまとめて切り替える", () => {
    const { text, start, end } = at("[SELECT 1\nSELECT 2]");
    expect(toggleLineComment(text, start, end).text).toBe("-- SELECT 1\n-- SELECT 2");
  });

  /**
   * **判断は行ごと**。「1 行でも素のものがあれば全部付ける」（エディタ一般）だと
   * `-- A` が `-- -- A` になってコメントが二重に積み上がる（利用者の指摘）。
   */
  it("混ざった範囲は行ごとに反転する", () => {
    const { text, start, end } = at("[-- SELECT 1\nSELECT 2]");
    expect(toggleLineComment(text, start, end).text).toBe("SELECT 1\n-- SELECT 2");
  });

  it("反転なので 2 回で元に戻る", () => {
    const { text, start, end } = at("[-- SELECT 1\nSELECT 2]");
    const once = toggleLineComment(text, start, end);
    const twice = toggleLineComment(once.text, once.start, once.end);
    expect(twice.text).toBe("-- SELECT 1\nSELECT 2");
  });

  /** 外す行の字下げに引っ張られて、付ける側の位置がずれないこと */
  it("揃える位置は**これから付ける行だけ**で決める", () => {
    const { text, start, end } = at("[    -- SELECT 1\n  SELECT 2\n  AND 3]");
    expect(toggleLineComment(text, start, end).text).toBe("    SELECT 1\n  -- SELECT 2\n  -- AND 3");
  });

  it("全部コメントなら全部外す", () => {
    const { text, start, end } = at("[-- SELECT 1\n-- SELECT 2]");
    expect(toggleLineComment(text, start, end).text).toBe("SELECT 1\nSELECT 2");
  });

  /** 行ごとの位置に付けると段差が記号でばらける */
  it("付ける位置は**一番浅い字下げ**に揃える", () => {
    const { text, start, end } = at("[SELECT 1\n    AND 2]");
    expect(toggleLineComment(text, start, end).text).toBe("-- SELECT 1\n--     AND 2");
  });

  it("空行は触らない（`--` だけの行を作らない）", () => {
    const { text, start, end } = at("[SELECT 1\n\nSELECT 2]");
    expect(toggleLineComment(text, start, end).text).toBe("-- SELECT 1\n\n-- SELECT 2");
  });

  it("空行だけを選んだら何も変えない", () => {
    const r = toggleLineComment("\n\n", 0, 2);
    expect(r.text).toBe("\n\n");
  });

  /** 行を丸ごと選ぶと選択が次の行頭で終わる。1 行余計に掛けない */
  it("行末の改行までの選択で次の行を巻き込まない", () => {
    const { text, start, end } = at("[SELECT 1\n]SELECT 2");
    expect(toggleLineComment(text, start, end).text).toBe("-- SELECT 1\nSELECT 2");
  });

  it("掛かっていた行が選び直される（続けて押せる）", () => {
    const r = toggleLineComment("SELECT 1\nSELECT 2", 0, 0);
    expect(r.start).toBe(0);
    expect(r.text.slice(r.start, r.end)).toBe("-- SELECT 1");
  });
});

describe("字下げ（Tab / Shift+Tab）", () => {
  it("選択が無ければその位置に空白を差し込む", () => {
    const { text, start, end } = at("SELECT|1");
    const r = indentLines(text, start, end);
    expect(r.text).toBe(`SELECT${INDENT}1`);
    expect(r.start).toBe(start + INDENT.length);
  });

  it("選択した行をまとめて 1 段下げる", () => {
    const { text, start, end } = at("[SELECT 1\nSELECT 2]");
    expect(indentLines(text, start, end).text).toBe(`${INDENT}SELECT 1\n${INDENT}SELECT 2`);
  });

  it("空行は下げない（末尾に空白だけの行を作らない）", () => {
    const { text, start, end } = at("[SELECT 1\n\nSELECT 2]");
    expect(indentLines(text, start, end).text).toBe(`${INDENT}SELECT 1\n\n${INDENT}SELECT 2`);
  });

  it("Shift+Tab で 1 段戻す", () => {
    const { text, start, end } = at(`[${INDENT}SELECT 1\n${INDENT}SELECT 2]`);
    expect(outdentLines(text, start, end).text).toBe("SELECT 1\nSELECT 2");
  });

  /** 空白 1 つで止まっている行が取り残されない */
  it("1 段に満たない字下げはあるだけ外す", () => {
    const { text, start, end } = at("[ SELECT 1\n   SELECT 2]");
    expect(outdentLines(text, start, end).text).toBe(`SELECT 1\n${" "}SELECT 2`);
  });

  it("字下げが無ければ何も変えない", () => {
    const r = outdentLines("SELECT 1", 0, 8);
    expect(r.text).toBe("SELECT 1");
    expect(r.start).toBe(0);
  });

  it("下げてから戻すと元に戻る", () => {
    const text = "SELECT 1\n  AND 2";
    const down = indentLines(text, 0, text.length);
    const up = outdentLines(down.text, down.start, down.end);
    expect(up.text).toBe(text);
  });
});
