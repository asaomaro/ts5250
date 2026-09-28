import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

/**
 * **WTD の中のオーダーの誤りは否定応答にして打ち切る。CC2 は落とさない**（`20260927-wtd-order-sense`。ACS `DS5250.processWriteToDisplay`）。
 * 実機（社内機）で DSM に WTD（CC2＝メッセージ待ち・5 行に WTDERR）＋誤ったオーダーの 1 レコードを 5 通り出させ、ACS のコアは誤りの前の文字を書き・
 * メッセージ待ちを点け・否定応答を返した（ホストの次の出力が CPFA303。`scripts/acs-probe/wtd-order-sense.txt`・`scripts/verify-wtd-order-sense.mjs`）。
 * 以前は読み過ぎ・範囲外の例外でレコードの結果ごと捨て、応答もしなかった
 */
const codec = codecForCcsid(37);
/** WTD（CC2＝警報＋メッセージ待ち）で 5 行 2 桁に "AB"。この後ろに誤ったオーダーを置く（今の位置は 5 行 4 桁） */
const HEAD = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x05, ORDER.SBA, 5, 2, 0xc1, 0xc2];
/** 誤りの後ろの READ（読まれないこと＝打ち切りを見る） */
const READ = [ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00];
function run(order: number[], tail = READ) {
  const buf = new ScreenBuffer();
  const r = applyDataStream(Uint8Array.from([...HEAD, ...order, ...tail]), buf, codec, () => {});
  return { r, row5: buf.snapshot().cells[4]!.map((c) => c.char).join("").trim(), buf };
}

