import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { OPCODE } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";

/**
 * PUB400 実機で、ASSUME 付き DSPF の WINDOW（別の表示ファイルが描いた全画面の上に
 * ウィンドウを重ねる）を EXFMT したとき、ホストが最初に送ってきたのがこの 12 バイト。
 * opcode 0x08 / ESC 0x62 は READ SCREEN で、**ホストは端末が画面イメージを返信するのを待つ**。
 * 返さないとホストは先へ進まず、後続のウィンドウ描画を送ってこない（キーボードがロックのまま）。
 */
const READ_SCREEN_RECORD = [
  0x00, 0x0c, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x08, 0x04, 0x62
];
const IAC_EOR = [0xff, 0xef];

function fakeTransport(): { transport: Transport; written: Uint8Array[]; feed: (b: number[]) => void } {
  const written: Uint8Array[] = [];
  let onData: ((d: Uint8Array) => void) | undefined;
  const transport = {
    onData: (cb: (d: Uint8Array) => void) => {
      onData = cb;
    },
    onClose: () => {},
    onError: () => {},
    send: (d: Uint8Array) => {
      written.push(d);
    },
    close: () => {}
  } as unknown as Transport;
  return { transport, written, feed: (b) => onData?.(Uint8Array.from(b)) };
}

describe("READ SCREEN を受けたらホストへ画面イメージを返信する", () => {
  it("実機が送ってきた 12 バイトに対して PUT_GET の応答レコードを書き出す", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 300 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    const before = written.length;
    feed([...READ_SCREEN_RECORD, ...IAC_EOR]);
    await new Promise((r) => setTimeout(r, 30));

    const sent = written.slice(before);
    expect(sent.length, "返信を 1 本書き出している").toBeGreaterThan(0);
    // GDS ヘッダの opcode 位置（10 バイト目）が PUT_GET（読み取り応答）
    const rec = sent.find((d) => d[9] === OPCODE.PUT_GET);
    expect(rec, "READ SCREEN の応答（画面イメージ）が含まれる").toBeDefined();

    await p;
  });
});

/**
 * 拡張 5250 を申告した端末には、ホストは READ SCREEN の拡張版（ESC 0x64）を送ってくる
 * （日本語実機の PDM F1 ヘルプで確認）。0x62 と同じく返信しないとホストは停止する。
 */
const READ_SCREEN_EXTENDED_RECORD = [
  0x00, 0x0c, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x08, 0x04, 0x64
];

describe("READ SCREEN EXTENDED（0x64）は行区切り形式で応答する", () => {
  it("opcode READ_SCREEN・flag2 0x80 で、行数ぶんの 0xFF 区切りを返す", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 300 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    const before = written.length;
    feed([...READ_SCREEN_EXTENDED_RECORD, ...IAC_EOR]);
    await new Promise((r) => setTimeout(r, 30));

    const rec = written.slice(before).find((d) => d[9] === OPCODE.READ_SCREEN);
    expect(rec, "READ SCREEN EXTENDED の応答が含まれる").toBeDefined();
    expect(rec![8], "フラグ 2 バイト目は 0x80（ACS 実機と同じ）").toBe(0x80);
    // 本体は「行の内容 + 0xFF」を 24 行ぶん。IAC(0xFF) は telnet 層で二重化されるので数え方に注意
    const body = rec!.subarray(10, rec!.length - 2); // 末尾の IAC EOR を除く
    let delimiters = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 0xff) {
        delimiters++;
        i++; // 二重化された 2 バイト目を読み飛ばす
      }
    }
    expect(delimiters, "24 行ぶんの行区切り").toBe(24);

    await p;
  });
});
