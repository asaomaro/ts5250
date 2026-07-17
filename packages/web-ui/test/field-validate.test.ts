import { describe, it, expect } from "vitest";
import {
  acceptsChar,
  dbcsByteLength,
  columnView,
  dbcsViewLayout,
  alignDbcsWrap,
  isFullWidth
} from "../src/composables/fieldValidate.js";
import type { Field } from "@as400web/core";

function fld(o: Partial<Field>): Field {
  return { index: 1, row: 1, col: 1, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...o };
}

describe("acceptsChar フィールド型ごとの入力ルール", () => {
  it("数値: 数字・小数点・符号を許可し、英字と全角を拒否", () => {
    const f = fld({ numeric: true });
    for (const ch of ["0", "9", ".", "-", "+"]) expect(acceptsChar(f, ch)).toBe(true);
    for (const ch of ["A", "z"]) expect(acceptsChar(f, ch)).toBe(false); // 英字不可
    expect(acceptsChar(f, "日")).toBe(false); // 全角不可
  });

  it("A（SBCS/英数字）: 半角を許可し、DBCS(全角)を拒否", () => {
    const f = fld({}); // dbcsType 無し = SBCS
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "1")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(false); // ← A は DBCS を入力できない
    expect(acceptsChar(f, "あ")).toBe(false);
  });

  it("O（open）: SBCS も DBCS も許可", () => {
    const f = fld({ dbcsType: "open" });
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(true);
  });

  it("J（pure DBCS）: DBCS を許可し、SBCS を拒否", () => {
    const f = fld({ dbcsType: "pure" });
    expect(acceptsChar(f, "日")).toBe(true);
    expect(acceptsChar(f, "あ")).toBe(true);
    expect(acceptsChar(f, "A")).toBe(false); // ← J は SBCS を入力できない
    expect(acceptsChar(f, "1")).toBe(false);
  });

  it("either: SBCS も DBCS も許可", () => {
    const f = fld({ dbcsType: "either" });
    expect(acceptsChar(f, "A")).toBe(true);
    expect(acceptsChar(f, "日")).toBe(true);
  });
});

describe("dbcsByteLength 送信バイト長の見積り（SO/SI・DBCS 2 バイト込み）", () => {
  it("SBCS は 1 文字 1 バイト", () => {
    expect(dbcsByteLength("")).toBe(0);
    expect(dbcsByteLength("ABC")).toBe(3);
  });

  it("DBCS 連続ランは SO+2×N+SI（SO/SI を 1 ペア共有）", () => {
    expect(dbcsByteLength("あ")).toBe(4); // SO+2+SI
    expect(dbcsByteLength("あい")).toBe(6); // SO+4+SI（1 ペア共有）
    expect(dbcsByteLength("あいう")).toBe(8); // SO+6+SI
  });

  it("SBCS↔DBCS 切替ごとに SO/SI が入る", () => {
    expect(dbcsByteLength("AあB")).toBe(6); // A + SO+2 + SI+B
    expect(dbcsByteLength("あAい")).toBe(9); // SO+2+SI + A + SO+2+SI
  });

  it("例: 表示 ABC[SO]あ[SI]DEF ＝ データ ABC あDEF は 11 バイト", () => {
    // A B C 空白 =4, あ=SO+2, D で SI, DEF=3 → 4 + 3 + 1 + 3 = 11
    expect(dbcsByteLength("ABC あDEF")).toBe(11);
  });
});

describe("columnView 表示用の SO/SI スペース挿入", () => {
  it("SBCS のみは変化しない", () => {
    expect(columnView("ABC")).toBe("ABC");
    expect(columnView("")).toBe("");
  });

  it("DBCS ランの前後に SO/SI スペースを挿入（連続は 1 ペア）", () => {
    expect(columnView("あ")).toBe(" あ "); // SO+あ+SI
    expect(columnView("あい")).toBe(" あい "); // SO+あい+SI（共有）
  });

  it("例: データ ABC あDEF → 表示 ABC[SO]あ[SI]DEF（SO/SI が半角スペース）", () => {
    expect(columnView("ABC あDEF")).toBe("ABC  あ DEF"); // 実スペース+SO / SI
  });

  it("SO/SI マーク指定（showShiftMarks の { }）で SO=左・SI=右に置換", () => {
    expect(columnView("Aあ", "{", "}")).toBe("A{あ}");
    expect(columnView("あい", "{", "}")).toBe("{あい}");
    expect(columnView("ABC", "{", "}")).toBe("ABC"); // DBCS 無しは不変
  });
});

