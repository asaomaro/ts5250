import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * **ホストが IC/MC で指定したカーソル位置は、それが保護欄であってもそのまま尊重する。**
 *
 * かつて（コミット `c82e2b34`、PR #387）は「画面が変わったのにカーソルが動かず、
 * そこが入力できない桁」なら最初の入力欄へ寄せる、という上書きがあった
 * （「上で入力 → Enter → 上がプロテクトされ、下が展開する」画面で、カーソルが保護欄に
 * 残り Tab を押すまで打てなかった、という利用者報告への対応）。この上書きは
 * `.aidev/works/20260915-pr387-acs-premise-unverified` で撤去した——
 * 「ACS は下の入力欄にカーソルを入れる」という前提は、実際に ACS を動かして
 * 検証された記録が無く（PR #387 の検証資材は全てこのプロジェクト自身のクライアント
 * が対象）、PR 本文の確認チェックリストも未チェックのまま残っており、かつ ACS の
 * デコンパイル済みコア（`DS5250.preprocessWCC2()`）にもこの上書きに相当するロジックは
 * 存在しなかった（`research.md` F1〜F3）。
 *
 * **IC/MC が無い場合のみ、最初の入力欄へ寄せる**（5250 の既定動作、`!cursorSet` 分岐。
 * ACS コアの `WTD_IC_addr == -1` → `setDefaultInsertCursor()` と一致する、確認済みの
 * 挙動——この分岐は変更していない）。IC/MC がある場合は、動いていようが動いていまいが、
 * 指している桁が保護欄だろうが、その指定にそのまま従う。
 */
function rx(record: Uint8Array): TraceEntry {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
}

/** 入力欄 1 つ（3 行 12 桁）＋ IC でそこを指す画面 */
function firstScreen(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(3).u8(11);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6); // 入力欄 → (3,12) から 6 桁
  w.u8(ORDER.IC).u8(3).u8(12);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 2 画面目。上の欄は保護（BYPASS）になり、下に入力欄が出る。
 * `ic` を渡すとその桁を指す（渡さなければ IC 無し＝`cursorSet=false`）。
 */
function secondScreen(ic?: { row: number; col: number }): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(3).u8(11);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.BYPASS).u8(0x20).u16(6); // 保護になった上の欄
  w.u8(ORDER.SBA).u8(10).u8(11);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(10); // 展開した下の入力欄 → (10,12)
  if (ic) w.u8(ORDER.IC).u8(ic.row).u8(ic.col);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 1 画面目を出し、Enter を送って 2 画面目を受けたあとのカーソルを返す。
 * `tx` の印を挟むのは、`ReplayTransport` が**こちらが送るまで次の rx を流さない**ため。
 */
async function play(second: Uint8Array): Promise<{ row: number; col: number }> {
  const transport = new ReplayTransport([
    rx(firstScreen()),
    { ts: "t", dir: "tx", masked: true, len: 0 },
    rx(second)
  ]);
  const session = await Session5250.connect({ transport, id: "t" });
  // 1 画面目でカーソルが上の欄に付いていること（前提）
  expect(session.snapshot().cursor).toEqual({ row: 3, col: 12 });
  await session.sendAid("Enter", { timeoutMs: 2000 });
  return session.snapshot().cursor;
}

describe("IC/MC の指定には保護欄でもそのまま従う（旧 PR#387 分岐は撤去済み）", () => {
  it("IC/MC が無ければ最初の入力欄へ寄せる（`!cursorSet` 分岐、変更なし）", async () => {
    // IC 無し＝cursorSet=false。この分岐は撤去していないので従来通り寄せる
    expect(await play(secondScreen())).toEqual({ row: 10, col: 12 });
  });

  it("ホストが同じ桁を指しても、動いていなくてもその位置をそのまま尊重する（寄せない）", async () => {
    // 送信前と同じ (3,12) を IC で明示的に指す＝cursorSet=true・動いていない。
    // 旧 PR#387 分岐なら寄せていたが、撤去したためそのまま (3,12) に留まる
    expect(await play(secondScreen({ row: 3, col: 12 }))).toEqual({ row: 3, col: 12 });
  });

  it("ホストがカーソルを動かして保護欄を指したら、そこに置いたまま", async () => {
    expect(await play(secondScreen({ row: 3, col: 15 }))).toEqual({ row: 3, col: 15 });
  });

  it("動いていなくても入力欄なら触らない", async () => {
    expect(await play(secondScreen({ row: 10, col: 12 }))).toEqual({ row: 10, col: 12 });
  });
});
