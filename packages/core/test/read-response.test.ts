import { describe, it, expect } from "vitest";
import { buildReadMdtResponse, buildFlagRecord } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { AID, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import {
  attrSentinel,
  isAttrSentinel,
  attrSentinelByte,
  isRawSentinel,
  sentinelByte
} from "../src/screen/attr-sentinel.js";

const codec = codecForCcsid(37);

function makeBuffer(): ScreenBuffer {
  const b = new ScreenBuffer();
  b.setAttr(b.addrOf(5, 24), 0x24);
  b.addField(b.addrOf(5, 25), 10, FFW.ID_VALUE, 0x24);
  b.setAttr(b.addrOf(6, 24), 0x27);
  b.addField(b.addrOf(6, 25), 8, FFW.ID_VALUE, 0x27);
  return b;
}

describe("buildReadMdtResponse", () => {
  it("カーソル・AID・MDT フィールドを SBA 付きで構築する", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "TARO");
    b.setFieldValue(b.fieldByIndex(2), "SECRET");
    const { record, substituted } = buildReadMdtResponse(b, codec, AID.ENTER, { row: 6, col: 33 });

    expect(substituted).toBe(0);
    const parsed = parseRecord(record);
    expect(parsed.opcode).toBe(OPCODE.PUT_GET);
    const d = [...parsed.data];
    expect(d.slice(0, 3)).toEqual([6, 33, AID.ENTER]);
    // フィールド 1: SBA(5,25) + "TARO"
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 5, 25]);
    expect(d.slice(6, 10)).toEqual([...codec.encode("TARO").bytes]);
    // フィールド 2: SBA(6,25) + "SECRET"
    expect(d.slice(10, 13)).toEqual([ORDER.SBA, 6, 25]);
    expect(d.slice(13)).toEqual([...codec.encode("SECRET").bytes]);
  });

  it("MDT の立っていないフィールドは送らない", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "ONLY");
    const { record } = buildReadMdtResponse(b, codec, AID.F3);
    const d = [...parseRecord(record).data];
    expect(d[2]).toBe(AID.F3);
    expect(d.filter((x) => x === ORDER.SBA)).toHaveLength(1);
  });

  it("カーソル未指定時は現在のカーソル位置を使う", () => {
    const b = makeBuffer();
    b.cursorAddr = b.addrOf(3, 7);
    const { record } = buildReadMdtResponse(b, codec, AID.ENTER);
    const d = [...parseRecord(record).data];
    expect(d.slice(0, 2)).toEqual([3, 7]);
  });

  it("フィールドなし（AID のみ）の応答も作れる", () => {
    const b = new ScreenBuffer();
    const { record } = buildReadMdtResponse(b, codec, AID.PAGE_DOWN);
    const d = [...parseRecord(record).data];
    expect(d).toEqual([1, 1, AID.PAGE_DOWN]);
  });

  it("マップ不能文字は SUB で送られ substituted に計上される", () => {
    const b = makeBuffer();
    b.setFieldValue(b.fieldByIndex(1), "あ");
    const { record, substituted } = buildReadMdtResponse(b, codec, AID.ENTER);
    expect(substituted).toBe(1);
    const d = [...parseRecord(record).data];
    expect(d[6]).toBe(0x3f); // SUB
  });

  it("埋め込み属性はセンチネルで返り、編集で動いた桁に書き戻り送信される", () => {
    const b = new ScreenBuffer();
    b.setAttr(b.addrOf(5, 24), 0x24); // 欄を定義する属性（欄の前）
    b.addField(b.addrOf(5, 25), 10, FFW.ID_VALUE, 0x24);
    const fs = b.addrOf(5, 25);
    b.setAttr(fs + 2, 0x28); // 欄の position 2 に埋め込み属性（赤 0x28）

    // fieldValue はその桁をセンチネルで返す（値の中で識別・移動できる）
    const value = b.fieldValue(b.fieldByIndex(1));
    expect(isAttrSentinel(value[2]!)).toBe(true);
    expect(attrSentinelByte(value[2]!)).toBe(0x28);

    // 属性より前を 1 文字削って属性が position 1 へ動いた編集値を書き戻す
    b.setFieldValue(b.fieldByIndex(1), "A" + attrSentinel(0x28) + "CD");

    // 属性セルは**動いた位置(fs+1)**にある（元の fs+2 ではない）
    expect(b.cellAt(fs + 1)?.type).toBe("attr");
    expect(b.cellAt(fs + 2)?.type).toBe("char");

    // 送信レコードでも属性バイトが動いた桁(position 1)に出る
    const { record } = buildReadMdtResponse(b, codec, AID.ENTER, { row: 5, col: 25 });
    const d = [...parseRecord(record).data];
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 5, 25]);
    expect(d[6 + 0]).toBe(codec.encode("A").bytes[0]); // A
    expect(d[6 + 1]).toBe(0x28); // 属性バイトが動いた桁(1)に
    expect(d[6 + 2]).toBe(codec.encode("C").bytes[0]); // C が続く（桁ずれ・破壊なし）
  });
});

