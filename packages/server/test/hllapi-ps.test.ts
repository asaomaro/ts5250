import { describe, it, expect } from "vitest";
import {
  posToRowCol,
  rowColToPos,
  psLength,
  psBytes,
  psSlice,
  psSearch,
  fieldAt,
  fieldStart,
  nextInputField,
  prevInputField,
  fieldBytes
} from "../src/hllapi-ps.js";
import { encodeCp932, decodeCp932 } from "../src/hllapi-cp932.js";
import type { Cell, CellKind, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * PS の位置換算と走査。
 *
 * HLLAPI は画面を **1 起点の通し番号**で指し、**1 位置 = 1 バイト**。
 * 全角は画面上で 2 桁を占め、CP932 でも 2 バイトなので一致する。
 * ここがずれると既存資産の桁計算が全部狂うので、境界と DBCS を固定する。
 */
const cell = (char: string, kind: CellKind = "sbcs"): Cell => ({
  char,
  kind,
  color: "green",
  reverse: false,
  underline: false,
  blink: false,
  columnSeparator: false,
  nonDisplay: false
});

/** 文字列から画面を作る（全角は自動で lead ＋ tail の 2 セルにする） */
function snap(text: string[], fields: Field[] = [], rows = 24, cols = 80): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: Cell[] = [];
    for (const ch of text[r] ?? "") {
      if (encodeCp932(ch).bytes.length === 2) {
        line.push(cell(ch, "dbcs-lead"), cell("", "dbcs-tail"));
      } else {
        line.push(cell(ch));
      }
    }
    while (line.length < cols) line.push(cell(" "));
    cells.push(line.slice(0, cols));
  }
  return {
    sessionId: "s",
    rows: rows as 24,
    cols: cols as 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields
  };
}