describe("WTD の中のオーダーの誤り", () => {
  const cases: [string, number[], number][] = [
    ["SBA の行が画面の外", [ORDER.SBA, 30, 2], 0x10050122],
    ["SBA の桁が画面の外", [ORDER.SBA, 5, 81], 0x10050122],
    ["SBA の行 0", [ORDER.SBA, 0, 5], 0x10050122],
    ["SBA の行 25（境界）", [ORDER.SBA, 25, 5], 0x10050122],
    ["SBA の桁 0（行 1 以外）", [ORDER.SBA, 5, 0], 0x10050122],
    ["IC が画面の外", [ORDER.IC, 30, 2], 0x10050122],
    ["MC が画面の外", [ORDER.MC, 5, 0], 0x10050122],
    ["RA が画面の外", [ORDER.RA, 30, 2, 0x5c], 0x10050122],
    ["RA の後戻り", [ORDER.RA, 5, 2, 0x5c], 0x10050123],
    ["RA の 1 桁の後戻り（境界）", [ORDER.RA, 5, 3, 0x5c], 0x10050123],
    ["EA の 1 桁の後戻り（境界）", [ORDER.EA, 5, 3, 0x02, 0x00], 0x10050123],
    ["EA が画面の外", [ORDER.EA, 30, 2, 0x02, 0x00], 0x10050122],
    ["EA の長さ 7", [ORDER.EA, 6, 2, 0x07, 0, 0, 0, 0, 0, 0], 0x1005012d],
    ["EA の長さ 1", [ORDER.EA, 6, 2, 0x01], 0x1005012d],
    ["EA の長さ 0", [ORDER.EA, 6, 2, 0x00], 0x1005012d],
    ["EA の長さ 6（境界）", [ORDER.EA, 6, 2, 0x06, 0, 0, 0, 0, 0], 0x1005012d],
    ["EA の後戻り", [ORDER.EA, 5, 2, 0x02, 0x00], 0x10050123],
    ["SOH の長さ 0", [ORDER.SOH, 0x00], 0x1005012b],
    ["SOH の長さ 8", [ORDER.SOH, 0x08, 0, 0, 0, 0, 0, 0, 0, 0], 0x1005012b]
  ];
  for (const [label, order, sense] of cases) {
    it(`${label}: 否定応答 0x${sense.toString(16)}・前の文字は書く・CC2 は効く・後ろは読まない`, () => {
      const { r, row5 } = run(order);
      expect(r.senseCode).toBe(sense);
      expect(row5).toBe("AB");
      expect(r.alarm).toBe(true);
      expect(r.messageWaiting).toBe(true);
      expect(r.readRequested).toBe(false);
    });
  }

  const shorts: [string, number[]][] = [
    ["SBA が 1 バイト", [ORDER.SBA, 5]],
    ["IC が 1 バイト", [ORDER.IC, 5]],
    ["MC が 1 バイト", [ORDER.MC, 5]],
    ["RA が 2 バイト", [ORDER.RA, 5, 9]],
    ["EA が 2 バイト", [ORDER.EA, 6, 2]],
    ["EA の属性タイプがレコードを越える", [ORDER.EA, 6, 2, 0x05, 0x00]],
    ["SOH の長さが無い（ACS はレコードの外を読む——当 PJ の決め）", [ORDER.SOH]],
    ["SOH の本体がレコードを越える", [ORDER.SOH, 0x07, 0x00]],
    ["TD の長さが 1 バイト", [ORDER.TD, 0x00]],
    ["TD の本体がレコードを越える", [ORDER.TD, 0x00, 0x05, 0xc1]],
    ["SF が 1 バイト", [ORDER.SF, 0x20]],
    ["WEA が 1 バイト", [ORDER.WEA, 0x01]]
  ];
  for (const [label, order] of shorts) {
    it(`${label}（レコードの終わり）: 否定応答 0x10050121・CC2 は効く`, () => {
      const { r, row5 } = run(order, []);
      expect(r.senseCode).toBe(0x10050121);
      expect(row5).toBe("AB");
      expect(r.alarm).toBe(true);
      expect(r.messageWaiting).toBe(true);
    });
  }

  it("ちょうどレコードの終わりに収まる EA・SOH・TD は否定応答にしない。1 バイト足りなければ 0x10050121", () => {
    for (const [ok, short] of [
      [[ORDER.EA, 6, 2, 0x02, 0x00], [ORDER.EA, 6, 2, 0x02]],
      [[ORDER.SOH, 0x03, 0, 0, 0], [ORDER.SOH, 0x03, 0, 0]],
      [[ORDER.TD, 0x00, 0x02, 0xc1, 0xc2], [ORDER.TD, 0x00, 0x02, 0xc1]]
    ]) {
      expect(run(ok!, []).r.senseCode, JSON.stringify(ok)).toBeUndefined();
      expect(run(short!, []).r.senseCode, JSON.stringify(short)).toBe(0x10050121);
    }
  });

  it("**長さが画面を超える TD は 0x10050121 でその場で戻り、CC2 も落とす**（ACS は TD の位置で WTD を抜け、次の ESC が無いとして戻る——原典の読み）", () => {
    const { r, row5 } = run([ORDER.TD, 0x07, 0x81, 0xc1]); // 1921 バイト（24×80＋1）
    expect(r.senseCode).toBe(0x10050121);
    expect(row5).toBe("AB");
    expect(r.alarm).toBe(false);
    expect(r.messageWaiting).toBeUndefined();
  });

  it("誤りの前の IC はカーソルに効く（ACS も WTD の終わりの確定は走る）", () => {
    const { r, buf } = run([ORDER.IC, 7, 3, ORDER.SBA, 30, 2]);
    expect(r.senseCode).toBe(0x10050122);
    expect(buf.cursorAddr).toBe(buf.addrOf(7, 3));
  });

  it("正しいオーダーなら否定応答にしない（境界: 24 行 80 桁・RA の同じ位置・EA の長さ 2〔タイプ 0x00 と 0xFF〕・SOH の長さ 1 と 7）", () => {
    for (const order of [
      [ORDER.SBA, 24, 80],
      [ORDER.RA, 5, 4, 0x5c],
      [ORDER.EA, 6, 2, 0x02, 0x00],
      [ORDER.EA, 6, 2, 0x02, 0xff],
      [ORDER.SOH, 0x01, 0x00],
      [ORDER.SOH, 0x07, 0, 0, 0, 0, 0, 0, 0]
    ]) {
      expect(run(order).r.senseCode, JSON.stringify(order)).toBeUndefined();
    }
  });

  it("SBA の行 1・桁 0 は否定応答にしない（ACS は番地 -1 として受ける）", () => {
    expect(run([ORDER.SBA, 1, 0]).r.senseCode).toBeUndefined();
  });
});

/**
 * **WTD の中の受理の残り**（`20260927-wtd-sense-rest`）。実機で DSM（WTDERR*）に 1 本の WTD を出させ、ACS のコアの画面・ワイヤ（tap）を採った:
 * SBA 1,0 → 入力欄の SF → AB は 1 行 1 桁の入力欄に入る・FFW 0xC000 は入力欄・24,75 から TD 10 バイトは 0x10050121（24 行は空のまま）・
 * 長さ 0 / 画面の末尾を越える / 長さ 5 の J / 先頭の無い継続欄の中間は 0x10050125（CC2 は効く・後ろの NEXT は書かない）
 */
