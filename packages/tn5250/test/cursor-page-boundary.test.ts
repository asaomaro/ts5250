import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import type { AidKey } from "../src/session/aid-keys.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * SEU の PageUp/PageDown で境界ページに到達したときのカーソル位置保持
 * （`.aidev/works/20260914-seu-page-cursor-hold`）。
 *
 * 実機トレース（`research.md` F1〜F6）で、境界ページでもホストは IC/MC で
 * **明示的に**カーソル位置を指定してくることを確認済み（IC/MC の欠落は無い）。
 * したがって、ここで検証するのは「ホストが明示的に指定した位置より、PageUp/PageDown
 * 送信直前の位置を優先する」という新しい分岐（`session.ts` の Rule1・Rule2）であり、
 * 既存の `cursor-default.test.ts`（IC 欠落時のフォールバック）とは別の観点になる。
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

const FIELD_A = { row: 5, col: 10, len: 6 }; // 入力欄 → (5,11)〜(5,16)
const FIELD_B = { row: 8, col: 10, len: 6 }; // 入力欄 → (8,11)〜(8,16)
const FIELD_D = { row: 9, col: 10, len: 6 }; // 入力欄 → (9,11)〜(9,16)

/** 画面1枚目: FIELD_A のみ。IC で (5,11) を指す */
function screen1(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.IC).u8(FIELD_A.row).u8(FIELD_A.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面2枚目・Rule2 用（境界=画面内容が完全一致）: 1枚目と**同一のレイアウト**
 * （FIELD_A・FIELD_B とも同じ位置に同じ属性で SF）を送り直すが、IC は FIELD_B を指す。
 * セル内容（文字・属性）は1枚目と変わらないので `cellsSignature()` は一致するはず。
 */
function screenRule2(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(FIELD_B.row).u8(FIELD_B.col + 1); // FIELD_A ではなく FIELD_B を指す
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/** 画面1枚目と同じレイアウト＋FIELD_B（Rule2 の比較対象と同じ画面にするための下敷き） */
function screen1WithFieldB(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(FIELD_A.row).u8(FIELD_A.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面2枚目・Rule1 用（境界の1つ手前=着地先が入力不可）: レイアウトを変え、FIELD_A は消えて
 * FIELD_B だけが残る（≒本文行の入力欄が画面から消えた）。IC はどの欄にも属さない (6,20) を指す。
 * FIELD_B が入力可能なので「画面に入力可能な欄が無い」という縮退（`cursorIsUnenterable`
 * が常に false を返すケース）にはならない。
 */
function screenRule1(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(6).u8(20); // どの欄にも属さない桁
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面（AC6 回帰用）: FIELD_A を**保護**にし、IC はその中を指す（＝送信前から
 * 既にカーソルが保護欄にいる状態）。FIELD_B は入力可能なまま残す。
 * PageDown の応答としてこれと**同一のバイト列**を送り返すことで、
 * 「画面完全一致（Rule2 相当）かつカーソルも動かない」という、新分岐と
 * 既存の保護欄退避分岐（`PR#387`）の両方の発火条件を同時に満たす状態を作る。
 */
function screenProtectedCursor(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.BYPASS).u8(0x20).u16(FIELD_A.len); // 保護欄
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len); // 入力可能な欄が他にある
  w.u8(ORDER.IC).u8(FIELD_A.row).u8(FIELD_A.col + 1); // 保護欄の中を指す
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面2枚目・非境界用（AC3、回帰確認）: レイアウトを変え、FIELD_A は消えて
 * FIELD_D が現れる（≒普通にページが進んだ）。IC は FIELD_D（入力可能）を指す。
 */
function screenNonBoundary(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_D.row).u8(FIELD_D.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_D.len);
  w.u8(ORDER.IC).u8(FIELD_D.row).u8(FIELD_D.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 1 画面目を出し、PageUp/PageDown を送って 2 画面目を受けたあとのカーソルを返す。
 * `tx` の印を挟むのは、`ReplayTransport` が**こちらが送るまで次の rx を流さない**ため。
 */
async function play(
  first: Uint8Array,
  second: Uint8Array,
  key: AidKey = "PageDown"
): Promise<{ row: number; col: number }> {
  const transport = new ReplayTransport([
    rx(first),
    { ts: "t", dir: "tx", masked: true, len: 0 },
    rx(second)
  ]);
  const session = await Session5250.connect({ transport, id: "t" });
  await session.sendAid(key, { timeoutMs: 2000 });
  return session.snapshot().cursor;
}

describe("PageUp/PageDown で境界ページに到達したときカーソル位置を保持する", () => {
  it("AC1/AC8 Rule2 (PageDown): 画面内容が送信前後で完全一致すれば、ホストの新しい IC より送信前の位置を保つ", async () => {
    // screen1WithFieldB → screenRule2 はどちらも FIELD_A・FIELD_B の内容が同一
    // （cellsSignature 一致）。ホストは IC で FIELD_B(8,11) を指すが、
    // 送信前のカーソル位置 FIELD_A(5,11) が維持されるはず。
    expect(await play(screen1WithFieldB(), screenRule2())).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC1 Rule1 (PageDown): カーソルが動いて着地先が入力不可なら、送信前の位置を保つ", async () => {
    // screenRule1 は画面内容が変わり（FIELD_A が消える）、IC はどの欄にも属さない
    // 桁を指す。FIELD_A(5,11) が維持されるはず。
    expect(await play(screen1(), screenRule1())).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC2 Rule1: PageUp でも Rule1（着地先が入力不可）が対称に効く", async () => {
    expect(await play(screen1(), screenRule1(), "PageUp")).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC2 Rule2: PageUp でも Rule2（画面無変化）が対称に効く", async () => {
    expect(await play(screen1WithFieldB(), screenRule2(), "PageUp")).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC3: 途中ページ（非境界）遷移では、ホストの IC をそのまま適用する（回帰なし）", async () => {
    // 画面は変わり、IC は入力可能な新しい欄 FIELD_D を指す。
    // Rule1（着地先が入力不可）・Rule2（画面無変化）のいずれにも当たらないので、
    // 新しい分岐は発火せず、ホストの指定どおり FIELD_D へ移る。
    expect(await play(screen1(), screenNonBoundary())).toEqual({
      row: FIELD_D.row,
      col: FIELD_D.col + 1
    });
  });

  it("PageUp/PageDown 以外の AID キーでは新しい分岐は働かない（従来通り IC に従う）", async () => {
    // screenRule1 と同じ画面変化・IC だが、Enter で送るので isPageKey が false になり、
    // 新しい分岐は発火しない。既存の2分岐も対象外: 1つ目は `!cursorSet` のときだけ
    // （ここは cursorSet=true）、2つ目（PR#387）は「動いていない」ときだけ
    // （ここはカーソルが (5,11)→(6,20) へ動いている）。結果としてカーソルは
    // ホストの IC が指す (6,20) のまま（既存の正しい既定動作）。
    expect(await play(screen1(), screenRule1(), "Enter")).toEqual({ row: 6, col: 20 });
  });

  it("AC6 回帰: 送信前から既に保護欄にいたら、新分岐ではなく既存の保護欄退避に譲る", async () => {
    // 送信前カーソルは保護欄の中（cursorBeforeWasEnterable = false）。
    // PageDown の応答は送信前と完全に同一の画面（Rule2 の「画面無変化」も、
    // 「動いていない」という PR#387 の条件も同時に満たす）。
    // cursorBeforeWasEnterable が無ければ新分岐が先に評価され、保護欄のまま
    // （FIELD_A(5,11)）残ってしまう——PR#387 の退避（FIELD_B(8,11) へ寄せる）が
    // 正しく働くことを確認する。
    expect(await play(screenProtectedCursor(), screenProtectedCursor())).toEqual({
      row: FIELD_B.row,
      col: FIELD_B.col + 1
    });
  });
});
