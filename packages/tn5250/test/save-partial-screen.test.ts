import { describe, it, expect } from "vitest";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildSavePartialScreenResponse, buildSaveScreenResponse } from "../src/protocol/save-screen.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { OPCODE, COMMAND, ESC } from "../src/protocol/constants.js";
import { Session5250 } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";

/**
 * SAVE PARTIAL SCREEN（ESC 0x03）。
 *
 * **QSH（Qshell）が起動直後に送ってくる**（実機で実測。
 * `04 03 00 00 00 00 00`＝ESC＋コマンド＋パラメータ 5 バイト、opcode は PUT/GET）。
 * 未処理のときは「unknown command 0x3 — discarding rest of record」で捨てており、
 * **QSH が「待機中・ホストから応答がない」で固まっていた**。
 *
 * ここで固定するのは 3 点:
 *  - パラメータ 5 バイトを**正しく消費する**（後続がずれない）
 *  - **同じレコードの後続コマンドが生き残る**（捨てて待ちに入らない）
 *  - 応答の形（ホストが受理した形。research F2）
 */
const codec = codecForCcsid(37);

/** `ESC 03` ＋ 5 バイト（実機は全て 0） */
const SAVE_PARTIAL = [ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0x00, 0x00, 0x00, 0x00, 0x00];

function apply(stream: number[]): { buf: ScreenBuffer; result: ReturnType<typeof applyDataStream>; warns: string[] } {
  const buf = new ScreenBuffer();
  const warns: string[] = [];
  const result = applyDataStream(Uint8Array.from(stream), buf, codec, (m) => warns.push(m));
  return { buf, result, warns };
}

describe("SAVE PARTIAL SCREEN を受理する", () => {
  it("パラメータ 5 バイトをそのまま渡す（応答へ写すため）", () => {
    const { result } = apply([ESC, COMMAND.SAVE_PARTIAL_SCREEN, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(result.savePartialScreen).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
  });

  it("**捨てない**——同じレコードの後続 WTD が画面に出る", () => {
    // 実機で来た形（0x03 の後ろに続きがある場合を想定）。従来は default 節で
    // レコードごと捨てており、後続の WTD も READ も失われていた
    const { buf, result, warns } = apply([
      ...SAVE_PARTIAL,
      ESC,
      COMMAND.WRITE_TO_DISPLAY,
      0x00,
      0x00,
      0x11,
      0x01,
      0x01, // SBA (1,1)
      0xc1 // "A"
    ]);
    expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
    expect(buf.snapshot().cells[0]![0]!.char).toBe("A");
    expect(result.savePartialScreen).toBeDefined();
  });

  it("**後続の READ も生き残る**（キーボードが開かないまま固まらない）", () => {
    const { result } = apply([...SAVE_PARTIAL, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08]);
    expect(result.readRequested).toBe(true);
    expect(result.unlockKeyboard).toBe(true);
  });

  it("未知のコマンドとして警告しない", () => {
    const { warns } = apply(SAVE_PARTIAL);
    expect(warns).toEqual([]);
  });
});

describe("応答レコードの形（実機が受理した形）", () => {
  function respond(params: number[] = [0, 0, 0, 0, 0]) {
    const buf = new ScreenBuffer();
    applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 0x01, 0x01, 0xc8, 0xc9]),
      buf,
      codec,
      () => {}
    );
    return { record: buildSavePartialScreenResponse(buf, codec, Uint8Array.from(params)), buf };
  }

  it("opcode は RESTORE_SCREEN（ホストが待っている返信）", () => {
    expect(respond().record[9]).toBe(OPCODE.RESTORE_SCREEN);
  });

  /**
   * **先頭は `ESC RESTORE_SCREEN`（0x12）**——SAVE SCREEN の応答と同じ形。
   *
   * 以前は `ESC 13` ＋受け取った 5 バイトの写しを付けていたが、
   * ホストは積荷をそのまま返すため、**それが「ホストからの 0x13」に見えて
   * 5 バイト読み飛ばす**という自作自演になっていた（`20260730-tn5250-cross-check` research F4）。
   * `ESC 12` は局所の退避を戻す目印として長く実機で動いている形。
   */
  it("先頭は ESC RESTORE SCREEN（SAVE SCREEN の応答と同じ形）", () => {
    const { record } = respond();
    expect(record[10]).toBe(ESC);
    expect(record[11]).toBe(COMMAND.RESTORE_SCREEN);
  });

  it("**受け取った 5 バイトは送り返さない**（自作自演の 0x13 を作らない）", () => {
    const { record } = respond([0x11, 0x22, 0x33, 0x44, 0x55]);
    expect([...record]).not.toContain(0x22);
    // 目印の直後はすぐ WTD
    expect(record[12]).toBe(ESC);
    expect(record[13]).toBe(COMMAND.WRITE_TO_DISPLAY);
  });

  it("SAVE SCREEN の応答と**同じバイト列**になる", () => {
    const { record, buf } = respond();
    expect([...record]).toEqual([...buildSaveScreenResponse(buf, codec)]);
  });

  it("送ったストリームを適用し直すと画面が再現する", () => {
    const { record, buf } = respond();
    const replayed = new ScreenBuffer();
    applyDataStream(record.slice(12), replayed, codec, () => {});
    const before = buf.snapshot().cells[0]!.map((c) => c.char).join("");
    const after = replayed.snapshot().cells[0]!.map((c) => c.char).join("");
    expect(after).toBe(before);
  });
});