describe("WTD の中の受理の残り（ACS の実測）", () => {
  const NEXT = [ORDER.SBA, 6, 2, 0xd5, 0xc5, 0xe7, 0xe3];
  const on = (order: number[], c = codec) => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...HEAD, ...order, ...NEXT]), buf, c, () => {});
    const row = (n: number) => buf.snapshot().cells[n - 1]!.map((x) => x.char).join("").trimEnd();
    return { r, buf, row, fields: buf.snapshot().fields.map((f) => [f.row, f.col, f.length]) };
  };

  it("**SBA 1,0 → SF → AB**: 欄は 1 行 1 桁から・AB が入る・後ろも書く", () => {
    const { r, row, fields } = on([ORDER.SBA, 1, 0, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x05, 0xc1, 0xc2]);
    expect(r.senseCode).toBeUndefined();
    expect(fields).toEqual([[1, 1, 5]]);
    expect(row(1)).toBe("AB");
    expect(row(6)).toBe(" NEXT");
  });

  it("**FFW 0xC000** は入力欄として受ける", () => {
    const { r, fields, row } = on([ORDER.SBA, 7, 9, ORDER.SF, 0xc0, 0x00, 0x24, 0x00, 0x05, 0xc1, 0xc2]);
    expect(r.senseCode).toBeUndefined();
    expect(fields).toEqual([[7, 10, 5]]);
    expect(row(6)).toBe(" NEXT");
  });

  it("**画面の末尾を越える TD** は 1 バイトも書かずに 0x10050121", () => {
    const { r, row } = on([ORDER.SBA, 24, 75, ORDER.TD, 0x00, 0x0a, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
    expect(r.senseCode).toBe(0x10050121);
    expect(r.messageWaiting, "打ち切りなので CC2 は効かない（ACS の実測 mw=false）").toBeUndefined();
    expect(row(24)).toBe("");
    expect(row(6)).toBe("");
  });

  for (const [label, order] of [
    ["長さ 0 の欄", [ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x00]],
    ["画面の末尾を越える欄", [ORDER.SBA, 24, 70, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x14]],
    ["長さ 5 の J 欄", [ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x00, 0x24, 0x00, 0x05]],
    ["先頭の無い継続欄の中間", [ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x86, 0x03, 0x24, 0x00, 0x05]]
  ] as const) {
    it(`**${label}** は 0x10050125（欄を入れず・後ろは書かない・CC2 は効く）`, () => {
      const { r, fields, row } = on([...order], codecForCcsid(930));
      expect(r.senseCode).toBe(0x10050125);
      expect(fields).toEqual([]);
      expect(row(6)).toBe("");
      expect(r.messageWaiting).toBe(true);
    });
  }

  it("継続欄は先頭 → 中間 → 最終の順なら受け、最終で順が戻る（次の画面の先頭を断らない）", () => {
    const buf = new ScreenBuffer();
    const seg = (row: number, fcw: number) => [ORDER.SBA, row, 9, ORDER.SF, 0x40, 0x00, 0x86, fcw, 0x24, 0x00, 0x05];
    const r1 = applyDataStream(Uint8Array.from([...HEAD, ...seg(7, 1), ...seg(8, 3), ...seg(9, 2)]), buf, codec, () => {});
    expect(r1.senseCode).toBeUndefined();
    const r2 = applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ...HEAD, ...seg(7, 1), ...seg(8, 2)]), buf, codec, () => {});
    expect(r2.senseCode).toBeUndefined();
  });

  it("**同じ位置に欄があれば検査せず FFW だけ書き換える**（長さ・FCW は前のまま。ACS `checkNewField` の `setFFW`）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([...HEAD, ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x24, 0x00, 0x06]), buf, codecForCcsid(930), () => {});
    const r = applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 7, 9, ORDER.SF, 0x48, 0x00, 0x24, 0x00, 0x00]), buf, codecForCcsid(930), () => {});
    expect(r.senseCode).toBeUndefined();
    const f = buf.orderedFields();
    expect(f).toHaveLength(1);
    expect([f[0]!.length, f[0]!.ffw, f[0]!.mdt, f[0]!.dbcsType]).toEqual([6, 0x4800, true, "open"]);
  });

  it("**後ろに始まる欄が先にあれば、新しい欄は入れず否定応答もしない**（昇順でない SF。ACS `checkNewField`）", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...HEAD,
      ORDER.SBA, 8, 9, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x05,
      ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x00 // 長さ 0 でも検査しない
    ]), buf, codec, () => {});
    expect(r.senseCode).toBeUndefined();
    expect(buf.orderedFields().map((f) => buf.rowColOf(f.startAddr))).toEqual([{ row: 8, col: 10 }]);
  });

  it("**SBA 1,0 の SF の属性は 1 行 1 桁から効く**（桁を占めない。ACS `setAttributeToPlanes` の `row1col0*`）・CLEAR UNIT で捨てる", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([...HEAD, ORDER.SBA, 1, 0, ORDER.SF, 0x40, 0x00, 0x24, 0x00, 0x05, 0xc1]), buf, codec, () => {});
    expect(buf.snapshot("s", false).cells[0]![0]).toMatchObject({ char: "A", underline: true });
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0xc1]), buf, codec, () => {});
    expect(buf.snapshot("s", false).cells[0]![0]).toMatchObject({ char: "A", underline: false });
  });

  it("**長さ 1 の O 欄は受ける**（ACS `checkFieldLength` は符号付き数値・J・E・G だけを断る）", () => {
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x82, 0x80, 0x24, 0x00, 0x01], codecForCcsid(930)).r.senseCode).toBeUndefined();
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x47, 0x00, 0x24, 0x00, 0x01]).r.senseCode).toBe(0x10050125);
  });

  it("**継続欄の nn が 01/02/03 以外・ワードラップと MF の組**は 0x10050125（ACS `isValidContField`・`checkFieldValidity`）", () => {
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x86, 0x04, 0x24, 0x00, 0x05]).r.senseCode).toBe(0x10050125);
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x07, 0x86, 0x80, 0x24, 0x00, 0x05]).r.senseCode).toBe(0x10050125);
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x86, 0x80, 0x24, 0x00, 0x05]).r.senseCode).toBeUndefined();
  });

  it("自己点検欄の 33 桁の上限", () => {
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0xb1, 0xa0, 0x24, 0x00, 0x22]).r.senseCode).toBe(0x10050125);
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0xb1, 0xa0, 0x24, 0x00, 0x21]).r.senseCode).toBeUndefined();
  });

  it("**SF の属性が 0x20〜0x3F の外**は 0x10050130（製品の ACS の検査。原典）", () => {
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x40, 0x00, 0x10, 0x00, 0x05]).r.senseCode).toBe(0x10050130);
    expect(on([ORDER.SBA, 7, 9, ORDER.SF, 0x10, 0x00, 0x05]).r.senseCode).toBe(0x10050130);
  });
});

