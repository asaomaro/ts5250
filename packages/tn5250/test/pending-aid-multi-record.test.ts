import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * `sendAid()`（`pendingAid`）が、1回のAIDキー送信に対する応答が複数レコードに分かれ、
 * かつ先行レコードが「Read を伴わないキーボード解放」だけを行う場合でも、**実際に
 * Read が要求された最終レコードまで解決を待つ**ことの回帰テスト。
 *
 * 経緯: `.aidev/works/20260915-dspfmt-reconnect-blank-redraw`。利用者から
 * 「DSPFMT FILE(TESTLIB/COMPLIST) OUTPUT(*) を実行すると、初回表示が罫線のみになり、
 * Enter を押すと正常化する」という報告を受けた。実機トレースの結果、DSPFMT の応答は
 * 3レコードに分かれ、1・2番目は `unlockKeyboard=true, readRequested=false`（骨格だけの
 * Write to Display）、3番目だけが `readRequested=true`（実データ・カーソル位置を含む）
 * だった（research.md F3）。旧実装は `unlockKeyboard` が立った最初のレコード（1番目、
 * 骨格だけ）で `pendingAid` を解決していたため、`sendAid()` の解決値（＝`key-done` の
 * 中身）がデータの埋まっていない画面のまま固まっていた（research.md F1'。フレッシュな
 * 接続・コア層単体で100%決定的に再現）。
 *
 * 修正: `handleRecord()` の解決条件を `unlockKeyboard` から `readRequested` に切り替えた
 * （`session.ts` の `readSolicited`）。
 */
function frame(record: Uint8Array): Uint8Array {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return Uint8Array.from(framed);
}

/**
 * `sendaid-cursor-sync.test.ts` と同じ理由で `DeferredTransport` を使う——
 * `ReplayTransport` は `send()` と同じ同期区間で次の rx を配送してしまうため、
 * 「1レコード目を届けた直後・2レコード目はまだ」という一瞬を作れない。
 */
class DeferredTransport implements Transport {
  private dataFn: ((data: Uint8Array) => void) | undefined;
  constructor(private readonly initial: Uint8Array) {}
  start(): void {
    this.dataFn?.(this.initial);
  }
  send(_data: Uint8Array): void {}
  close(): void {}
  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(_fn: (reason: string) => void): void {}
  onError(_fn: (err: Error) => void): void {}
  /** 保留していた応答を今届ける */
  deliver(data: Uint8Array): void {
    this.dataFn?.(data);
  }
}

const FIELD_A = { row: 5, col: 10, len: 6 }; // 骨格レコードが作る欄 → (5,11)〜(5,16)
const FIELD_B = { row: 8, col: 10, len: 6 }; // 最終レコードが作る欄 → (8,11)〜(8,16)

/** 初期画面（接続時に1回だけ届く、read 付きの通常応答）。FIELD_A に IC */
function initialScreen(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x08); // cc2: CC2_UNLOCK のみ
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.IC).u8(FIELD_A.row).u8(FIELD_A.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * DSPFMT の1・2番目のレコードに相当する「骨格だけ」のレコード。
 * WCC の CC2_UNLOCK ビット（0x08）だけを立ててキーボードを解放するが、
 * **Read コマンドを伴わない**（IC も無い——ホストが位置を指定しない）。
 */
function skeletonRecordNoRead(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x08);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * DSPFMT の3番目のレコードに相当する「実データ」のレコード。FIELD_B を作り、
 * IC で指す。Read コマンドを伴う（`readRequested=true`）。
 */
function finalRecordWithRead(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x08);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(FIELD_B.row).u8(FIELD_B.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

describe("sendAid() は複数レコードに分かれた応答で、Read が要求されるまで解決を待つ", () => {
  it("骨格レコード（unlockのみ・read無し）だけでは解決しない。実データレコード（read付き）で初めて解決し、その内容を反映する", async () => {
    const transport = new DeferredTransport(frame(initialScreen()));
    const session = await Session5250.connect({ transport, id: "t" });
    expect(session.snapshot().cursor).toEqual({ row: FIELD_A.row, col: FIELD_A.col + 1 });

    let resolved: Awaited<ReturnType<typeof session.sendAid>> | undefined;
    const pending = session.sendAid("Enter", { timeoutMs: 2000 }).then((r) => {
      resolved = r;
      return r;
    });

    // 骨格レコード（unlockのみ）を届ける
    transport.deliver(frame(skeletonRecordNoRead()));
    // マイクロタスクを1周させても、まだ解決していないはず
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    // ライブのバッファ状態は骨格レコードを反映済み（IC が無いので旧位置のまま）
    expect(session.snapshot().cursor).toEqual({ row: FIELD_A.row, col: FIELD_A.col + 1 });

    // 実データレコード（read付き）を届ける
    transport.deliver(frame(finalRecordWithRead()));
    const result = await pending;

    expect(result.timedOut).toBe(false);
    // 解決される画面は実データレコード（FIELD_B）の内容——骨格レコードのままではない
    expect(result.screen.cursor).toEqual({ row: FIELD_B.row, col: FIELD_B.col + 1 });
    expect(session.snapshot().cursor).toEqual({ row: FIELD_B.row, col: FIELD_B.col + 1 });
  });

  it("骨格レコードの段階では this.state もまだ ready にならない（keyboardLocked が保たれる）", async () => {
    const transport = new DeferredTransport(frame(initialScreen()));
    const session = await Session5250.connect({ transport, id: "t" });

    const pending = session.sendAid("Enter", { timeoutMs: 2000 });
    transport.deliver(frame(skeletonRecordNoRead()));
    await Promise.resolve();
    await Promise.resolve();
    // 骨格レコードは unlockKeyboard を伴うが readRequested を伴わないため、
    // "screen" イベント相当の keyboardLocked はまだ true のまま
    expect(session.snapshot().keyboardLocked).toBe(true);

    transport.deliver(frame(finalRecordWithRead()));
    await pending;
    expect(session.snapshot().keyboardLocked).toBe(false);
  });

  it("\"screen\" イベントは readSolicited の判定と無関係に、レコードごとに必ず発火する（design.md「振る舞いの詳細」の不変条件）", async () => {
    // pendingAid の解決条件は変えたが、emit("screen", snap) 自体は毎レコード無条件に
    // 発火し続ける——web-ui の🔒表示・busyインジケータはこのイベント経由で骨格レコードの
    // 段階（keyboardLocked=true）も受け取れる必要がある（design.md「副次的な改善」）。
    const transport = new DeferredTransport(frame(initialScreen()));
    const session = await Session5250.connect({ transport, id: "t" });

    const screens: boolean[] = []; // 各 "screen" イベント時点の keyboardLocked を記録
    session.on("screen", (snap) => { screens.push(snap.keyboardLocked); });

    const pending = session.sendAid("Enter", { timeoutMs: 2000 });
    transport.deliver(frame(skeletonRecordNoRead()));
    await Promise.resolve();
    await Promise.resolve();
    // 骨格レコードの時点で、"screen" イベントは既に1回発火しているはず（施錠中）
    expect(screens).toEqual([true]);

    transport.deliver(frame(finalRecordWithRead()));
    await pending;
    // 実データレコードでもう1回発火し、今度は解錠されている
    expect(screens).toEqual([true, false]);
  });
});
