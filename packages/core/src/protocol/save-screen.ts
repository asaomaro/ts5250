import { ByteWriter } from "./bytes.js";
import { buildRecord } from "./gds.js";
import { COMMAND, ESC, OPCODE, ORDER } from "./constants.js";
import { SO, SI } from "../codec/codec.js";
import type { ScreenBuffer } from "../screen/buffer.js";
import type { Codec } from "../codec/codec.js";

/**
 * SAVE SCREEN（opcode 0x04 / ESC 0x02）への応答レコードを組み立てる。
 *
 * **これはホストが待っている返信である。** SAVE SCREEN は「画面を退避しろ」という
 * 一方向の指示ではなく、**端末に画面の内容を送り返させる要求**で、ホストは受け取った
 * バイト列を保管し、あとで RESTORE SCREEN としてそのまま返してくる。
 * 返信しないとホストは先へ進まない——SEU の F1 でヘルプが 30 秒返らなかったのがこれ。
 *
 * 返すのは `ESC RESTORE_SCREEN` に続けて、現在の画面を再現する WTD ストリーム。
 * opcode は RESTORE_SCREEN（0x05）。
 *
 * **DBCS の再現は不完全**（lead/tail に元のバイト対を保持していないため、
 * エンコードし直せない文字は空白になる）。表示上の実害は無い——こちらの
 * RESTORE SCREEN はホストの積荷を読まず、ローカルの退避スタックから復元するため。
 * ここで送るバイト列はホストにとって不透明な保管物にすぎない。
 */
export function buildSaveScreenResponse(buf: ScreenBuffer, codec: Codec): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.RESTORE_SCREEN);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x00); // CC1/CC2 とも副作用なし

  const fieldStarts = new Map<number, ReturnType<ScreenBuffer["orderedFields"]>[number]>();
  for (const f of buf.orderedFields()) fieldStarts.set(f.startAddr, f);

  let addr = 0;
  let pending = true; // 直後に SBA が必要か（先頭と飛び越しの後）
  while (addr < buf.size) {
    const field = fieldStarts.get(addr + 1);
    if (field !== undefined) {
      // フィールド定義は属性桁（startAddr - 1）から。applySf と同じ並び:
      // SF, FFW(2), FCW(2 任意), 属性(1), 長さ(2)
      writeSba(w, buf, addr);
      w.u8(ORDER.SF).u16(field.ffw);
      if (field.dbcsType !== undefined) w.u16(fcwFor(field.dbcsType));
      w.u8(field.attrByte).u16(field.length);
      for (let i = 0; i < field.length; i++) writeCell(w, buf, field.startAddr + i, codec);
      addr = field.startAddr + field.length;
      pending = true;
      continue;
    }
    const cell = buf.cellAt(addr);
    if (cell === null) {
      addr++;
      pending = true; // 既定の空白は書かずに飛ばす（RA を使わずとも復元後は空白）
      continue;
    }
    if (pending) {
      writeSba(w, buf, addr);
      pending = false;
    }
    writeCell(w, buf, addr, codec);
    addr += cell.type === "char" && cell.charKind === "dbcs-lead" ? 2 : 1;
  }

  return buildRecord(OPCODE.RESTORE_SCREEN, w.toUint8Array());
}

function fcwFor(kind: "pure" | "open" | "either"): number {
  if (kind === "pure") return 0x8200;
  if (kind === "either") return 0x8240;
  return 0x8280;
}

/** SBA（1 始まりの行・桁を 1 バイトずつ） */
function writeSba(w: ByteWriter, buf: ScreenBuffer, addr: number): void {
  const { row, col } = buf.rowColOf(addr);
  w.u8(ORDER.SBA).u8(row).u8(col);
}

function writeCell(w: ByteWriter, buf: ScreenBuffer, addr: number, codec: Codec): void {
  const cell = buf.cellAt(addr);
  if (cell === null) {
    w.u8(0x40); // 空白
    return;
  }
  if (cell.type === "attr") {
    w.u8(cell.byte);
    return;
  }
  if (cell.charKind === "so") {
    w.u8(SO);
    return;
  }
  if (cell.charKind === "si") {
    w.u8(SI);
    return;
  }
  if (cell.charKind === "dbcs-tail") return; // lead 側で 2 バイト書いている
  if (cell.charKind === "dbcs-lead") {
    const pair = codec.encodeDbcsChar?.(cell.char.codePointAt(0) ?? 0x20);
    if (pair === undefined) {
      w.u8(0x40).u8(0x40); // 戻せない文字は空白 2 桁（桁位置は保つ）
      return;
    }
    w.u8((pair >> 8) & 0xff).u8(pair & 0xff);
    return;
  }
  w.u8(cell.rawByte ?? 0x40);
}
