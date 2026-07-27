import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { buildReadMdtResponse } from "../src/protocol/read-response.js";
import { codecForCcsid } from "@as400web/ebcdic";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

const codec = codecForCcsid(930);
const e = (t: string): number[] => [...codec.encode(t).bytes];

const ATTR = 0x28; // 赤

/**
 * **DBCS 欄（SEU のソース欄）の埋め込み属性が編集・送信で失われないこと。**
 *
 * `e9ab19e` は「制御コードより前を編集すると属性が元の桁に残り、送信でソースが壊れ得る」
 * 問題を**センチネル方式**で直したが、`fieldValue` の DBCS 分岐だけが
 * 「属性を空白で返す」ままだった。その結果 DBCS 欄では:
 *
 *   1. 値に属性が載らない
 *   2. 編集値を `setFieldValue` で書き戻すと**属性セルがただの空白で潰される**
 *   3. 送信データからも制御コードが落ちる（＝**利用者のソースが書き換わる**）
 *
 * SEU のソース行は日本語を含まない行が多く、その多数派が
 * 「DBCS 宣言はあるが DBCS 構造は持たない」＝この経路に落ちる。
 */

/** DBCS 欄（FCW 0x8280 = ideographic-open）に本文を書いた画面を作る */
function dbcsFieldWith(body: number[], length = 0x14): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 1, 5,
      ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x20, 0x00, length,
      ...body
    ]),
    buf,
    codec,
    () => {}
  );
  return buf;
}

/**
 * **欄の中**の埋め込み属性セルの桁を返す（1 始まり・無ければ 0）。
 * 5 桁目は SF が置いた欄自身の属性なので、6 桁目以降だけを見る。
 */
function attrCol(buf: ScreenBuffer): number {
  const row = buf.snapshot("t", false).cells[0]!;
  for (let c = 5; c < row.length; c++) if (row[c]!.kind === "attr") return c + 1;
  return 0;
}

describe("DBCS 欄の埋め込み属性（編集・送信で失わない）", () => {
  it("値に属性がセンチネルとして載る", () => {
    const buf = dbcsFieldWith([...e("ABC"), ATTR, ...e("DEF")]);
    const v = buf.fieldValue(buf.fieldByIndex(1));
    const sentinels = [...v].filter((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0xe020 && cp <= 0xe03f;
    });
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.codePointAt(0)! - 0xe000).toBe(ATTR);
  });

  it("制御コードに触れない編集を書き戻しても属性セルが残る", () => {
    const buf = dbcsFieldWith([...e("ABC"), ATTR, ...e("DEF")]);
    const f = buf.fieldByIndex(1);
    expect(attrCol(buf)).toBe(9); // 属性は 9 桁目（欄は 6 桁目から）

    // 利用者の操作: 制御コード桁は触らず B→X（長さは変えない）
    const edited = [...buf.fieldValue(f)].map((ch, i) => (i === 1 ? "X" : ch)).join("");
    buf.setFieldValue(f, edited, true);

    expect(attrCol(buf)).toBe(9); // **属性が同じ桁に残る**
    const row = buf.snapshot("t", false).cells[0]!;
    expect(row[5]!.char).toBe("A");
    expect(row[6]!.char).toBe("X");
    expect(row[9]!.color).toBe("red"); // 属性の効果（赤）も生きている
  });

  it("属性より前を 1 文字削ると、属性の桁が 1 つ左へ動く", () => {
    const buf = dbcsFieldWith([...e("ABC"), ATTR, ...e("DEF")]);
    const f = buf.fieldByIndex(1);
    const v = buf.fieldValue(f);
    buf.setFieldValue(f, v.slice(1), true); // 先頭 A を削除

    expect(attrCol(buf)).toBe(8); // 9 → 8 桁目へ追従
  });

  it("送信データに属性バイトがそのまま載る", () => {
    const buf = dbcsFieldWith([...e("ABC"), ATTR, ...e("DEF")]);
    const f = buf.fieldByIndex(1);
    buf.setFieldValue(f, buf.fieldValue(f), true); // 編集扱いにして構造を落とす
    const { record } = buildReadMdtResponse(buf, codec, 0x00);
    expect([...record]).toContain(ATTR);
  });

  it("DBCS 構造つきの未編集欄（SO/SI・全角あり）の送信バイトは変わらない", () => {
    // ここは `dbcsRawFieldValue` の経路。**この修正で変えてはいけない**（回帰の砦）。
    // `setFieldValue` を通すと構造が落ちてしまうので、MDT だけ直接立てて送信対象にする。
    const buf = dbcsFieldWith([...e("AB"), ATTR, ...e("設CD")]);
    buf.fieldByIndex(1).mdt = true;
    const { record } = buildReadMdtResponse(buf, codec, 0x00);
    const bytes = [...record];
    expect(bytes).toContain(ATTR);
    expect(bytes).toContain(0x0e); // SO
    expect(bytes).toContain(0x0f); // SI
  });
});
