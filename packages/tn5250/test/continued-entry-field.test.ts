import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER, AID } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

/**
 * **継続入力フィールド（Continued Entry Field）。**
 *
 * DDS の `EDTMSK` を正しい向き（`&` は「保護する桁」なので区切り `/` の桁に置く）で書くと、
 * ホストは 1 つの数値欄を**複数の入力区間に分解**し、区間の間の編集文字を保護された静的文字として送る。
 * 区間には FCW `0x86xx` が付く（下位 1=先頭 / 3=中間 / 2=最終）。
 *
 * 【実機で採った SF オーダーの生バイト】実機 / IBM i 7.3・`ASAOLIB/MSKTST`（`ADDLIBLE` 後 `CALL ASAOLIB/MSKCL`）
 *
 * ```
 * A6Y  EDTCDE(Y) + EDTMSK('  &  &  ')             → 2+2+2 の 3 区間
 *   (3,23) len=2 ffw=0x4300 fcw=[8601]   1d 43 00 86 01 24 00 02
 *   (3,26) len=2 ffw=0x4300 fcw=[8603]   1d 43 00 86 03 24 00 02
 *   (3,29) len=2 ffw=0x4300 fcw=[8602]   1d 43 00 86 02 24 00 02
 * A8W  EDTWRD('0   /  /  ') + EDTMSK('    &  &  ') → 4+2+2 の 3 区間（fcw 8601/8603/8602）
 * N8W  EDTMSK なし                                 → 1 欄（len=10・FCW なし）
 * ```
 *
 * 【直す前に実機で起きていたこと】区間を独立した欄として送っていたため:
 *
 * | 打った内容 | ホストの理解 |
 * |---|---|
 * | 区間1=`2026` 区間2=`12` 区間3=`31` | `000/00/31`（年と月が消える） |
 * | 中間区間だけ `07` | `000/00/07`（最終区間に入る） |
 *
 * 【正解】GNU tn5250 `session.c` `tn5250_session_send_field`:
 * > We also must only send back data for the first subfield of a continuous field.
 * > All subfields are treated as one and are sent as part of the first subfield.
 *
 * MDT も先頭区間だけに立てる（tn5250 `field.c` tn5250_field_set_mdt /
 * tn5250j `ScreenField.setMDT`）。
 */

/** 実測どおりの SF（FCW 付き）を 1 つ書く */
function sf(row: number, col: number, len: number, fcw: number | undefined, ffw = 0x4300): number[] {
  return [
    ORDER.SBA, row, col,
    ORDER.SF, (ffw >> 8) & 0xff, ffw & 0xff,
    ...(fcw !== undefined ? [(fcw >> 8) & 0xff, fcw & 0xff] : []),
    0x24, (len >> 8) & 0xff, len & 0xff
  ];
}

function applied(...orders: number[][]): ScreenBuffer {
  const b = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ...orders.flat()]),
    b,
    codec
  );
  return b;
}

/** 実機 A8W と同じ 4+2+2 の 3 区間（5 行目） */
function a8w(): ScreenBuffer {
  return applied(sf(5, 23, 4, 0x8601), sf(5, 28, 2, 0x8603), sf(5, 31, 2, 0x8602));
}

/** 応答から `SBA 行 桁 + データ` の並びを取り出す */
function sent(b: ScreenBuffer): { row: number; col: number; text: string }[] {
  const { record } = buildReadMdtResponse(b, codec, AID.ENTER, { row: 5, col: 24 });
  const d = [...parseRecord(record).data].slice(3); // カーソル行・桁・AID を除く
  const out: { row: number; col: number; text: string }[] = [];
  let i = 0;
  while (i < d.length) {
    expect(d[i]).toBe(ORDER.SBA);
    const row = d[i + 1]!;
    const col = d[i + 2]!;
    i += 3;
    const start = i;
    while (i < d.length && d[i] !== ORDER.SBA) i++;
    out.push({ row, col, text: codec.decode(Uint8Array.from(d.slice(start, i))) });
  }
  return out;
}

