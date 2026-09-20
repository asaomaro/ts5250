import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { OPCODE, COMMAND } from "../src/protocol/constants.js";
import type { Transport } from "../src/transport/types.js";

/**
 * PUB400 実機で SEU の F1 を押したとき、ホストが返してきたのはこの 12 バイトだけだった。
 * opcode 0x04 / ESC 0x02 のいずれも SAVE SCREEN で、**ホストは端末からの返信を待っている**。
 * 返さなかったため 30 秒のタイムアウトまでヘルプが出なかった。
 */
const SAVE_SCREEN_RECORD = [
  0x00, 0x0c, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x04, 0x04, 0x02
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

describe("SAVE SCREEN を受けたらホストへ返信する", () => {
  it("実機が送ってきた 12 バイトに対して RESTORE SCREEN の応答レコードを書き出す", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 300 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    const before = written.length;
    feed([...SAVE_SCREEN_RECORD, ...IAC_EOR]);
    await new Promise((r) => setTimeout(r, 30));

    const sent = written.slice(before);
    expect(sent.length, "返信を 1 本書き出している").toBeGreaterThan(0);
    // **応答の opcode は受信したレコードの写し**（上の実機バイト列の 10 バイト目＝0x04）。
    // ACS も `DS5250.processSaveScreen` が `WorkHeader.Opcode` をそのまま書く
    // （`20260920-restore-screen-parity` research F14 / decisions D8）
    const rec = sent.find((d) => d[9] === OPCODE.SAVE_SCREEN);
    expect(rec, "RESTORE SCREEN の応答が含まれる").toBeDefined();
    expect(rec?.[11], "本体は ESC RESTORE SCREEN で始まる").toBe(COMMAND.RESTORE_SCREEN);

    await p;
  });
});

/**
 * **1 レコードに SAVE が 2 回入っても、段ごとに積荷が添えられる。**
 *
 * 退避はコマンドごとに起こるのに、応答を組むのはレコードを流し終えた後なので、
 * 「スタックの頂点に添える」実装だと**先の段が空のまま残り、その段の RESTORE で
 * 積荷を画面へ適用してしまう**（＝この work が直した欠陥が無警告で再発する。
 * `20260920-restore-screen-parity` の T4 独立点検が dist で実測した）。
 *
 * **セッション層を通して確かめる**——本番は 2 本の応答を「レコード適用後のおなじ画面」から
 * 組むので**積荷がバイト単位で同一**になり、ビルダーを直に呼ぶテストでは
 * 段の取り違えが起きても差が出ない（同 work review ラウンド 2 の指摘）。
 */
describe("1 レコードに SAVE が 2 回", () => {
  /** `ESC 02`（SAVE SCREEN）と `ESC 03 + 5 バイト`（SAVE PARTIAL）を 1 レコードに積む */
  const TWO_SAVES = [
    0x00, 0x13, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x04,
    0x04, 0x02, // ESC SAVE SCREEN
    0x04, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00 // ESC SAVE PARTIAL ＋ パラメータ 5 バイト
  ];

  it("応答を 2 本返し、**どちらの段を復元しても警告が出ない**（＝両段に積荷が添えられている）", async () => {
    const { transport, written, feed } = fakeTransport();
    const warns: string[] = [];
    const p = Session5250.connect({
      id: "t", transport, negotiationTimeoutMs: 300, warn: (m) => warns.push(m)
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    const before = written.length;
    feed([...TWO_SAVES, ...IAC_EOR]);
    await new Promise((r) => setTimeout(r, 30));
    const saves = written.slice(before).filter((d) => d[11] === COMMAND.RESTORE_SCREEN);
    expect(saves, "退避 1 回につき応答 1 本").toHaveLength(2);

    // ホストは預かった積荷をそのまま返してくる。**2 段目 → 1 段目**の順に復元する
    warns.length = 0;
    for (const rec of [saves[1]!, saves[0]!]) {
      // 送ったレコードから GDS ヘッダ（10B）と末尾の IAC EOR（2B）を外すと、`ESC 12` ＋ 積荷
      const payloadRecord = rec.subarray(10, rec.length - 2);
      feed([...header(payloadRecord.length), ...payloadRecord, ...IAC_EOR]);
      await new Promise((r) => setTimeout(r, 20));
    }
    // **警告が 1 本も出ないことを見る。** 部分集合（`no payload recorded` 等）だけを見ると、
    // レコードが壊れて復元に到達しなくても緑になる（`ll` を +1 して `record parse error` を
    // 起こしても通ることを委譲先が実測。`20260920-restore-screen-parity` review ラウンド 3）
    // `empty save stack`（復元できなかった）も `record parse error`（レコードが壊れた）も、
    // すべてここで落ちる
    expect(warns, warns.join(" / ")).toEqual([]);

    await p;
  });

  /** 本体長から GDS ヘッダ 10 バイトを組む（opcode は RESTORE SCREEN 相当の 0x05） */
  function header(bodyLen: number): number[] {
    const ll = bodyLen + 10;
    return [(ll >> 8) & 0xff, ll & 0xff, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x05];
  }
});
