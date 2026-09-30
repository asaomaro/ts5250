import { describe, it, expect } from "vitest";
import { initEdit, typeChar, insertChar, backspace, del, eraseToEnd, type EditState } from "../src/composables/fieldEdit.js";
import { wordWrap, NUL } from "../src/composables/wordWrap.js";

/**
 * **語送りの欄の語送り**（`20260930-word-wrap`）。期待値は実機の ACS のコア（DSM の WRAPFLD・`scripts/acs-probe/word-wrap.txt`）で
 * ホストが受け取った欄のバイト列とカーソル（W1〜W8）。欄は (5,70) から 30 桁: 5 行目の 11 桁＋6 行目の頭から 19 桁。
 */
const LEN = 30;
const ROW_ENDS = [10, 29];
const COLS = 80;

const fresh = (): EditState => ({ ...initEdit(NUL.repeat(LEN), LEN, 0), pad: NUL });

/** 打鍵 1 つ（上書き／挿入）と語送り（ACS は欄の最終桁に打ったときは掛けない） */
function key(s: EditState, ch: string): EditState {
  const at = s.cursor;
  const t = s.insertMode ? insertChar(s, ch, LEN - 1) ?? s : typeChar(s, ch);
  if (at === LEN - 1) return t;
  const w = wordWrap(t.chars, at, t.cursor, ROW_ENDS, COLS);
  return w ? { ...t, chars: w.chars, cursor: w.cursor } : t;
}
const typed = (s: EditState, text: string): EditState => [...text].reduce(key, s);
/** Backspace / Delete のあとの語送り（ACS `processDeleteChar` の後） */
function afterDelete(s: EditState, op: (x: EditState) => EditState, at: number): EditState {
  const t = op(s);
  const w = wordWrap(t.chars, at, t.cursor, ROW_ENDS, COLS);
  return w ? { ...t, chars: w.chars, cursor: w.cursor } : t;
}
const bs = (s: EditState): EditState => afterDelete(s, backspace, s.cursor - 1);
const dl = (s: EditState): EditState => afterDelete(s, del, s.cursor);

/** 欄を実機のログの形（16 進。NUL は 00・空白は 40・末尾の NUL は落とす）へ */
const CODE: Record<string, number> = { " ": 0x40, [NUL]: 0x00 };
"abcdefghi".split("").forEach((c, i) => (CODE[c] = 0x81 + i));
"jklmnopqr".split("").forEach((c, i) => (CODE[c] = 0x91 + i));
"stuvwxyz".split("").forEach((c, i) => (CODE[c] = 0xa2 + i));
CODE["X"] = 0xe7;
const wire = (s: EditState): string => {
  const cs = [...s.chars];
  while (cs.length > 0 && cs[cs.length - 1] === NUL) cs.pop();
  return cs.map((c) => CODE[c]!.toString(16).padStart(2, "0")).join("");
};
const at = (s: EditState, i: number): EditState => ({ ...s, cursor: i });

describe("語送りの欄（実機の ACS のコアの W1〜W8）", () => {
  it("W1: 語の途中で行末になると、語を次の行へ送り、行の残りを NUL で埋める。カーソルは 6,10（欄内 20）", () => {
    const s = typed(fresh(), "aaa bbbb cccc dddd");
    expect(wire(s)).toBe("8181814082828282400000838383834084848484");
    expect(s.cursor).toBe(20);
  });
  it("W2: 何行も送る（最後の行は欄の末尾まで詰まる）", () => {
    const s = typed(fresh(), "one two three four five six");
    expect(wire(s)).toBe("96958540a3a69640000000a388998585408696a499408689a58540a289a7");
  });
  it("W3: 打った後で真ん中を Delete 2 回すると詰め直す（`aabbbb ` の後ろに NUL 4 つ）。カーソルは動かない", () => {
    let s = at(typed(fresh(), "aaa bbbb cccc dddd"), 2);
    s = dl(dl(s));
    expect(wire(s)).toBe("8181828282824000000000838383834084848484");
    expect(s.cursor).toBe(2);
  });
  it("W4: 挿入モードで真ん中に打つ（XXXX が入り、bbbb が次の行へ）。カーソルは 5,77（欄内 7）", () => {
    let s = at(typed(fresh(), "aaa bbbb cccc"), 3);
    s = { ...s, insertMode: true };
    s = typed(s, "XXXX");
    expect(wire(s)).toBe("818181e7e7e7e740000000828282824083838383");
    expect(s.cursor).toBe(7);
  });
  it("W5: 空白の無い長い語は行末で切る（詰め物なし）。カーソルは 6,16（欄内 26）", () => {
    const s = typed(fresh(), "abcdefghijklmnopqrstuvwxyz");
    expect(wire(s)).toBe("818283848586878889919293949596979899a2a3a4a5a6a7a8a9");
    expect(s.cursor).toBe(26);
  });
  it("W6: 打った後で Backspace を 6 回。カーソルは 6,4（欄内 14）", () => {
    let s = typed(fresh(), "aaa bbbb cccc dddd");
    for (let i = 0; i < 6; i++) s = bs(s);
    expect(wire(s)).toBe("8181814082828282400000838383");
    expect(s.cursor).toBe(14);
  });
  it("W8: 空白を続けて打つと空白は詰まらず行末まで並ぶ（NUL は入らない）。カーソルは 6,11（欄内 21）", () => {
    const s = typed(fresh(), "aaa  bbbb   cccc dddd");
    expect(wire(s)).toBe("818181404082828282404040838383834084848484");
    expect(s.cursor).toBe(21);
  });
});