describe("継続入力フィールドの受信（FCW 0x86xx）", () => {
  it("実測のバイト列（A6Y の 2+2+2）が 3 欄になり first/middle/last が付く", () => {
    // 実機の生バイトをそのまま流す: 1d 43 00 86 01 24 00 02 …
    const b = applied(sf(3, 23, 2, 0x8601), sf(3, 26, 2, 0x8603), sf(3, 29, 2, 0x8602));
    const fields = b.snapshot("s", false).fields;
    expect(fields).toHaveLength(3);
    expect(fields.map((f) => [f.row, f.col, f.length, f.continued])).toEqual([
      [3, 24, 2, "first"],
      [3, 27, 2, "middle"],
      [3, 30, 2, "last"]
    ]);
  });

  it("**0x8680（ワードラップ）は継続と誤認しない**", () => {
    // GNU tn5250 の StartOfField は 0x8680 を wordwrap として別に扱う。
    // マスク判定（`fcw1 == 0x86`）にすると誤認し、送信で無関係な欄まで畳んでしまう
    const b = applied(sf(5, 23, 10, 0x8680));
    expect(b.snapshot("s", false).fields[0]?.continued).toBeUndefined();
  });

  it("FCW の無い欄（EDTMSK なしの N8W）は 1 欄のまま continued が付かない（回帰）", () => {
    const b = applied(sf(7, 23, 10, undefined));
    const fields = b.snapshot("s", false).fields;
    expect(fields).toHaveLength(1);
    expect(fields[0]?.length).toBe(10);
    expect(fields[0]?.continued).toBeUndefined();
  });
});

describe("継続入力フィールドの送信（先頭区間に連結）", () => {
  it("3 区間に打つと**先頭区間の位置に連結値が 1 つ**だけ載る", () => {
    const b = a8w();
    b.setFieldValue(b.fieldByIndex(1), "2026");
    b.setFieldValue(b.fieldByIndex(2), "12");
    b.setFieldValue(b.fieldByIndex(3), "31");
    // 直す前は `SBA(5,24)+"2026" / SBA(5,29)+"12" / SBA(5,32)+"31"` の 3 つを送っており、
    // ホストは最後の区間だけを見て `000/00/31` と理解していた
    expect(sent(b)).toEqual([{ row: 5, col: 24, text: "20261231" }]);
  });

  it("中間区間だけ変えても先頭区間の位置に**全区間の連結値**が載る", () => {
    const b = a8w();
    b.setFieldValue(b.fieldByIndex(1), "2026");
    b.setFieldValue(b.fieldByIndex(2), "12");
    b.setFieldValue(b.fieldByIndex(3), "31");
    b.resetMdt(); // ホストが受け取り直した後の状態
    b.setFieldValue(b.fieldByIndex(2), "07"); // 月だけ打ち直す
    expect(sent(b)).toEqual([{ row: 5, col: 24, text: "20260731" }]);
  });

  it("MDT は先頭区間だけに立つ（中間を編集しても）", () => {
    const b = a8w();
    b.setFieldValue(b.fieldByIndex(2), "07");
    expect(b.snapshot("s", false).fields.map((f) => f.mdt)).toEqual([true, false, false]);
  });

  it("区間の途中までしか埋まっていなくても**桁を詰めない**", () => {
    // 区間ごとに末尾空白を落として連結すると `2026` + `1` + `31` = `2026131` に詰まり、
    // 桁がずれてホストへ届く。連結し終えた最後にだけ落とす（tn5250 の Strip trailing NULs）
    const b = a8w();
    b.setFieldValue(b.fieldByIndex(1), "2026");
    b.setFieldValue(b.fieldByIndex(2), "1");
    expect(sent(b)).toEqual([{ row: 5, col: 24, text: "20261" }]);
  });

  it("継続でない欄が混ざっても畳まれない（回帰）", () => {
    const b = applied(
      sf(5, 23, 4, 0x8601),
      sf(5, 28, 2, 0x8603),
      sf(5, 31, 2, 0x8602),
      sf(7, 23, 10, undefined)
    );
    b.setFieldValue(b.fieldByIndex(1), "2026");
    b.setFieldValue(b.fieldByIndex(3), "31");
    b.setFieldValue(b.fieldByIndex(4), "20261231");
    expect(sent(b)).toEqual([
      { row: 5, col: 24, text: "2026  31" }, // 中間は空のまま桁を保つ
      { row: 7, col: 24, text: "20261231" }
    ]);
  });

  it("隣り合う 2 つの継続欄は別々に畳む", () => {
    // 先頭（0x8601）を見つけたらそこで並びを切る。切らないと 2 つの日付が 1 つに繋がる
    const b = applied(
      sf(5, 23, 4, 0x8601),
      sf(5, 28, 2, 0x8602),
      sf(6, 23, 4, 0x8601),
      sf(6, 28, 2, 0x8602)
    );
    b.setFieldValue(b.fieldByIndex(2), "12");
    b.setFieldValue(b.fieldByIndex(4), "34");
    expect(sent(b)).toEqual([
      { row: 5, col: 24, text: "    12" },
      { row: 6, col: 24, text: "    34" }
    ]);
  });
});
