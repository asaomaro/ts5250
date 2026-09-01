import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * **画面が変わったのにカーソルが動かず、そこが入力できない桁なら、最初の入力欄へ寄せる。**
 *
 * 「上で入力 → Enter → 上がプロテクトされ、下が展開する」画面で踏む。アプリはカーソルを
 * 動かしておらず、ホストが送るのは operator が居た桁のまま＝いまは保護欄。ACS は下の
 * 入力欄にカーソルを入れるが、こちらは保護欄に置いたままで、Tab を押すまで打てなかった
 * （利用者の報告。実機 ASAOLIB/CURSORCL3 で再現し、`scripts/diag-ic-on-protected.mjs` で計測）。
 *
 * **「動いていない」を条件にするのが肝。** ホストが**わざと**保護欄を指す画面があり
 * （SEU の走査検索は見つかった桁にカーソルを置く）、そちらを寄せると「どこが見つかったか
 * 分からない」に戻る。実機で並べると 展開画面 3/12→3/12（動かない）／SEU 2/9→11/53（動く）。
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
 * `ic` を渡すとその桁を指す（渡さなければカーソルは 1 画面目のまま＝動かない）。
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

describe("カーソルが保護欄に取り残されたら最初の入力欄へ寄せる", () => {
  it("カーソルが動かず保護欄なら、展開した下の入力欄へ寄せる", async () => {
    // IC 無し＝カーソルは 1 画面目のまま（3,12）。そこは保護になっている
    expect(await play(secondScreen())).toEqual({ row: 10, col: 12 });
  });

  it("ホストが同じ桁を**わざと**指しても寄せる（動いていないので同じ扱い）", async () => {
    expect(await play(secondScreen({ row: 3, col: 12 }))).toEqual({ row: 10, col: 12 });
  });

  /** **動かした指定は尊重する**（SEU の走査検索。寄せると見つかった桁が分からなくなる） */
  it("ホストがカーソルを動かして保護欄を指したら、そこに置いたまま", async () => {
    expect(await play(secondScreen({ row: 3, col: 15 }))).toEqual({ row: 3, col: 15 });
  });

  it("動いていなくても入力欄なら触らない", async () => {
    expect(await play(secondScreen({ row: 10, col: 12 }))).toEqual({ row: 10, col: 12 });
  });
});