const field = (over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field => ({
  protected: false,
  hidden: false,
  numeric: false,
  ...over
});

/** 読みやすさのため、検証では CP932 を文字へ戻す */
const str = (b: Uint8Array | undefined): string | undefined => (b ? decodeCp932(b) : undefined);
const bytes = (s: string): Uint8Array => encodeCp932(s).bytes;

describe("位置換算（1 起点）", () => {
  it("先頭は 1、末尾は rows*cols", () => {
    const size = { rows: 24, cols: 80 };
    expect(rowColToPos(1, 1, size)).toBe(1);
    expect(rowColToPos(24, 80, size)).toBe(1920);
    expect(psLength(size)).toBe(1920);
  });

  it("行頭・行末の境界", () => {
    const size = { rows: 24, cols: 80 };
    expect(rowColToPos(2, 1, size)).toBe(81);
    expect(posToRowCol(81, size)).toEqual({ row: 2, col: 1 });
    expect(posToRowCol(80, size)).toEqual({ row: 1, col: 80 });
  });

  it("**範囲外は undefined**（呼び出し側が rc=7 に落とす）", () => {
    const size = { rows: 24, cols: 80 };
    expect(posToRowCol(0, size)).toBeUndefined();
    expect(posToRowCol(1921, size)).toBeUndefined();
    expect(rowColToPos(25, 1, size)).toBeUndefined();
    expect(rowColToPos(1, 81, size)).toBeUndefined();
  });

  it("27x132 の画面でも成り立つ", () => {
    const size = { rows: 27, cols: 132 };
    expect(psLength(size)).toBe(3564);
    expect(posToRowCol(133, size)).toEqual({ row: 2, col: 1 });
  });
});

describe("PS のバイト化", () => {
  it("長さはちょうど rows*cols バイト", () => {
    expect(psBytes(snap(["X"], [], 3, 5))).toHaveLength(15);
  });

  it("**改行を入れない**（固定長の連結。桁でずれない）", () => {
    expect(str(psBytes(snap(["AB", "CD"], [], 2, 4)))).toBe("AB  CD  ");
  });

  it("pos から length バイトを取れる", () => {
    const s = snap(["HELLO"], [], 1, 5);
    expect(str(psSlice(s, 1, 5))).toBe("HELLO");
    expect(str(psSlice(s, 3, 2))).toBe("LL");
  });

  it("末尾を越える分はそこまで（呼び出し側が rc=6 を添える）", () => {
    expect(str(psSlice(snap(["HELLO"], [], 1, 5), 4, 10))).toBe("LO");
  });

  it("範囲外の pos は undefined", () => {
    expect(psSlice(snap(["A"], [], 1, 1), 2, 1)).toBeUndefined();
  });
});

describe("全角（DBCS）", () => {
  // 「サイン」は 3 文字 = 6 桁 = 6 バイト
  const s = snap(["サイン"], [], 1, 10);

  it("**全角 1 文字が 2 バイト**（画面でも 2 桁）", () => {
    expect(psBytes(s)).toHaveLength(10);
    expect(str(psSlice(s, 1, 2))).toBe("サ");
    expect(str(psSlice(s, 3, 2))).toBe("イ");
  });

  it("**追従セルで空白を挟まない**（`サ イ ン` にならない）", () => {
    expect(str(psSlice(s, 1, 6))).toBe("サイン");
  });

  it("**日本語で検索できる**（バイトで比べるため）", () => {
    // 文字列で連結していた頃は `サ イ ン` になり、これが引けなかった
    expect(psSearch(s, bytes("サイン"))).toBe(1);
    expect(psSearch(s, bytes("イン"))).toBe(3);
  });

  it("全角と半角が混ざっても桁が合う", () => {
    const m = snap(["AサB"], [], 1, 6);
    expect(psBytes(m)).toHaveLength(6);
    expect(str(psSlice(m, 1, 4))).toBe("AサB");
    expect(psSearch(m, bytes("サ"))).toBe(2);
  });
});

describe("検索", () => {
  it("見つかった位置を 1 起点で返す", () => {
    expect(psSearch(snap(["  FIND ME"], [], 1, 10), bytes("FIND"))).toBe(3);
  });

  it("**行をまたいで見つかる**（連結しているため）", () => {
    expect(psSearch(snap(["AB", "CD"], [], 2, 2), bytes("BC"))).toBe(2);
  });

  it("from より後ろだけ探す", () => {
    expect(psSearch(snap(["XAX"], [], 1, 3), bytes("X"), 2)).toBe(3);
  });

  it("後方検索", () => {
    expect(psSearch(snap(["XAX"], [], 1, 3), bytes("X"), 3, true)).toBe(3);
  });

  it("無ければ undefined（呼び出し側が rc=7）", () => {
    expect(psSearch(snap(["ABC"], [], 1, 3), bytes("ZZ"))).toBeUndefined();
  });

  it("空は探さない", () => {
    expect(psSearch(snap(["ABC"], [], 1, 3), new Uint8Array(0))).toBeUndefined();
  });
});

describe("欄", () => {
  // "  ABC  XY" → 1=' ' 2=' ' 3='A' 4='B' 5='C' 6=' ' 7=' ' 8='X' 9='Y'
  const f1 = field({ index: 1, row: 1, col: 3, length: 3 });
  const f2 = field({ index: 2, row: 1, col: 8, length: 2, protected: true });
  const s = snap(["  ABC  XY"], [f1, f2], 1, 10);

  it("位置から欄を引ける（先頭と末尾を含む）", () => {
    expect(fieldAt(s, 3)?.index).toBe(1);
    expect(fieldAt(s, 5)?.index).toBe(1);
    expect(fieldAt(s, 2)).toBeUndefined();
    expect(fieldAt(s, 6)).toBeUndefined();
    expect(fieldAt(s, 8)?.index).toBe(2);
  });

  it("欄の先頭位置", () => {
    expect(fieldStart(f1, { rows: 1, cols: 10 })).toBe(3);
  });

  it("欄の値を切り出す", () => {
    expect(str(fieldBytes(s, f1))).toBe("ABC");
  });

  it("**hidden な欄は値を返さない**（パスワード欄）", () => {
    const h = field({ index: 3, row: 1, col: 1, length: 3, hidden: true });
    expect(fieldBytes(snap(["SEC"], [h], 1, 3), h)).toHaveLength(0);
  });

  it("次／前の入力欄（保護欄は飛ばす）", () => {
    const a = field({ index: 1, row: 1, col: 1, length: 2 });
    const p = field({ index: 2, row: 1, col: 4, length: 2, protected: true });
    const b = field({ index: 3, row: 1, col: 7, length: 2 });
    const t = snap(["ab  pp  cd"], [a, p, b], 1, 10);
    expect(nextInputField(t, 1)?.index).toBe(3);
    expect(prevInputField(t, 7)?.index).toBe(1);
  });

  it("**末尾まで無ければ先頭へ回り込む**（5250 の Tab と同じ）", () => {
    const a = field({ index: 1, row: 1, col: 1, length: 2 });
    const t = snap(["ab"], [a], 1, 2);
    expect(nextInputField(t, 2)?.index).toBe(1);
    expect(prevInputField(t, 1)?.index).toBe(1);
  });

  it("入力欄が無ければ undefined", () => {
    const p = field({ index: 1, row: 1, col: 1, length: 2, protected: true });
    expect(nextInputField(snap(["ab"], [p], 1, 2), 1)).toBeUndefined();
  });
});