describe("語送りの手順の端（ACS の手順の分岐ごと）", () => {
  const B = " ";
  it("Backspace の後にも語送りを掛ける（W3 の Delete と同じ詰め直し。2 回目は 1 字目を消す）", () => {
    let s = at(typed(fresh(), "aaa bbbb cccc dddd"), 3);
    s = bs(s);
    expect(wire(s)).toBe("8181408282828240000000838383834084848484");
    expect(s.cursor).toBe(2);
    s = bs(s);
    expect(wire(s)).toBe("8140828282824000000000838383834084848484");
    expect(s.cursor).toBe(1);
  });
  it("最後の行（欄の末尾）へは送らない: 満杯の欄の最後の行に空白があっても語送りで欄があふれない", () => {
    const chars = [..."aaa bbbb   " + "ddd eeeeeeeeeeeeeee"];
    expect(chars).toHaveLength(LEN);
    const w = wordWrap(chars, 0, 1, ROW_ENDS, COLS);
    expect(w?.chars.join("")).toBe(chars.join(""));
  });
  it("空白の左の NUL は詰め物として捨てる（`a` NUL 空白 `b` は `a b`）", () => {
    const chars = ["a", NUL, B, "b", ...Array<string>(LEN - 4).fill(NUL)];
    expect(wordWrap(chars, 0, 4, ROW_ENDS, COLS)?.chars.join("")).toBe("a b" + NUL.repeat(LEN - 3));
  });
  it("字に挟まれた NUL の連なりは 1 つに畳む（`a` NUL NUL `b` は `a` NUL `b`）", () => {
    const chars = ["a", NUL, NUL, "b", ...Array<string>(LEN - 4).fill(NUL)];
    expect(wordWrap(chars, 0, 4, ROW_ENDS, COLS)?.chars.join("")).toBe("a" + NUL + "b" + NUL.repeat(LEN - 3));
  });
  it("カーソルがちょうど NUL を入れる桁にあるときは動かさない（NUL はカーソルの後ろに入る）", () => {
    const chars = [..."aaa bbbb cc", ...Array<string>(LEN - 11).fill(NUL)];
    // 11 桁目までで行末。`cc` が次の行へ送られ、NUL は 9・10 桁目に入る。カーソルが 9 なら NUL より前
    expect(wordWrap(chars, 10, 9, ROW_ENDS, COLS)?.cursor).toBe(9);
    // カーソルが 10（NUL の 1 つ目の後ろ）なら、カーソルの手前に入った 2 つぶん進む（2 つ目の NUL の桁 10 は、1 つ目で進んだカーソル 11 より前）
    expect(wordWrap(chars, 10, 10, ROW_ENDS, COLS)?.cursor).toBe(12);
  });
  it("行より長い語は、その行の頭までしか戻らない（前の行の空白まで戻って押し出さない）", () => {
    // 3 行の欄（1 行目 11 桁・2 行目 80 桁・3 行目 10 桁）。2 行目が空白の無い 80 字
    const len = 101;
    const chars = [..."aaa bbbb   ", ..."x".repeat(80), "y", ...Array<string>(len - 92).fill(NUL)];
    const w = wordWrap(chars, 91, 92, [10, 90, 100], COLS);
    expect(w?.chars.join("")).toBe(chars.join(""));
  });
  // ---- 以降は従来の端 ----
  it("行末にちょうど収まる語も送る（`aabbbb cccc` の `cccc` は行末＝11 桁目に収まるが次の行）", () => {
    const s = typed(fresh(), "aabbbb cccc");
    expect(wire(s)).toBe("818182828282400000000083838383");
  });
  it("語送りで欄に収まらなくなるときは何も変えない", () => {
    // 6 行目まで語が詰まっていて、これ以上押し出せない欄
    const chars = [..."aaaaaaaaa b" + "cccccccccccccccccc" + "d"];
    expect(wordWrap(chars, 9, 10, ROW_ENDS, COLS)).toBeUndefined();
  });
  it("Erase EOF は NUL で消す（語送りは掛けない）", () => {
    const s = eraseToEnd(at(typed(fresh(), "aaa bbbb"), 3));
    expect(wire(s)).toBe("818181");
  });
});