describe("buildFlagRecord", () => {
  it("SysReq(SRQ) は SRQ フラグ・空データの NO_OP レコード", () => {
    const parsed = parseRecord(buildFlagRecord({ srq: true }));
    expect(parsed.opcode).toBe(OPCODE.NOOP);
    expect(parsed.flags.srq).toBe(true);
    expect(parsed.flags.atn).toBe(false);
    expect(parsed.data).toHaveLength(0);
  });

  it("Attn(ATN) は ATN フラグ", () => {
    const parsed = parseRecord(buildFlagRecord({ atn: true }));
    expect(parsed.flags.atn).toBe(true);
    expect(parsed.flags.srq).toBe(false);
  });
});

/**
 * **表示できない SBCS バイトは、編集して送信しても元のバイトのまま返る。**
 *
 * EBCDIC の SBCS 表にはマップの無いバイトがあり、デコードすると U+FFFD になる。値に
 * U+FFFD をそのまま載せると、その欄を編集して送信した時点でエンコード不能となり
 * SUB（0x3F）に化けて元のデータを壊す（日本語機の実データで発生）。
 * 埋め込み属性と同じセンチネル方式で生バイトを運び、送信で書き戻す。
 */
describe("表示できない SBCS バイトの保持", () => {
  const dbcsCodec = codecForCcsid(939);
  /** 0x41 は CCSID 939 の SBCS 部（1027）に定義が無い */
  const UNMAPPED = 0x41;

  function bufferWithUnmappedByte(): ScreenBuffer {
    const b = new ScreenBuffer();
    b.setAttr(b.addrOf(5, 24), 0x24);
    b.addField(b.addrOf(5, 25), 4, FFW.ID_VALUE, 0x24);
    const fs = b.addrOf(5, 25);
    b.setChar(fs, "A", 0xc1);
    b.setChar(fs + 1, String.fromCharCode(dbcsCodec.decodeByte(UNMAPPED)), UNMAPPED);
    b.setChar(fs + 2, "B", 0xc2);
    return b;
  }

  it("前提: そのバイトはデコードできず U+FFFD になる", () => {
    expect(dbcsCodec.decodeByte(UNMAPPED)).toBe(0xfffd);
  });

  it("fieldValue はセンチネルで返す（U+FFFD をそのまま出さない）", () => {
    const b = bufferWithUnmappedByte();
    const value = b.fieldValue(b.fieldByIndex(1));
    expect(value).not.toContain("�");
    expect(isRawSentinel(value[1]!)).toBe(true);
    expect(sentinelByte(value[1]!)).toBe(UNMAPPED);
  });

  it("編集して送信しても元のバイトで返る（SUB に化けない）", () => {
    const b = bufferWithUnmappedByte();
    const value = b.fieldValue(b.fieldByIndex(1));
    // 末尾を打ち替える（該当バイトの桁は触らない）
    b.setFieldValue(b.fieldByIndex(1), value.slice(0, 2) + "X");

    const { record, substituted } = buildReadMdtResponse(b, dbcsCodec, AID.ENTER, {
      row: 5,
      col: 25
    });
    const d = [...parseRecord(record).data];
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 5, 25]);
    expect(d.slice(6, 9)).toEqual([0xc1, UNMAPPED, 0xe7]); // A / 元のバイト / X
    expect(substituted, "センチネルは SUB に計上されない").toBe(0);
  });

  it("該当バイトより前を削ると、そのバイトも一緒に左へ動く", () => {
    const b = bufferWithUnmappedByte();
    const value = b.fieldValue(b.fieldByIndex(1));
    b.setFieldValue(b.fieldByIndex(1), value.slice(1)); // 先頭 "A" を削除
    const { record } = buildReadMdtResponse(b, dbcsCodec, AID.ENTER, { row: 5, col: 25 });
    const d = [...parseRecord(record).data];
    expect(d.slice(6, 8)).toEqual([UNMAPPED, 0xc2]);
  });
});