/**
 * **EA の属性タイプ・書き始め・長さ 3 以上は ACS と同じ**（`20260927-ea-acs`。ACS `PS5250.eraseToAddress`）。実機で DSM に
 * 「6 行 2 桁に ABCDEFGHIJ → SBA 6,4 → EA〔行き先 6,6〕→ X → 6,20 に END」を出させ、ACS のコアの 6 行目は
 * 0xFF / 0x00: ` AB   XGHIJ        END`（X は行き先の次）・0x01: ` ABCDEFGHIJ`（0x1005012D）・長さ 3: ` AB   FGHIJ`（0x10050123）だった
 * （`scripts/acs-probe/ea-acs.txt`・`scripts/verify-ea-acs.mjs`）
 */
describe("EA の属性タイプと書き始め（ACS の実測）", () => {
  const W = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x05, ORDER.SBA, 6, 2, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xd1, ORDER.SBA, 6, 4];
  const TAIL = [0xe7, ORDER.SBA, 6, 20, 0xc5, 0xd5, 0xc4];
  const row6 = (ea: number[], c = codec) => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...W, ...ea, ...TAIL]), buf, c, () => {});
    return { r, text: buf.snapshot().cells[5]!.map((x) => x.char).join("").replace(/\s+$/, "") };
  };
  for (const [label, ea, text, sense] of [
    ["タイプ 0xFF", [ORDER.EA, 6, 6, 0x02, 0xff], " AB   XGHIJ        END", undefined],
    ["タイプ 0x00", [ORDER.EA, 6, 6, 0x02, 0x00], " AB   XGHIJ        END", undefined],
    ["タイプ 0x01", [ORDER.EA, 6, 6, 0x02, 0x01], " ABCDEFGHIJ", 0x1005012d],
    ["長さ 3（0x00・0xFF）", [ORDER.EA, 6, 6, 0x03, 0x00, 0xff], " AB   FGHIJ", 0x10050123],
    ["長さ 5（上限。2 つ目で後戻り）", [ORDER.EA, 6, 6, 0x05, 0x00, 0xff, 0x00, 0xff], " AB   FGHIJ", 0x10050123],
    ["タイプ 0x05（DBCS でないセッション）", [ORDER.EA, 6, 6, 0x02, 0x05], " ABCDEFGHIJ", 0x1005012d]
  ] as const) {
    it(`${label}: 6 行目 ${JSON.stringify(text)}${sense ? `・否定応答 0x${sense.toString(16)}` : ""}`, () => {
      const { r, text: t } = row6([...ea]);
      expect(t).toBe(text);
      expect(r.senseCode).toBe(sense);
    });
  }

  it("タイプ 0x05 は DBCS のセッションでは受ける（文字は消さず、書き始めは行き先の次）", () => {
    const { r, text } = row6([ORDER.EA, 6, 6, 0x02, 0x05], codecForCcsid(930));
    expect(r.senseCode).toBeUndefined();
    expect(text).toBe(" ABCDEXGHIJ        END");
  });
});

/**
 * **文字の並びが画面の終わりを越えるなら、並びを書かずに 0x10050121 で戻る（CC2 も落とす）**（`20260927-ea-acs`）。実機の ACS のコア:
 * 24,79 から XYZ → 24 行目は空のまま・0x10050121・メッセージ待ちは点かない。EA 24,80 の後ろの X → EA の消去は効き、X は書かれず 0x10050121
 */