describe("RESTORE PARTIAL SCREEN（ESC 0x13）", () => {
  /**
   * **実機が返してくる形**（`20260730-datastream-command-census` で採取）:
   *
   *   04 13 | 00 00 00 00 00 | 04 11 00 00 | 11 01 01 … | … 04 52 00 08
   *   ESC 13   パラメータ 5 バイト   ＝こちらが送った WTD      ＝READ
   *
   * 5 バイトを読み飛ばさないと続きを ESC と読み違え、**WTD も READ も失う**
   * （`expected ESC, got 0x0 — discarding rest of record`）。
   */
  it("**パラメータを読まない**（原典どおり）——直後の WTD の先頭を食わない", () => {
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    applyDataStream(Uint8Array.from(SAVE_PARTIAL), buf, codec, (m) => warns.push(m));
    const result = applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.RESTORE_PARTIAL_SCREEN,
        // **パラメータ無しで WTD が続く**（tn5250 が想定している形）
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        0x11, 0x01, 0x01, 0xd4, 0xc1, 0xc9, 0xd5, // SBA(1,1) ＋ "MAIN"
        ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08
      ]),
      buf,
      codec,
      (m) => warns.push(m)
    );
    expect(warns.filter((w) => w.includes("expected ESC"))).toEqual([]);
    expect(buf.snapshot().cells[0]!.slice(0, 4).map((c) => c.char).join("")).toBe("MAIN");
    expect(result.readRequested).toBe(true);
  });

  it("（旧形式）5 バイトが続く形はもう作らない——こちらの応答に写しを入れないため", () => {
    const buf = new ScreenBuffer();
    const warns: string[] = [];
    // 先に 0x03 を受けて退避しておく（実機と同じ順序）
    applyDataStream(Uint8Array.from(SAVE_PARTIAL), buf, codec, (m) => warns.push(m));
    const result = applyDataStream(
      Uint8Array.from([
        ESC, COMMAND.RESTORE_PARTIAL_SCREEN,
        0x00, 0x00, 0x00, 0x00, 0x00, // パラメータ 5 バイト
        ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
        0x11, 0x01, 0x01, 0xd4, 0xc1, 0xc9, 0xd5, // SBA(1,1) ＋ "MAIN"
        ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08
      ]),
      buf,
      codec,
      (m) => warns.push(m)
    );
    // 旧形式（5 バイトが挟まる）を食わせると、その 5 バイトを WTD と読もうとして警告になる
    // ——**こちらが送らなくなったので、この形はもう届かない**（研究 F4 の実験で確認）
    expect(warns.some((w) => w.includes("expected ESC"))).toBe(true);
    void result;
  });

  it("退避した画面へ戻す", () => {
    const buf = new ScreenBuffer();
    const run = (s: number[]) => applyDataStream(Uint8Array.from(s), buf, codec, () => {});
    // "A" を書いて退避 → "B" で上書き → 復元すると "A" に戻る
    run([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 0x01, 0x01, 0xc1]);
    run(SAVE_PARTIAL);
    run([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, 0x11, 0x01, 0x01, 0xc2]);
    expect(buf.snapshot().cells[0]![0]!.char).toBe("B");
    run([ESC, COMMAND.RESTORE_PARTIAL_SCREEN]);
    expect(buf.snapshot().cells[0]![0]!.char).toBe("A");
  });

  it("退避が空なら警告するだけ（落とさない）", () => {
    const { warns } = apply([ESC, COMMAND.RESTORE_PARTIAL_SCREEN]);
    expect(warns.some((w) => w.includes("RESTORE PARTIAL SCREEN"))).toBe(true);
  });

  it("後続のコマンドを捨てない", () => {
    const { result } = apply([
      ESC, COMMAND.RESTORE_PARTIAL_SCREEN,
      ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08
    ]);
    expect(result.readRequested).toBe(true);
  });
});