/**
 * **未編集の DBCS 欄は、ホストが描いた SO/SI をそのまま送り返す。**
 *
 * 全角ランから SO/SI を再構成する方式では、空の SO/SI（{}）や不整合（{ だけ・} だけ）を
 * 表せず落ちてしまう（SEU のソース等、実データで起こる）。ホスト原本の生バイトをセルに保持し、
 * 未編集欄はそのバイト列を忠実に送る。
 */
describe("DBCS 欄の SO/SI を送信でそのまま保持する", () => {
  const dbcsCodec = codecForCcsid(939);

  /** MDT を立てた未編集 DBCS（open）欄を作る。セルはテストが直接置く（ホスト描画を模す） */
  function dbcsFieldBuffer(length: number): { b: ScreenBuffer; fs: number } {
    const b = new ScreenBuffer();
    b.setAttr(b.addrOf(5, 24), 0x24);
    b.addField(b.addrOf(5, 25), length, FFW.ID_VALUE | FFW.MDT, 0x24, "open");
    return { b, fs: b.addrOf(5, 25) };
  }

  /** ヘッダ(3)+SBA(3) を除いたフィールドデータのバイト列 */
  function sentFieldData(b: ScreenBuffer): number[] {
    const { record } = buildReadMdtResponse(b, dbcsCodec, AID.ENTER, { row: 5, col: 25 });
    return [...parseRecord(record).data].slice(6);
  }

  it("空の SO/SI（{}）はそのまま 0x0e 0x0f で送る", () => {
    const { b, fs } = dbcsFieldBuffer(4);
    b.setShift(fs, "so");
    b.setShift(fs + 1, "si");
    expect(sentFieldData(b)).toEqual([0x0e, 0x0f]);
  });

  it("SO だけ・SI だけの不整合もそのまま送る", () => {
    const only1 = dbcsFieldBuffer(2);
    only1.b.setShift(only1.fs, "so");
    expect(sentFieldData(only1.b)).toEqual([0x0e]);

    const only2 = dbcsFieldBuffer(2);
    only2.b.setShift(only2.fs, "si");
    expect(sentFieldData(only2.b)).toEqual([0x0f]);
  });

  it("正常な DBCS はホスト原本の 2 バイトをそのまま送る", () => {
    const { b, fs } = dbcsFieldBuffer(6);
    b.setChar(fs, "A", 0xc1);
    b.setShift(fs + 1, "so");
    b.setDbcs(fs + 2, "日", 0x45, 0x9c); // ホストが送ってきた任意の DBCS 2 バイト
    b.setShift(fs + 4, "si");
    const { record, substituted } = buildReadMdtResponse(b, dbcsCodec, AID.ENTER, { row: 5, col: 25 });
    expect([...parseRecord(record).data].slice(6)).toEqual([0xc1, 0x0e, 0x45, 0x9c, 0x0f]);
    expect(substituted, "生バイトは SUB に計上されない").toBe(0);
  });
});