describe("画面の終わりを越える文字の並び（ACS の実測）", () => {
  const WTD = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x05];
  const row = (buf: ScreenBuffer, n: number) => buf.snapshot().cells[n - 1]!.map((x) => x.char).join("").replace(/\s+$/, "");
  it("24,79 から XYZ: 並びを書かず、0x10050121・CC2 を落とす", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 79, 0xe7, 0xe8, 0xe9, ORDER.SBA, 6, 20, 0xc5]), buf, codec, () => {});
    expect(r.senseCode).toBe(0x10050121);
    expect(r.alarm).toBe(false);
    expect(r.messageWaiting).toBeUndefined();
    expect(row(buf, 24)).toBe("");
    expect(row(buf, 6)).toBe("");
  });
  it("EA 24,80 の後ろの X: 消去は効き、X は書かれず 0x10050121", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 70, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, ORDER.SBA, 24, 75, ORDER.EA, 24, 80, 0x02, 0xff, 0xe7]), buf, codec, () => {});
    expect(r.senseCode).toBe(0x10050121);
    expect(r.messageWaiting).toBeUndefined();
    expect(row(buf, 24).trim()).toBe("01234");
  });
  it("ちょうど最後の桁まで収まる並び（24,78 から XYZ）は書く", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 78, 0xe7, 0xe8, 0xe9]), buf, codec, () => {});
    expect(r.senseCode).toBeUndefined();
    expect(row(buf, 24).trim()).toBe("XYZ");
  });
  it("**最後の桁でちょうど終わった並びの次は 1 行 1 桁から**（ACS は位置を画面の大きさで割った余りに戻す。実機: 24,78 から XYZ → IC → W の W は 1,1）", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 78, 0xe7, 0xe8, 0xe9, ORDER.IC, 6, 2, 0xe6]), buf, codec, () => {});
    expect(r.senseCode).toBeUndefined();
    expect(r.messageWaiting).toBe(true);
    expect(row(buf, 1)).toBe("W");
    expect(row(buf, 24).trim()).toBe("XYZ");
  });
  it("RA が最後の桁で終わった次も 1 行 1 桁から（RA も ACS は同じ書き方）", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 78, ORDER.RA, 24, 80, 0x5c, 0xe6]), buf, codec, () => {});
    expect(r.senseCode).toBeUndefined();
    expect(row(buf, 1)).toBe("W");
  });
  it("EA 24,80 の後は SBA で置き直せば書ける（画面の外のままは EA だけ）", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 70, ORDER.EA, 24, 80, 0x02, 0xff, ORDER.SBA, 1, 2, 0xe6]), buf, codec, () => {});
    expect(r.senseCode).toBeUndefined();
    expect(row(buf, 1)).toBe(" W");
  });
  it("EA 24,80 で終わる WTD（後ろに文字が無い）は否定応答にしない（メッセージ行を消す実例の形）", () => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...WTD, ORDER.SBA, 24, 1, ORDER.EA, 24, 80, 0x02, 0xff, ESC, COMMAND.READ_MDT_FIELDS, 0, 0]), buf, codec, () => {});
    expect(r.senseCode).toBeUndefined();
    expect(r.readRequested).toBe(true);
  });
});

/**
 * **WDSF の頭の検査**（ACS `ENPTUI5250.processWSFOrder`。`20260927-wdsf-sense`）。実機の ACS のコア（ENPTUI 有効——当 PJ は常に申告する）のワイヤで
 * LL が 3 → 0x10050110、クラス 0xD8・知らない型 0x7F → 0x10050111（後ろの NEXT は書かない・CC2 は効く）
 */
describe("WDSF の頭の検査（ACS の実測）", () => {
  const NEXT = [ORDER.SBA, 6, 2, 0xd5, 0xc5, 0xe7, 0xe3];
  const on = (order: number[]) => {
    const buf = new ScreenBuffer();
    const r = applyDataStream(Uint8Array.from([...HEAD, ...order, ...NEXT]), buf, codec, () => {});
    return { r, row6: buf.snapshot().cells[5]!.map((c) => c.char).join("").trim() };
  };
  for (const [label, order, sense] of [
    ["LL が 3", [ORDER.WDSF, 0x00, 0x03, 0xd9], 0x10050110],
    ["クラスが 0xD8", [ORDER.WDSF, 0x00, 0x06, 0xd8, 0x50, 0x00, 0x00], 0x10050111],
    ["知らない型 0x7F", [ORDER.WDSF, 0x00, 0x04, 0xd9, 0x7f], 0x10050111]
  ] as const) {
    it(`**${label}** は 0x${sense.toString(16)}（後ろは書かない・CC2 は効く）`, () => {
      const { r, row6 } = on([...order]);
      expect(r.senseCode).toBe(sense);
      expect(row6).toBe("");
      expect(r.messageWaiting).toBe(true);
    });
  }
  it("**レコードの終わりで 4 バイトに足りない**は 0x10050121", () => {
    const r = applyDataStream(Uint8Array.from([...HEAD, ORDER.WDSF, 0x00, 0x04]), new ScreenBuffer(), codec, () => {});
    expect(r.senseCode).toBe(0x10050121);
  });
  // ~~0x52 も否定応答にしない~~——中身の無い 0x52 は ACS でも 0x10050110（`unrestrictWindowCursor` は中身 2 バイトだけを受ける。`20260928-window-unrestrict`。`window-unrestrict.test.ts`）
  // ~~0x54~~ は中身を効かせるようになった（`20260928-wdsf-write-data`。形の分からない 0x54 は ACS も否定応答 0x10050140）
  it("ACS が受ける型（0x55）は、当 PJ が効かせなくても否定応答にしない", () => {
    for (const t of [0x55]) {
      const { r, row6 } = on([ORDER.WDSF, 0x00, 0x07, 0xd9, t, 0x00, 0x00, 0x00]); // LL 7（0x55 は LL が 7 以上で (LL−3) が 4 の倍数。`20260928-wdsf-negative`）
      expect(r.senseCode, `0x${t.toString(16)}`).toBeUndefined();
      expect(row6).toBe("NEXT");
    }
  });
});


