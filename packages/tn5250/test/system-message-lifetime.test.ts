import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

/**
 * **システム・メッセージ（WRITE ERROR CODE の本文）は、メッセージ行が書き替わったら消える。**
 *
 * ACS は本文をメッセージ行のセルそのものへ書くので、後続の画面がその行を書けば自然に消える。
 * 当方は本文を `systemMessage` として別に持つため、同じ寿命になるよう明示的に捨てる
 * （`ScreenBuffer.clearSystemMessageIfTouched`）。以前は CLEAR UNIT でしか消えず、PA0100R で
 * 「前ページはありません。」の後に F12 で戻っても残り続けた（ホストは `EA` で行を消している）。
 *
 * メッセージ行は SOH 本体 4 バイト目の申告（1〜画面行数のときだけ採る。既定 24＝ACS の初期値）。
 * SAVE SCREEN / SAVE PARTIAL SCREEN でも解除する（ACS `processSaveScreen` の冒頭）。
 */
const codec = codecForCcsid(37);
const WTD = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00];
const soh = (msgRow: number): number[] => [ORDER.SOH, 7, 0x00, 0x00, 0x00, msgRow, 0x00, 0x00, 0x00];
const text = (s: string): number[] => [...codec.encode(s).bytes];

function apply(buf: ScreenBuffer, stream: number[]): void {
  applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
}

/** WEC でメッセージを出した画面（`msgRow` は SOH で申告するメッセージ行。0 なら申告なし） */
function withMessage(msgRow = 0): ScreenBuffer {
  const buf = new ScreenBuffer();
  apply(buf, [...WTD, ...soh(msgRow), ORDER.SBA, 1, 1, ...text("TITLE")]);
  apply(buf, [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...text("NO PREVIOUS PAGE")]);
  expect(buf.systemMessage).toBe("NO PREVIOUS PAGE");
  return buf;
}

describe("メッセージ行が書き替わったらシステム・メッセージを捨てる", () => {
  it("既定のメッセージ行（24 行目）へ文字を書くと消える", () => {
    const buf = withMessage();
    apply(buf, [...WTD, ORDER.SBA, 24, 2, ...text("NEXT")]);
    expect(buf.systemMessage).toBeUndefined();
  });

  it("EA でメッセージ行を消去しても消える（PA0100R の F12 で戻る応答）", () => {
    const buf = withMessage();
    apply(buf, [...WTD, ORDER.SBA, 23, 1, ORDER.EA, 24, 80, 0x02, 0xff]);
    expect(buf.systemMessage).toBeUndefined();
  });

  it("メッセージ行以外を書き替えても残る", () => {
    const buf = withMessage();
    apply(buf, [...WTD, ORDER.SBA, 5, 1, ...text("DETAIL")]);
    expect(buf.systemMessage).toBe("NO PREVIOUS PAGE");
  });

  it("SOH がメッセージ行を申告したら、その行への書き込みで消える（24 行目では消えない）", () => {
    const buf = withMessage(22);
    apply(buf, [...WTD, ORDER.SBA, 24, 2, ...text("FOOTER")]);
    expect(buf.systemMessage).toBe("NO PREVIOUS PAGE");
    apply(buf, [...WTD, ORDER.SBA, 22, 2, ...text("NEXT")]);
    expect(buf.systemMessage).toBeUndefined();
  });

  it("画面行数を超える申告は採らない（既定の 24 行目のまま）", () => {
    const buf = withMessage(30);
    apply(buf, [...WTD, ORDER.SBA, 24, 2, ...text("NEXT")]);
    expect(buf.systemMessage).toBeUndefined();
  });

  it("同じレコードでメッセージを出した後に他の行を書いても残る", () => {
    const buf = new ScreenBuffer();
    apply(buf, [
      ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...text("ERROR"),
      ...WTD, ORDER.SBA, 5, 1, ...text("DETAIL")
    ]);
    expect(buf.systemMessage).toBe("ERROR");
  });
});

describe("SAVE SCREEN でシステム・メッセージを解除する（ACS `processSaveScreen`）", () => {
  it("SAVE SCREEN（0x02）", () => {
    const buf = withMessage();
    apply(buf, [ESC, COMMAND.SAVE_SCREEN]);
    expect(buf.systemMessage).toBeUndefined();
  });

  it("SAVE PARTIAL SCREEN（0x03）", () => {
    const buf = withMessage();
    apply(buf, [ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(buf.systemMessage).toBeUndefined();
  });
});

/**
 * **WRITE ERROR CODE が届くたびに通し番号を振る**（`20260921-host-error-mode`）。
 * ACS はホストのエラーのたびにエラー状態に入る（`processWriteErrorCode` → `setErrorMode(true)`）。
 * 同じ文言のエラーがもう一度来たことを UI が見分けられないと、2 回目でエラー状態に入れない。
 */
describe("WRITE ERROR CODE の通し番号（systemMessageSeq）", () => {
  const wec = (msg: string): number[] => [ESC, COMMAND.WRITE_ERROR_CODE, ...text(msg)];

  it("**同じ文言でも、届くたびに番号が変わる**", () => {
    const buf = new ScreenBuffer();
    apply(buf, [...WTD, ORDER.SBA, 1, 1, ...text("TITLE")]);
    expect(buf.snapshot("s").systemMessageSeq, "メッセージが無ければ付かない").toBeUndefined();
    apply(buf, wec("RANGE 1-5"));
    const first = buf.snapshot("s").systemMessageSeq;
    expect(first).toBeDefined();
    apply(buf, wec("RANGE 1-5"));
    const second = buf.snapshot("s").systemMessageSeq;
    expect(second, "同じ文言の 2 回目で番号が変わらない").not.toBe(first);
    expect(buf.snapshot("s").systemMessage).toBe("RANGE 1-5");
  });

  it("**バッファを作り直しても番号は重ならない**（繋ぎ直しで作り直すため）", () => {
    const a = new ScreenBuffer();
    apply(a, wec("E1"));
    const b = new ScreenBuffer();
    apply(b, wec("E1"));
    expect(b.snapshot("s").systemMessageSeq).not.toBe(a.snapshot("s").systemMessageSeq);
  });

  it("メッセージが消えたら番号も付かない", () => {
    const buf = withMessage();
    expect(buf.snapshot("s").systemMessageSeq).toBeDefined();
    buf.clearUnit();
    expect(buf.snapshot("s").systemMessage).toBeUndefined();
    expect(buf.snapshot("s").systemMessageSeq).toBeUndefined();
  });
});
