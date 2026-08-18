import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC } from "../src/protocol/constants.js";
import { IAC, CMD, OPT, TT_SEND } from "../src/telnet/constants.js";
import { AID } from "../src/session/aid-keys.js";

/**
 * **IBM i では 3270 の `PFn` は F キーではない。**
 *
 * 出典は IBM i 自身の「ヘルプ－ 3270 キーボード・マッピング」画面
 * （3270 で繋いで `PF2` を押すと出る。実機で読んだ）:
 *
 * ```
 * PF3 = 画面の消去              PF7 = 前ページ・キー
 * PA1 PF1..PF12 → F1..F12       PA2 PF1..PF12 → F13..F24
 * PF13..PF24    → F13..F24
 * ```
 *
 * 実機で `PF3` を送ると「機能キーは使用できません。」と返り、
 * `PA1`→（解錠待ち）→`PF4` で F4（プロンプト）が効いた。
 */
const ENV_SEND = 1;

class MockTransport implements Transport {
  sent: number[][] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  send(data: Uint8Array): void {
    this.sent.push([...data]);
  }
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  recv(...b: number[]): void {
    this.dataFn?.(Uint8Array.from(b));
  }
  recvRecord(bytes: number[]): void {
    this.recv(...bytes, IAC, CMD.EOR);
  }
  /** 送ったレコードのうち、AID で始まるもの（telnet の交渉は除く） */
  aids(): number[] {
    return this.sent.filter((r) => r[0] !== IAC).map((r) => r[0]!);
  }
}

/** `newEnviron` を true にすると **IBM i と同じ交渉**（`DO NEW-ENVIRON` ＋ SEND）になる */
function connected(newEnviron: boolean): { s: Tn3270Session; t: MockTransport } {
  const t = new MockTransport();
  const s = new Tn3270Session({ host: "x", model: 2 });
  s.attach(t);
  if (newEnviron) {
    t.recv(IAC, CMD.DO, OPT.NEW_ENVIRON);
    t.recv(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
  }
  t.recv(IAC, CMD.DO, OPT.TERMINAL_TYPE);
  t.recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
  t.recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
  t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
  t.recvRecord([CMD3270.ERASE_WRITE, WCC.RESTORE, ORDER.SBA, ...encodeAddress(0), ORDER.SF, 0x00]);
  return { s, t };
}

/** ホストが施錠を解く（WCC の restore） */
const restore = (t: MockTransport): void => t.recvRecord([CMD3270.WRITE, WCC.RESTORE]);

describe("ホストの見分け", () => {
  it("**NEW-ENVIRON を交渉してきたら IBM i とみなす**（実測: IBM i だけが出す）", () => {
    expect(connected(true).s.isIbmI).toBe(true);
    expect(connected(true).s.negotiatedNewEnviron).toBe(true);
  });

  it("出さないホスト（メインフレーム）は IBM i ではない", () => {
    expect(connected(false).s.isIbmI).toBe(false);
  });
});

describe("F キーの送り方", () => {
  it("**メインフレームは素の PFn**（従来どおり）", async () => {
    const { s, t } = connected(false);
    await s.sendFunctionKey(3);
    expect(t.aids()).toEqual([AID.pf3]);
  });

  it("**IBM i は F1〜F12 を `PA1` ＋ `PFn`**", async () => {
    const { s, t } = connected(true);
    const p = s.sendFunctionKey(3);
    // PA1 を送った時点で施錠される
    expect(t.aids()).toEqual([AID.pa1]);
    expect(s.status).toBe("locked");
    restore(t);
    await p;
    expect(t.aids()).toEqual([AID.pa1, AID.pf3]);
  });

  it("**IBM i でも F13〜F24 は素の PFn**（往復が 1 回で済む。実機で確認）", async () => {
    const { s, t } = connected(true);
    await s.sendFunctionKey(13);
    expect(t.aids()).toEqual([AID.pf13]);
  });

  it("**解錠が来なければ理由を言って断る**（黙って握らない）", async () => {
    const { s } = connected(true);
    await expect(s.sendFunctionKey(3, { timeoutMs: 60 })).rejects.toThrow(
      /PA1 のあとホストが 60ms たっても入力を許しませんでした/u
    );
  });

  it("範囲外は断る", async () => {
    const { s } = connected(true);
    await expect(s.sendFunctionKey(0)).rejects.toThrow(/1〜24 の範囲外/u);
    await expect(s.sendFunctionKey(25)).rejects.toThrow(/1〜24 の範囲外/u);
  });
});
