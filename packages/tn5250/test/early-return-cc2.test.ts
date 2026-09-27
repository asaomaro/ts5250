import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

/**
 * **その場で戻る否定応答では、同じレコードで先に来た CC2（警報・メッセージ待ち）を効かせない**（`20260927-early-return-cc2`）。
 * ACS `DS5250.processCommand` は ESC が無い・CLEAR UNIT ALTERNATE の引数・ROLL の指定・WSF が短いで直ちに戻り、レコードの終わりの `processWCC2` を飛ばす。
 * 実機（社内機）で DSM に WTD（CC2＝0x01 メッセージ待ちを点ける）＋不正な ROLL の 1 レコードを出させると、ACS のコアは点けず、当 PJ（直す前）は点けた
 * （`scripts/acs-probe/early-return-cc2.txt`・`scripts/verify-early-return-cc2.mjs`）。
 * WSF D9/72 のフラグ 0x80 は ACS も終わりまで走る（`processWSF` が `sense_code` を立ててループの条件で抜ける）ので CC2 は効く
 */
const codec = codecForCcsid(37);
const apply = (stream: number[]) => applyDataStream(Uint8Array.from(stream), new ScreenBuffer(), codec, () => {});
/** WTD（CC1 0・CC2 は引数）で 5 行 2 桁に "X" */
const wtd = (cc2: number): number[] => [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, cc2, ORDER.SBA, 5, 2, 0xe7];
const BAD_ROLL = [ESC, COMMAND.ROLL, 0x05, 0x0a, 0x05];

describe("その場で戻る否定応答は CC2 を落とす", () => {
  it("**WTD（メッセージ待ちを点ける）＋不正な ROLL: メッセージ待ちは変えない**（実機の ACS と同じ）", () => {
    const r = apply([...wtd(0x01), ...BAD_ROLL]);
    expect(r.senseCode).toBe(0x1005012c);
    expect(r.messageWaiting).toBeUndefined();
  });

  it("WTD（メッセージ待ちを消す）＋不正な ROLL: 消しもしない", () => {
    const r = apply([...wtd(0x02), ...BAD_ROLL]);
    expect(r.messageWaiting).toBeUndefined();
  });

  it("WTD（警報）＋CLEAR FORMAT TABLE＋ESC の無いバイト: 警報を鳴らさない（パラメータの無いコマンドの後ろに置く——WTD の直後だと本文として読まれる）", () => {
    const r = apply([...wtd(0x04), ESC, COMMAND.CLEAR_FORMAT_TABLE, 0x99]);
    expect(r.senseCode).toBe(0x10050121);
    expect(r.alarm).toBe(false);
  });

  it("WTD（警報）＋CLEAR UNIT ALTERNATE の引数が 0 でない: 警報を鳴らさない", () => {
    const r = apply([...wtd(0x04), ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x01]);
    expect(r.senseCode).toBe(0x10030101);
    expect(r.alarm).toBe(false);
  });

  it("WTD（警報）＋短い WSF: 警報を鳴らさない", () => {
    const r = apply([...wtd(0x04), ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00]);
    expect(r.senseCode).toBe(0x10050121);
    expect(r.alarm).toBe(false);
  });

  it("**WSF D9/72 のフラグ 0x80 では CC2 は効く**（ACS も終わりまで走る）", () => {
    const r = apply([...wtd(0x05), ESC, COMMAND.WRITE_STRUCTURED_FIELD, 0x00, 0x06, 0xd9, 0x72, 0x80, 0x00]);
    expect(r.senseCode).toBe(0x10050112);
    expect(r.alarm).toBe(true);
    expect(r.messageWaiting).toBe(true);
  });

  it("**SAVE PARTIAL より前の CC2 は残る**（ACS の SAVE PARTIAL はそれまでの CC2 をその場で効かせる）。後ろの WTD の CC2 は落とす", () => {
    const r = apply([...wtd(0x01), ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0, ...wtd(0x04), ...BAD_ROLL]);
    expect(r.senseCode).toBe(0x1005012c);
    expect(r.messageWaiting).toBe(true);
    expect(r.alarm).toBe(false);
  });

  it("SAVE PARTIAL の前で消し、後ろで点けてから戻る: 消えたまま（ACS も SAVE PARTIAL の時点で消え、後ろの点灯は尾部を飛ばす）", () => {
    const r = apply([...wtd(0x02), ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0, ...wtd(0x01), ...BAD_ROLL]);
    expect(r.messageWaiting).toBe(false);
  });

  it("SAVE PARTIAL が 2 つ: 2 つ目の時点の CC2 まで残る", () => {
    const sp = [ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0, 0, 0, 0, 0];
    const r = apply([...wtd(0x01), ...sp, ...wtd(0x04), ...sp, ...wtd(0x02), ...BAD_ROLL]);
    expect(r.messageWaiting).toBe(true);
    expect(r.alarm).toBe(true);
  });

  it("否定応答が無ければ CC2 は効く（従来どおり）", () => {
    const r = apply(wtd(0x05));
    expect(r.senseCode).toBeUndefined();
    expect(r.alarm).toBe(true);
    expect(r.messageWaiting).toBe(true);
  });

  it("画面への書き込みは残る（ACS も戻る前の WTD は画面に書いている——実機で 5 行目に EARLY ROLL が出た）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([...wtd(0x01), ...BAD_ROLL]), buf, codec, () => {});
    expect(buf.snapshot().cells[4]![1]!.char).toBe("X");
  });
});