describe("dbcsViewLayout 論理⇔列ビューのカーソルマッピング", () => {
  it("論理カーソルは SO/SI をスキップした列位置に対応する", () => {
    const { view, caretOf } = dbcsViewLayout("Aあ"); // 列ビュー "A あ "（A, SO, あ, SI）
    expect(view).toBe("A あ ");
    expect(caretOf(0)).toBe(0); // A の前
    expect(caretOf(1)).toBe(2); // あ の前（SO の桁=1 をスキップ）
    expect(caretOf(2)).toBe(3); // 末尾（あ の直後・末尾 SI の前。SI を飛び越えない）
  });

  it("列ビューの caret を論理カーソルへスナップ（往復）", () => {
    const { logicalOf } = dbcsViewLayout("Aあ");
    expect(logicalOf(0)).toBe(0);
    expect(logicalOf(2)).toBe(1); // あ 桁 → 論理 1
    expect(logicalOf(3)).toBe(2); // 末尾（あ の直後）
  });

  it("columnsBefore は DBCS を 2 桁として数える", () => {
    const { columnsBefore } = dbcsViewLayout("Aあ"); // view="A あ "（A, SO, あ, SI）
    expect(columnsBefore(2)).toBe(2); // "A "(SO) までで 1+1=2 桁
    expect(columnsBefore(3)).toBe(4); // "A あ" までで 1+1+2=4 桁（あ の直後）
    expect(columnsBefore(4)).toBe(5); // "A あ "（末尾 SI 込み）で 5 桁
  });
});

describe("alignDbcsWrap: 全角が行の折返し境界に割れないよう半角スペースを詰める", () => {
  // 5250 は 1 画面桁 = 1 バイト。全角の 2 バイトが行末と次行頭に割れると描画できないため、
  // 手前へ半角スペースを入れて次行へ送る。スペースは送信値そのものへ入れる（codec が SO/SI を組み直す）。
  const cols = (chars: string[]) => dbcsByteLength(chars.join(""));

  it("境界が無ければ何もしない", () => {
    expect(alignDbcsWrap([..."Aあい"], []).chars.join("")).toBe("Aあい");
  });

  it("ラン開始の全角が境界をまたぐなら、SO の手前へスペースを 1 つ詰める", () => {
    // 素の "AAあ" は A=0, A=1, SO=2, あ=3-4 → 境界 4 が あ の途中に落ちる
    const r = alignDbcsWrap([..."AAあ"], [4]);
    expect(r.chars.join("")).toBe("AA あ"); // ' '=桁2, SO=桁3, あ=桁4-5 ＝ 次行の先頭から
    expect(cols(r.chars)).toBe(7); // A A ' ' SO あ SI
  });

  it("ラン継続中に境界をまたぐなら、いったん SI で閉じてから次行で開き直す", () => {
    // 素の "あい" は SO=0, あ=1-2, い=3-4 → 境界 4 が い の途中に落ちる
    const r = alignDbcsWrap([..."あい"], [4]);
    // 論理値へ半角スペースが入る＝codec が SO あ SI ' ' SO い SI と組み直す
    expect(r.chars.join("")).toBe("あ い");
    // SO=0 あ=1-2 SI=3 ' '=4 SO=5 い=6-7 SI=8。い は境界 4 より右に収まる
    expect(cols(r.chars)).toBe(9);
  });

  it("桁揃えで手前へ入ったスペースのぶん、論理カーソルも右へずらす", () => {
    // "AAあ" は index 2（＝あ の手前）にスペースが入る。
    // あ の直後（index 3）に居たカーソルは、あ を追って 4 へ動く
    expect(alignDbcsWrap([..."AAあ"], [4], 3).cursor).toBe(4);
    // 挿入位置と同じか手前のカーソルは動かさない（入ったスペースの手前に留まる）
    expect(alignDbcsWrap([..."AAあ"], [4], 2).cursor).toBe(2);
    expect(alignDbcsWrap([..."AAあ"], [4], 1).cursor).toBe(1);
  });

  it("桁揃え済みの値をもう一度掛けても変わらない（冪等）", () => {
    const once = alignDbcsWrap([..."AAあい"], [4]).chars;
    expect(alignDbcsWrap(once, [4]).chars).toEqual(once);
  });

  it("桁揃え後はどの全角も境界をまたがない", () => {
    for (const src of ["あ", "Aあ", "AAあ", "AAAあ", "あいうえお", "AあAあA", "ABCDEFあいう"]) {
      const chars = alignDbcsWrap([...src], [4, 9]).chars;
      let col = 0;
      let inDbcs = false;
      for (const ch of chars) {
        const wide = isFullWidth(ch);
        if (wide !== inDbcs) col += 1; // SO / SI
        inDbcs = wide;
        if (wide) expect([4, 9].some((b) => col < b && b < col + 2)).toBe(false);
        col += wide ? 2 : 1;
      }
    }
  });
});
