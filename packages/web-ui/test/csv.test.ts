import { describe, it, expect } from "vitest";
import { toCsv, csvBlob, csvFileName } from "../src/csv.js";

/**
 * CSV 生成。**Excel で開かれる前提**の細部（BOM・CRLF）を固定する。
 * ここが緩むと DBCS を含むデータが化ける。
 */
describe("toCsv", () => {
  it("ヘッダーと行を CRLF で連ねる", () => {
    const csv = toCsv(["A", "B"], [{ A: "1", B: "2" }]);
    expect(csv).toBe("A,B\r\n1,2");
  });

  it("列の順序は columns に従う（行オブジェクトのキー順ではない）", () => {
    const csv = toCsv(["B", "A"], [{ A: "1", B: "2" }]);
    expect(csv).toBe("B,A\r\n2,1");
  });

  it("null と undefined は空欄にする", () => {
    expect(toCsv(["A", "B"], [{ A: null, B: undefined }])).toBe("A,B\r\n,");
  });

  it("カンマ・引用符・改行を含む値をクォートしエスケープする（RFC 4180）", () => {
    const csv = toCsv(["A"], [{ A: 'x,y' }, { A: 'a"b' }, { A: "1\n2" }]);
    expect(csv).toBe('A\r\n"x,y"\r\n"a""b"\r\n"1\n2"');
  });

  it("クォートが不要な値は囲まない", () => {
    expect(toCsv(["A"], [{ A: "plain" }])).toBe("A\r\nplain");
  });

  it("結果が 0 行でもヘッダーは出す", () => {
    expect(toCsv(["A", "B"], [])).toBe("A,B");
  });

  it("DBCS をそのまま通す", () => {
    expect(toCsv(["名前"], [{ 名前: "日本語" }])).toBe("名前\r\n日本語");
  });
});

/**
 * LOB の CSV 表現。**どの状態でも空欄にしない**——空欄は SQL の NULL と混ざる。
 * 「取りに行っていない」と「取りに行って失敗した」は別物なので書き分ける
 * （同じ `(LOB)` だと、取得を指定して落とした CSV が指定しなかった CSV と見分けられない）。
 */
describe("toCsv の LOB", () => {
  const lob = (over: Record<string, unknown>) => ({ kind: "lob", locator: 7, maxSize: 1024, ...over });

  it("取得済みなら中身を出す", () => {
    expect(toCsv(["A"], [{ A: lob({ value: "本文", byteLength: 6 }) }])).toBe("A\r\n本文");
  });

  it("取得済みの中身もエスケープする（RFC 4180）", () => {
    expect(toCsv(["A"], [{ A: lob({ value: "x,y" }) }])).toBe('A\r\n"x,y"');
  });

  it("上限で打ち切ったなら画面と同じ印を付ける（無印だと完全な値に見える）", () => {
    expect(toCsv(["A"], [{ A: lob({ value: "先頭だけ", unavailable: "too-large" }) }])).toBe(
      "A\r\n先頭だけ…（以降省略）"
    );
  });

  it("打ち切りの印を付けても本文は捨てない・囲みは印まで含める", () => {
    // 本文に `,` があるので RFC 4180 のクォートが要る。**印まで 1 つのフィールドに収める**
    expect(toCsv(["A"], [{ A: lob({ value: "x,y", unavailable: "too-large" }) }])).toBe(
      'A\r\n"x,y…（以降省略）"'
    );
  });

  it("取りに行っていないなら (LOB)", () => {
    expect(toCsv(["A"], [{ A: lob({ unavailable: "not-requested" }) }])).toBe("A\r\n(LOB)");
  });

  it("取りに行って失敗したなら (LOB: 取得失敗)（未要求と区別する）", () => {
    expect(toCsv(["A"], [{ A: lob({ unavailable: "failed" }) }])).toBe("A\r\n(LOB: 取得失敗)");
  });

  it("どの状態でも空欄にしない（NULL と混ざるため）", () => {
    const csv = toCsv(
      ["N", "A", "B"],
      [{ N: null, A: lob({ unavailable: "not-requested" }), B: lob({ unavailable: "failed" }) }]
    );
    expect(csv).toBe("N,A,B\r\n,(LOB),(LOB: 取得失敗)");
  });
});

describe("csvBlob", () => {
  it("UTF-8 BOM を先頭に付ける（Excel が UTF-8 と認識するのに必要）", async () => {
    const blob = csvBlob("A\r\n1");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe("A\r\n1");
  });

  it("MIME に charset を含める", () => {
    expect(csvBlob("A").type).toBe("text/csv;charset=utf-8");
  });
});

describe("csvFileName", () => {
  it("日時から一意な名前を作る", () => {
    expect(csvFileName(new Date(2026, 6, 19, 13, 45, 1))).toBe("query-20260719-134501.csv");
  });

  it("1 桁の月日時分秒をゼロ埋めする", () => {
    expect(csvFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("query-20260102-030405.csv");
  });
});

describe("isPaneTab", () => {
  it("セッションを持たないタブを識別する", async () => {
    const { isPaneTab } = await import("../src/paneLabels.js");
    expect(isPaneTab("admin:users")).toBe(true);
    expect(isPaneTab("list:jobs")).toBe(true);
    expect(isPaneTab("sql:query")).toBe(true);
  });

  it("セッション ID は識別しない（切断処理へ流すべきもの）", async () => {
    const { isPaneTab } = await import("../src/paneLabels.js");
    expect(isPaneTab("3f2a1b9c-0000-4444-8888-aaaaaaaaaaaa")).toBe(false);
    expect(isPaneTab(undefined)).toBe(false);
    expect(isPaneTab("")).toBe(false);
  });

  it("表示名がすべてのプレフィックスに用意されている", async () => {
    const { PANE_LABELS, PANE_PREFIXES } = await import("../src/paneLabels.js");
    for (const p of PANE_PREFIXES) {
      expect(Object.keys(PANE_LABELS).some((k) => k.startsWith(p))).toBe(true);
    }
  });
});
