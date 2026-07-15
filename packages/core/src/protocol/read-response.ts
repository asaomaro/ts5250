import type { Codec } from "../codec/codec.js";
import type { ScreenBuffer } from "../screen/buffer.js";
import { ByteWriter } from "./bytes.js";
import { ORDER, OPCODE } from "./constants.js";
import { buildRecord, type RecordHeaderFlags } from "./gds.js";

/**
 * Read MDT Fields 応答（クライアント → ホスト）を構築する。
 * 形式: カーソル行(1) 桁(1) + AID(1) + [SBA(行,桁) + フィールドデータ(EBCDIC)]*（MDT の立つフィールドのみ・画面順）
 * 送信時の再エンコードはここで行う（design: 画面は Unicode 保持・送信時変換）。
 */
export function buildReadMdtResponse(
  buf: ScreenBuffer,
  codec: Codec,
  aid: number,
  cursor?: { row: number; col: number }
): { record: Uint8Array; substituted: number } {
  const w = new ByteWriter();
  const cur = cursor ?? buf.rowColOf(buf.cursorAddr);
  w.u8(cur.row).u8(cur.col).u8(aid);

  let substituted = 0;
  for (const f of buf.mdtFields()) {
    const { row, col } = buf.rowColOf(f.startAddr);
    w.u8(ORDER.SBA).u8(row).u8(col);
    const value = buf.fieldValue(f); // 末尾ブランクは落ちる
    const encoded = codec.encode(value);
    substituted += encoded.substituted;
    w.bytes(encoded.bytes);
  }

  return { record: buildRecord(OPCODE.PUT_GET, w.toUint8Array()), substituted };
}

/**
 * ヘッダフラグのみの空レコード（SysReq=SRQ / Attn=ATN）。opcode NO_OP・データ無し
 * （tn5250 handle_aidkey の SysReq/Attn 送信と一致）。
 */
export function buildFlagRecord(flags: Partial<RecordHeaderFlags>): Uint8Array {
  return buildRecord(OPCODE.NOOP, new Uint8Array(0), flags);
}
