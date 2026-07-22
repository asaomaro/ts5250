import { describe, it, expect } from "vitest";
import { buildQueryReply } from "../src/protocol/query-reply.js";
import { parseRecord } from "../src/protocol/gds.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { OPCODE, ESC, COMMAND } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

describe("buildQueryReply", () => {
  /**
   * ACS 実機（IBM i 日本語機・IBM-5555-C01）が返す Query Reply の本体 71 バイト。
   * 中継プロキシで実測したもので、当方はこれとバイト一致させる。
   * 申告が違うとホストがヘルプ／ウィンドウの描画経路を変える（PDM の F1 が 27x132 に落ちる）。
   */
  const ACS_5555_C01 = [
    0x00, 0x00, 0x88, 0x00, 0x44, 0xd9, 0x70, 0x80, 0x05, 0x00, 0x03, 0x02, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf5, 0xf5,
    0xf5, 0xf5, 0xc3, 0xf0, 0xf1, 0x01, 0x01, 0x00, 0x00, 0x00, 0x70, 0x12, 0x01, 0xf4, 0x00, 0x00,
    0x00, 0x7b, 0x31, 0x00, 0x40, 0x0f, 0xc8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ];

  it("IBM-5555-C01 で ACS 実機とバイト一致する（opcode PUT_GET・flag2 0x80）", () => {
    const rec = buildQueryReply("IBM-5555-C01");
    expect(rec[9]).toBe(OPCODE.PUT_GET);
    expect(rec[8]).toBe(0x80); // フラグ 2 バイト目
    expect([...parseRecord(rec).data]).toEqual(ACS_5555_C01);
  });

  it("device type / model を 4 桁 + **3 桁** で載せる", () => {
    const d = parseRecord(buildQueryReply()).data;
    expect(d).toHaveLength(71);
    expect(d[2]).toBe(0x88); // Inbound WSF AID
    expect(d[5]).toBe(0xd9); // command class
    expect(d[6]).toBe(0x70); // Query
    // "3179" + "002"（model を 3 桁にしないと "C01" の先頭が落ちる）
    expect([...d.slice(30, 34)]).toEqual([0xf3, 0xf1, 0xf7, 0xf9]);
    expect([...d.slice(34, 37)]).toEqual([0xf0, 0xf0, 0xf2]);
  });

  it("拡張 5250 と 24x80/27x132 両対応を常に広告する", () => {
    const d = parseRecord(buildQueryReply("IBM-3179-2", false)).data;
    expect(d[50]).toBe(0x31); // bit0-3=0011: 両サイズ対応
    expect(d[53]).toBe(0x0f); // 拡張 5250（FCW & WDSF 等）
    expect(d[54]).toBe(0xc8); // 拡張ユーザーインターフェース
  });
});

describe("applyDataStream — WSF QUERY 検出", () => {
  it("QUERY コマンド（class D9 / type 70）で queryRequested が立つ", () => {
    const buf = new ScreenBuffer();
    // ESC WSF, length=0x0005, class=0xD9, type=0x70, flag=0x00
    const data = Uint8Array.from([ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0xd9, 0x70, 0x00]);
    const result = applyDataStream(data, buf, codec);
    expect(result.queryRequested).toBe(true);
  });

  it("QUERY 以外の構造化フィールドでは queryRequested は立たない", () => {
    const buf = new ScreenBuffer();
    const data = Uint8Array.from([ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00, 0x05, 0xd9, 0x50, 0x00]);
    const result = applyDataStream(data, buf, codec);
    expect(result.queryRequested).toBe(false);
  });
});
