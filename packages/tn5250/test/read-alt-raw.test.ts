import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse, buildReadMdtAltResponse, buildReadMdtImmediateAltResponse } from "../src/protocol/read-response.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

const codec = codecForCcsid(37);

/**
 * **READ の欄データの加工は 0x52 と ALT（0x82・0x83）で違う**（ACS `DS5250.sendAll`。`20260927-read-alt-raw`）。
 * 実機の ACS のコア（`scripts/acs-probe/read-alt.txt`・DSM の READALT）がホストに送った欄データをそのまま期待値にした:
 *
 * | 欄（ホストが書いた中身。MDT あり） | 0x52 | 0x82・0x83 |
 * |---|---|---|
 * | 長さ10 `AB C`＋実空白 6 | `c1c240c3404040404040` | 同じ |
 * | 長さ10 `A` NUL `B`＋NUL 7 | `c140c2` | `c100c2` |
 * | 長さ6 符号付き `  012-` | `4040f0f1d2` | `4040f0f1f260` |
 * | 長さ6 符号付き `   12 ` | `404040f1f2` | `404040f1f240` |
 *
 * 当 PJ は以前、どれでも末尾の空白を落とし・NUL を空白にし・符号を畳んでいた（実機で当 PJ を当てて 3 件とも食い違った。`scripts/verify-read-alt.mjs`）
 */
function screen(): ScreenBuffer {
  const buf = new ScreenBuffer();
  const sf = (row: number, ffw1: number, len: number) => [ORDER.SBA, row, 9, ORDER.SF, ffw1, 0x00, 0x24, 0x00, len];
  applyDataStream(
    Uint8Array.from([
      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ...sf(5, 0x48, 10), 0xc1, 0xc2, 0x40, 0xc3, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
      ...sf(7, 0x48, 10), 0xc1, 0x00, 0xc2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ...sf(9, 0x4f, 6), 0x40, 0x40, 0xf0, 0xf1, 0xf2, 0x60,
      ...sf(11, 0x4f, 6), 0x40, 0x40, 0x40, 0xf1, 0xf2, 0x40
    ]),
    buf,
    codec
  );
  return buf;
}

/** 応答の欄データを SBA ごとに割って 16 進にする（行・桁・AID の 3 バイトの後ろから） */
function fields(record: Uint8Array): string[] {
  const b = [...record];
  const body = b.slice(b.indexOf(ORDER.SBA));
  const out: string[] = [];
  let cur: number[] | undefined;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === ORDER.SBA && (cur === undefined || i + 2 < body.length) && [5, 7, 9, 11].includes(body[i + 1]!) && body[i + 2] === 10) {
      if (cur) out.push(cur.map((x) => x.toString(16).padStart(2, "0")).join(""));
      cur = [];
      i += 2;
      continue;
    }
    cur!.push(body[i]!);
  }
  if (cur) out.push(cur.map((x) => x.toString(16).padStart(2, "0")).join(""));
  return out;
}

describe("READ の欄データの加工（ACS と同じ）", () => {
  it("**0x52**: 末尾の NUL だけ落とし、途中の NUL は空白、符号を畳む。末尾の実空白は送る", () => {
    expect(fields(buildReadMdtResponse(screen(), codec, 0xf1).record)).toEqual([
      "c1c240c3404040404040", "c140c2", "4040f0f1d2", "404040f1f2"
    ]);
  });

  it("**0x82**: 末尾の NUL だけ落とす。途中の NUL（0x00）も符号の桁もそのまま", () => {
    expect(fields(buildReadMdtAltResponse(screen(), codec, 0xf1).record)).toEqual([
      "c1c240c3404040404040", "c100c2", "4040f0f1f260", "404040f1f240"
    ]);
  });

  it("**0x83**: 0x82 と同じ加工（AID は 0）", () => {
    const { record } = buildReadMdtImmediateAltResponse(screen(), codec);
    expect(fields(record)).toEqual(["c1c240c3404040404040", "c100c2", "4040f0f1f260", "404040f1f240"]);
    expect(record[record.indexOf(ORDER.SBA) - 1]).toBe(0x00);
  });

  it("打鍵で書き換えた欄は、値の後ろが NUL（空のセル）になるので落ちる", () => {
    const buf = screen();
    buf.setFieldValue(buf.orderedFields()[0]!, "XY");
    expect(fields(buildReadMdtResponse(buf, codec, 0xf1).record)[0]).toBe("e7e8");
  });
});