/**
 * **WDSF の構造体ごとの長さ・引数の否定応答**（`20260928-wdsf-negative`）。実機の ACS のコア（DSM の WDSFNEG・`scripts/acs-probe/wdsf-negative.txt`）で
 * 14 通りがすべて否定応答になり、正しい 0x5F は通った。バイト列は LL から（DSM と同じ）
 */
describe("WDSF の構造体ごとの否定応答（ACS の実測）", () => {
  const on = (order: number[]) => {
    const buf = new ScreenBuffer();
    return { r: applyDataStream(Uint8Array.from([...HEAD, ...order]), buf, codec, () => {}) };
  };
  const cases: [string, number[], number | undefined][] = [
    ["0x50 LL=20（選択肢なし）", [0x00, 0x14, 0xd9, 0x50, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00], 0x10050113],
    ["0x51 LL=8", [0x00, 0x08, 0xd9, 0x51, 0x00, 0x00, 0x00, 0x05], 0x10050113],
    ["0x53 LL=14", [0x00, 0x0e, 0xd9, 0x53, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00], 0x10050113],
    ["0x55 LL=8", [0x00, 0x08, 0xd9, 0x55, 0x00, 0x00, 0x00, 0x00], 0x10050110],
    ["0x58 LL=7", [0x00, 0x07, 0xd9, 0x58, 0x00, 0x00, 0x00], 0x10050110],
    ["0x59 LL=6", [0x00, 0x06, 0xd9, 0x59, 0x00, 0x00], 0x10050110],
    ["0x5B LL=7", [0x00, 0x07, 0xd9, 0x5b, 0x00, 0x00, 0x00], 0x10050110],
    ["0x5F LL=6", [0x00, 0x06, 0xd9, 0x5f, 0x00, 0x00], 0x10050110],
    ["0x60 LL=8", [0x00, 0x08, 0xd9, 0x60, 0x01, 0x80, 0x00, 0x00], 0x10050110],
    ["0x60 区画 0", [0x00, 0x09, 0xd9, 0x60, 0x00, 0x80, 0x00, 0x00, 0x00], 0x10050112],
    ["0x60 LL=12", [0x00, 0x0c, 0xd9, 0x60, 0x01, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00], 0x10050110],
    ["0x61 LL=10", [0x00, 0x0a, 0xd9, 0x61, 0x01, 0x00, 0x00, 0x01, 0x01, 0x50], 0x10050110],
    ["0x61 区画 0", [0x00, 0x0b, 0xd9, 0x61, 0x00, 0x00, 0x00, 0x01, 0x01, 0x50, 0x18], 0x10050112],
    ["0x61 画面の外", [0x00, 0x0b, 0xd9, 0x61, 0x01, 0x00, 0x00, 0x01, 0x46, 0x14, 0x01], 0x10050151],
    ["0x5F LL=7（正しい）", [0x00, 0x07, 0xd9, 0x5f, 0x00, 0x00, 0x00], undefined],
    ["0x61 LL=11（正しい矩形）", [0x00, 0x0b, 0xd9, 0x61, 0x01, 0x00, 0x00, 0x05, 0x05, 0x0a, 0x01], undefined],
    ["0x60 LL=18（マイナー 7 バイト）", [0x00, 0x12, 0xd9, 0x60, 0x01, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x07, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01], undefined]
  ];
  it.each(cases)("%s", (_n, bytes, sense) => {
    const { r } = on([ORDER.SBA, 5, 10, ORDER.WDSF, ...bytes]);
    expect(r.senseCode).toBe(sense);
  });
});

/**
 * **WDSF のマイナー構造体の長さ・型・位置の否定応答**（ACS `ENPTUISelectionField` / `ENPTUIMenuBar` / `ENPTUIWindow` の
 * `processMinorStructures`・`ENPTUI5250.processDefineGridMinor`。`20260929-wdsf-minor-sense`）。デコンパイル済みの原典を直読して
 * 確定した閾値（選択肢文字列 4 バイト以上・選択肢の属性 4〜19 バイト・メニューバー区切り 5〜8 バイト・窓の枠 4〜13 バイト・
 * 窓の表題/脚注 7 バイト以上・罫線のマイナー 7〜11 バイト・型 0〜7・行/桁/横罫/縦罫が画面の内・反復/間隔が 1 以上）。
 * 原典の読みであって実機の観測ではない（台帳「WDSF の中の否定応答」——実機の DSM はまだ無い）
 */