/**
 * **セッションが実際に送り返すか**。
 *
 * 応答を組み立てられても送らなければホストは待ち続ける（＝症状は何も変わらない）。
 * 実機が QSH の起動直後に送ってきた 19 バイトをそのまま食わせて確かめる。
 */
const SAVE_PARTIAL_RECORD = [
  0x00, 0x11, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03, // ヘッダ（opcode 03＝PUT/GET）
  0x04, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00 // ESC 03 ＋ パラメータ 5 バイト
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

describe("セッションが応答を送り返す", () => {
  it("実機が送ってきた 19 バイトに対して画面を返す応答を書き出す", async () => {
    const { transport, written, feed } = fakeTransport();
    const p = Session5250.connect({ id: "t", transport, negotiationTimeoutMs: 300 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    const before = written.length;
    feed([...SAVE_PARTIAL_RECORD, ...IAC_EOR]);
    await new Promise((r) => setTimeout(r, 30));

    const sent = written.slice(before);
    // 応答は SAVE SCREEN と同じ形（`ESC 12` ＋ WTD・opcode は RESTORE_SCREEN）
    const rec = sent.find((d) => d[9] === OPCODE.RESTORE_SCREEN && d[11] === COMMAND.RESTORE_SCREEN);
    expect(rec, "画面を返す応答が含まれる").toBeDefined();
    await p;
  });
});

/**
 * **原典がパラメータ無しとして無視しているコマンド**（tn5250 `session.c`。
 * `20260730-tn5250-cross-check` research F5）。
 *
 * 当方も**捨てずに次へ進む**——レコードごと捨てると後続の READ を失い、
 * キーボードが開かないまま固まる（この不具合をこれまで 3 回踏んでいる）。
 */
describe("パラメータ無しのコマンドは捨てずに進む", () => {
  const CASES: [string, number][] = [
    ["READ SCREEN TO PRINT", 0x66],
    ["READ SCREEN TO PRINT EXTENDED", 0x68],
    ["READ SCREEN TO PRINT GRID", 0x6a],
    ["READ SCREEN TO PRINT EXT GRID", 0x6c],
    ["READ IMMEDIATE", 0x72],
    ["READ IMMEDIATE ALT", 0x83]
  ];

  for (const [name, cmd] of CASES) {
    it(`${name}(0x${cmd.toString(16)}) の後ろの READ が生き残る`, () => {
      const { result, warns } = apply([ESC, cmd, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08]);
      expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
      expect(result.readRequested, "後続の READ が処理される").toBe(true);
      expect(result.unlockKeyboard).toBe(true);
    });
  }

  it("READ IMMEDIATE は**応答していない**ことを警告で明示する", () => {
    const { warns } = apply([ESC, 0x72]);
    expect(warns.some((w) => w.includes("応答していない"))).toBe(true);
  });

  it("本当に未知のコマンドは従来どおりレコードの残りを捨てる（気づけるように）", () => {
    const { result, warns } = apply([ESC, 0xfe, ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x08]);
    expect(warns.some((w) => w.includes("unknown command"))).toBe(true);
    expect(result.readRequested).toBe(false);
  });
});
