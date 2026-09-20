import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { CLIENT_FLAG2 } from "../src/protocol/gds.js";
import {
  buildCancelInviteAck,
  buildFlagRecord,
  buildReadImmediateResponse,
  buildReadInputFieldsResponse,
  buildReadMdtImmediateAltResponse,
  buildReadMdtResponse
} from "../src/protocol/read-response.js";
import {
  buildReadScreenExtendedResponse,
  buildReadScreenResponse,
  buildSavePartialScreenResponse,
  buildSaveScreenResponse
} from "../src/protocol/save-screen.js";
import { buildQueryReply } from "../src/protocol/query-reply.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { AID, COMMAND, ESC, OPCODE, ORDER } from "../src/protocol/constants.js";

/**
 * **クライアント発のレコードはフラグ 2 バイト目（GDS ヘッダ 9 バイト目）に 0x80 を立てる**（ACS 準拠）。
 *
 * ACS はヘッダ生成の全経路（`DS5250.sendAll` / `processReadScreen` / `processReadScreenEA` /
 * `processSaveScreen`）で 0x80 を立て、中継タップで比べると AID 応答はカーソル位置以外バイト一致した。
 * 以前は READ SCREEN EXTENDED と Query Reply だけに立てていた。
 *
 * **Attn / SysReq のフラグレコードと Cancel Invite への返事は 0 のまま**——フラグ 0 で通ることを
 * 実機で確かめてあり、ACS がこの経路でも立てるかは未確認なので、非常口を変えない。
 */
const codec = codecForCcsid(37);
const FLAG2 = 8;

function screen(): ScreenBuffer {
  const buf = new ScreenBuffer();
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 3, 10, ORDER.SF, 0x48, 0x00, 0x20, 0x00, 5, // MDT 付きの入力欄
      ...codec.encode("ABC").bytes
    ]),
    buf,
    codec,
    () => {}
  );
  return buf;
}

describe("クライアント発レコードの flag2", () => {
  it("CLIENT_FLAG2 は 0x80", () => {
    expect(CLIENT_FLAG2).toBe(0x80);
  });

  it.each([
    ["READ MDT FIELDS 応答", () => buildReadMdtResponse(screen(), codec, AID.ENTER).record],
    ["READ MDT IMMEDIATE ALT 応答", () => buildReadMdtImmediateAltResponse(screen(), codec).record],
    ["READ INPUT FIELDS 応答", () => buildReadInputFieldsResponse(screen(), codec, AID.ENTER).record],
    ["READ IMMEDIATE 応答", () => buildReadImmediateResponse(screen(), codec).record],
    ["READ SCREEN 応答", () => buildReadScreenResponse(screen(), codec, OPCODE.READ_SCREEN)],
    ["READ SCREEN EXTENDED 応答", () => buildReadScreenExtendedResponse(screen(), codec, OPCODE.READ_SCREEN)],
    ["SAVE SCREEN 応答", () => buildSaveScreenResponse(screen(), codec, OPCODE.SAVE_SCREEN).record],
    ["SAVE PARTIAL SCREEN 応答", () => buildSavePartialScreenResponse(screen(), codec, OPCODE.SAVE_SCREEN).record],
    ["Query Reply", () => buildQueryReply("IBM-5555-C01")]
  ])("%s は 0x80", (_name, build) => {
    expect(build()[FLAG2]).toBe(0x80);
  });

  it.each([
    ["Attn", () => buildFlagRecord({ atn: true })],
    ["SysReq", () => buildFlagRecord({ srq: true })],
    ["Cancel Invite への返事", () => buildCancelInviteAck()]
  ])("%s は 0 のまま（実機で確かめた非常口を変えない）", (_name, build) => {
    expect(build()[FLAG2]).toBe(0x00);
  });
});