describe("WDSF のマイナー構造体の否定応答（原典の読み）", () => {
  const on = (order: number[]) => {
    const buf = new ScreenBuffer();
    return { r: applyDataStream(Uint8Array.from([...HEAD, ORDER.SBA, 2, 2, ORDER.WDSF, ...order]), buf, codec, () => {}) };
  };
  const wdsf = (type: number, body: number[]): number[] => {
    const sf = [0xd9, type, ...body];
    const ll = sf.length + 2;
    return [(ll >> 8) & 0xff, ll & 0xff, ...sf];
  };
  // 0x50 の主構造（スクロール・バー無し。16 バイト: flag1,flag2,flag3,selectionType,guiDeviceChar,4予約,textSize,rows,cols,nulls,予約,selectChar,cancelAID）
  const hdr50 = (selectionType: number): number[] => [0x00, 0x00, 0x00, selectionType, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00];
  // 0x51 の主構造（5 バイト: flag1,flag2,予約,depth,width）
  const hdr51 = [0x00, 0x00, 0x00, 0x03, 0x0a];
  // 0x60 の主構造（7 バイト: partition,flag1,予約,flag2,予約,color,line）
  const hdr60 = [0x01, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00];

  const cases: [string, number[], number | undefined][] = [
    // --- 0x50 選択肢文字列（0x10）: 4 バイト未満 → 0x10050113 ---
    ["0x50 選択肢文字列のマイナー長 3（4 未満）", wdsf(0x50, [...hdr50(0x11), 0x03, 0x10, 0x41]), 0x10050113],
    ["0x50 選択肢文字列のマイナー長 4（境界・正しい）", wdsf(0x50, [...hdr50(0x11), 0x04, 0x10, 0x00, 0x00]), undefined],
    // --- 0x50 選択肢の属性（0x01）: 4〜19 バイトでなければ → 0x10050113 ---
    ["0x50 選択肢の属性のマイナー長 3（4 未満）", wdsf(0x50, [...hdr50(0x11), 0x03, 0x01, 0x00]), 0x10050113],
    ["0x50 選択肢の属性のマイナー長 19（境界・正しい）", wdsf(0x50, [...hdr50(0x11), 0x13, 0x01, ...Array(17).fill(0x00)]), undefined],
    ["0x50 選択肢の属性のマイナー長 20（19 超え）", wdsf(0x50, [...hdr50(0x11), 0x14, 0x01, ...Array(18).fill(0x00)]), 0x10050113],
    // --- 0x50 メニューバーの区切り（0x09。selectionType=1 のときだけ）: 5〜8 バイトでなければ → 0x10050113 ---
    ["0x50 メニューバー区切りのマイナー長 4（5 未満）", wdsf(0x50, [...hdr50(0x01), 0x04, 0x09, 0x00, 0x00]), 0x10050113],
    ["0x50 メニューバー区切りのマイナー長 6（境界・正しい）", wdsf(0x50, [...hdr50(0x01), 0x06, 0x09, 0x00, 0x00, 0x00, 0x00]), undefined],
    ["0x50 メニューバー区切りのマイナー長 9（8 超え）", wdsf(0x50, [...hdr50(0x01), 0x09, 0x09, ...Array(7).fill(0x00)]), 0x10050113],
    // --- 0x51 窓の枠（0x01）: 4〜13 バイトでなければ → 0x10050113 ---
    ["0x51 枠のマイナー長 3（4 未満）", wdsf(0x51, [...hdr51, 0x03, 0x01, 0x00]), 0x10050113],
    ["0x51 枠のマイナー長 4（境界・正しい）", wdsf(0x51, [...hdr51, 0x04, 0x01, 0x00, 0x00]), undefined],
    ["0x51 枠のマイナー長 13（境界・正しい）", wdsf(0x51, [...hdr51, 0x0d, 0x01, ...Array(11).fill(0x00)]), undefined],
    ["0x51 枠のマイナー長 14（13 超え）", wdsf(0x51, [...hdr51, 0x0e, 0x01, ...Array(12).fill(0x00)]), 0x10050113],
    // --- 0x51 表題・脚注（0x10）: 6 バイト以下なら → 0x10050113 ---
    ["0x51 表題のマイナー長 6（6 以下）", wdsf(0x51, [...hdr51, 0x06, 0x10, ...Array(4).fill(0x00)]), 0x10050113],
    ["0x51 表題のマイナー長 7（境界・正しい）", wdsf(0x51, [...hdr51, 0x07, 0x10, ...Array(5).fill(0x00)]), undefined],
    // --- 0x60 罫線のマイナー構造体 ---
    ["0x60 マイナーの型 8（0〜7 の外）", wdsf(0x60, [...hdr60, 0x07, 0x08, 0x00, 0x05, 0x05, 0x05, 0x01]), 0x10050150],
    ["0x60 マイナーの行が 0", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x00, 0x05, 0x05, 0x01]), 0x10050151],
    ["0x60 マイナーの桁が 0", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x05, 0x00, 0x05, 0x01]), 0x10050151],
    ["0x60 マイナーの行が画面の外", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x63, 0x05, 0x05, 0x01]), 0x10050151],
    ["0x60 型 0 の横罫が 0", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x05, 0x05, 0x00, 0x01]), 0x10050151],
    ["0x60 型 0 の横罫が画面の外（桁+横罫-1 > 80）", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x05, 0x4b, 0x0a, 0x01]), 0x10050151],
    ["0x60 型 2（縦線）の縦罫が 0", wdsf(0x60, [...hdr60, 0x07, 0x02, 0x00, 0x05, 0x05, 0x00, 0x00]), 0x10050151],
    ["0x60 型 0 の反復（長さ 10）が 0", wdsf(0x60, [...hdr60, 0x0a, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01, 0xff, 0x00, 0x00]), 0x10050152],
    ["0x60 型 0 の反復（長さ 10）が 1（正しい）", wdsf(0x60, [...hdr60, 0x0a, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01, 0xff, 0x00, 0x01]), undefined],
    ["0x60 型 0 の間隔（長さ 11）が 0", wdsf(0x60, [...hdr60, 0x0b, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01, 0xff, 0x00, 0x01, 0x00]), 0x10050152],
    ["0x60 型 0 の間隔（長さ 11）が 1（正しい）", wdsf(0x60, [...hdr60, 0x0b, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01, 0xff, 0x00, 0x01, 0x01]), undefined],
    ["0x60 マイナー 2 つ（両方正しい）", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01, 0x07, 0x01, 0x00, 0x08, 0x08, 0x01, 0x01]), undefined],
    ["0x60 マイナー 2 つ目の型が壊れている", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01, 0x07, 0x09, 0x00, 0x08, 0x08, 0x01, 0x01]), 0x10050150],
    // --- 追加の境界（独立点検の生き残りを埋める）---
    ["0x60 マイナー長 6（7 未満・全体 LL は 18 バイトの区切りに乗せて外側の長さ検査を通す）", wdsf(0x60, [...hdr60, 0x06, 0x00, 0x00, 0x05, 0x05, 0x05, 0x00]), 0x10050113],
    ["0x60 マイナー長 12（11 超え・実在バイトあり）", wdsf(0x60, [...hdr60, 0x0c, 0x00, 0x00, 0x05, 0x05, 0x05, 0x01, 0xff, 0x00, 0x01, 0x01, 0x00]), 0x10050113],
    ["0x60 型 0（横線）は縦罫（depth）が 0 でも構わない（型 2・3 だけの検査）", wdsf(0x60, [...hdr60, 0x07, 0x00, 0x00, 0x05, 0x05, 0x05, 0x00]), undefined],
    // 選択肢のマイナー: スクロール・バー付き（flag2 の 0x80）は主構造が 28 バイト目まで伸び、マイナーはその後ろから
    // （28 バイト目に置いた選択肢文字列のマイナー長 3 が 4 未満で否定応答。18 バイト目から読むと違う値になり、この否定応答にならない）
    [
      "0x50 スクロール・バー付きは主構造が 28 バイト目まで（28 バイト目のマイナー長 3 で否定応答）",
      wdsf(0x50, [0x00, 0x80, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x10, 0x41]),
      0x10050113
    ],
    // 外側の主構造の長さ検査も、スクロール・バー付きなら 28 バイト（ACS `checkMajorLength`）——独立点検の指摘。
    // 21〜28 バイトの短いスクロール・バー付き選択欄は、マイナーの歩く開始位置（28）が sf の外に出て 1 度もマイナーを検査しないまま undefined になっていた
    ["0x50 スクロール・バー付きの主構造長 24（28 以下は無効・以前は素通りしていた）", wdsf(0x50, [0x00, 0x80, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 0x10050113],
    ["0x50 スクロール・バー付きの主構造長 28（境界・非スクロール版の LL=20 と対称に無効）", wdsf(0x50, [0x00, 0x80, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 0x10050113],
    // メニューバーの区切り（0x09）は selectionType が 1 のときだけ検査する——メニューバーでない選択欄では読み飛ばす（独立点検の指摘: この分岐の否定側が未検証だった）
    ["0x50 メニューバーでない選択欄の 0x09 マイナーは検査しない（長さ 4 は本来メニューバーなら否定応答）", wdsf(0x50, [...hdr50(0x11), 0x04, 0x09, 0x00, 0x00]), undefined]
  ];
  it.each(cases)("%s", (_n, bytes, sense) => {
    const { r } = on(bytes);
    expect(r.senseCode).toBe(sense);
  });
});
