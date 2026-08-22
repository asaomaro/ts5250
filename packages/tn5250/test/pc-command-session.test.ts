import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { OPCODE } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";
import type { ScreenSnapshot } from "../src/screen/types.js";

/**
 * PC Organizer（STRPCCMD）を受けたときのセッションの振る舞い。
 *
 * ホストは標識つきの画面を書いて READ MDT FIELDS で待つ（`.aidev/works/20260728-strpco-strpccmd/research.md` D1）。
 * **実行の可否に関わらず実行キーを返す**必要がある——返さないとホストは待ち続け、業務 CL が止まる（D5）。
 * また PC Organizer の中間画面は利用者に見せない（tn5250j も同じ扱い）。
 */

/** 実機 SR-OSAKA の受信レコード（`STRPCCMD PCCMD('echo NOWAIT') PAUSE(*NO)`）。telnet エスケープは無い */
const REC_PAUSE_NO = Uint8Array.from(
  (
    "010b12a0000004000003044004110028010700000019000000150009d960018000000011010227402040004040004027" +
    "40201102022740204000404000402740201101011d482027040a111012200e47ca4655449642d742c343d743bb43c243" +
    "ad43a60f4dd7c3d64bc5e7c55d0e44c047b445e4485248fd4497449644564494448244a4448f44bd43410f2011111220" +
    "0e42d742c3449545e345a5448e44af448a4495449d44cd448744a4448f44bd43410f4020111212200e48eb46cd499044" +
    "8e44af449144a74497449d426b45ed45a443874358444649e1448d4494448844ca448c448243410f201101012780fcd7" +
    "c3d6408380a180818583889640d5d6e6c1c9e3020d4b0004520000"
  )
    .match(/../g)!
    .map((h) => parseInt(h, 16))
);
/** 上と同じレコードの PAUSE(*YES) 版（差は標識直後の 1 バイトと本文） */
const REC_PAUSE_YES = Uint8Array.from(
  (
    "010b12a0000004000003044004110028010700000019000000150009d960018000000011010227402040004040004027" +
    "40201102022740204000404000402740201101011d482027040a111012200e47ca4655449642d742c343d743bb43c243" +
    "ad43a60f4dd7c3d64bc5e7c55d0e44c047b445e4485248fd4497449644564494448244a4448f44bd43410f2011111220" +
    "0e42d742c3449545e345a5448e44af448a4495449d44cd448744a4448f44bd43410f4020111212200e48eb46cd499044" +
    "8e44af449144a74497449d426b45ed45a443874358444649e1448d4494448844ca448c448243410f201101012780fcd7" +
    "c3d6408380a180808583889640e6c1c9e3d4c5020d4b0004520000"
  )
    .match(/../g)!
    .map((h) => parseInt(h, 16))
);
const IAC_EOR = [0xff, 0xef];
/** Enter の AID コード（応答レコードの末尾側に現れる） */
const AID_ENTER = 0xf1;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** AID Enter を含む Read MDT 応答が書き出されたか（GDS opcode は PUT_GET） */
function sentEnterAck(written: Uint8Array[]): boolean {
  return written.some((d) => d[9] === OPCODE.PUT_GET && [...d].includes(AID_ENTER));
}

describe("STRPCCMD を受けたセッション", () => {
  it("実行係へコマンドを渡し、ホストへ実行キーを返す", async () => {
    const { transport, written, feed } = fakeTransport();
    const seen: { command: string; wait: boolean }[] = [];
    const p = Session5250.connect({
      id: "t",
      transport,
      ccsid: 939,
      negotiationTimeoutMs: 300,
      onPcCommand: (cmd) => {
        seen.push(cmd);
      }
    }).catch(() => {});
    await sleep(30);

    const before = written.length;
    feed([...REC_PAUSE_NO, ...IAC_EOR]);
    await sleep(50);

    expect(seen).toEqual([{ command: "echo NOWAIT", wait: false, truncated: false }]);
    expect(sentEnterAck(written.slice(before)), "実行キーを返している").toBe(true);
    await p;
  });

  it("実行係が無くても実行キーは返す（返さないとホストが待ち続ける）", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({ id: "t", transport, ccsid: 939, negotiationTimeoutMs: 300 }).catch(
      () => {}
    );
    await sleep(30);

    const before = written.length;
    feed([...REC_PAUSE_NO, ...IAC_EOR]);
    await sleep(50);

    expect(sentEnterAck(written.slice(before))).toBe(true);
    await p;
  });

  it("実行係が失敗しても実行キーは返す", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({
      id: "t",
      transport,
      ccsid: 939,
      negotiationTimeoutMs: 300,
      onPcCommand: () => Promise.reject(new Error("boom"))
    }).catch(() => {});
    await sleep(30);

    const before = written.length;
    feed([...REC_PAUSE_YES, ...IAC_EOR]);
    await sleep(50);

    expect(sentEnterAck(written.slice(before))).toBe(true);
    await p;
  });

  it("PAUSE(*YES) は実行係の完了を待ってから実行キーを返す", async () => {
    const { transport, written, feed } = fakeTransport();
    let release: (() => void) | undefined;
    const p = Session5250.connect({
      id: "t",
      transport,
      ccsid: 939,
      negotiationTimeoutMs: 300,
      onPcCommand: () => new Promise<void>((r) => (release = r))
    }).catch(() => {});
    await sleep(30);

    const before = written.length;
    feed([...REC_PAUSE_YES, ...IAC_EOR]);
    await sleep(50);
    expect(sentEnterAck(written.slice(before)), "まだ返していない").toBe(false);

    release?.();
    await sleep(30);
    expect(sentEnterAck(written.slice(before)), "完了後に返す").toBe(true);
    await p;
  });

  it("PAUSE(*NO) は実行係の完了を待たずに実行キーを返す", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({
      id: "t",
      transport,
      ccsid: 939,
      negotiationTimeoutMs: 300,
      onPcCommand: () => new Promise<void>(() => {}) // 決して解決しない
    }).catch(() => {});
    await sleep(30);

    const before = written.length;
    feed([...REC_PAUSE_NO, ...IAC_EOR]);
    await sleep(50);

    expect(sentEnterAck(written.slice(before))).toBe(true);
    await p;
  });

  it("PC Organizer の中間画面は利用者に見せない（screen イベントを出さない）", async () => {
    const { transport, feed } = fakeTransport();
    const screens: ScreenSnapshot[] = [];
    const p = Session5250.connect({
      id: "t",
      transport,
      ccsid: 939,
      negotiationTimeoutMs: 300,
      onPcCommand: () => {}
    })
      .then((s) => {
        s.on("screen", (snap) => screens.push(snap));
        return s;
      })
      .catch(() => undefined);
    await sleep(30);

    feed([...REC_PAUSE_NO, ...IAC_EOR]);
    await sleep(50);

    expect(screens).toHaveLength(0);
    await p;
  });
});
