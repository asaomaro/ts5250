import type { Codec } from "@as400web/ebcdic";
import type { ScreenBuffer } from "../screen/buffer.js";
import { ByteWriter } from "./bytes.js";
import { ORDER, OPCODE } from "./constants.js";
import { buildRecord, type RecordHeaderFlags } from "./gds.js";
import { isRawSentinel, sentinelByte } from "../screen/attr-sentinel.js";

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
    const value = buf.fieldValue(f); // 末尾ブランクは落ちる。SBCS の埋め込み属性はセンチネル
    // **センチネル位置には生の属性バイトを出す**（編集で動いた桁にそのまま書き戻す＝色/バイトが追従）。
    // センチネル以外の連続部分だけを codec でエンコードし、センチネルは 1 バイトそのまま挟む。
    let run = "";
    const flushRun = (): void => {
      if (run.length > 0) {
        const enc = codec.encode(run);
        substituted += enc.substituted;
        w.bytes(enc.bytes);
        run = "";
      }
    };
    for (const ch of value) {
      if (isRawSentinel(ch)) {
        flushRun();
        w.u8(sentinelByte(ch));
      } else {
        run += ch;
      }
    }
    flushRun();
  }

  return { record: buildRecord(OPCODE.PUT_GET, w.toUint8Array()), substituted };
}

/**
 * ヘッダフラグのレコード（SysReq=SRQ / Attn=ATN）。opcode NO_OP。
 * （tn5250 handle_aidkey の SysReq/Attn 送信と一致）。
 *
 * `data` は **SysReq のシステム要求行に打たれた文字列**（EBCDIC）を載せるためにある。
 * Attn とデータ無し SysReq は従来どおり空で送る（tn5250j `tnvt#systemRequest(String)` は
 * `writeGDS(4, 0, ebcdic(str))`＝flag1 に SRQ・opcode NO-OP・データに文字列、という同じ形）。
 */
export function buildFlagRecord(flags: Partial<RecordHeaderFlags>, data?: Uint8Array): Uint8Array {
  return buildRecord(OPCODE.NOOP, data ?? new Uint8Array(0), flags);
}

/**
 * Cancel Invite（ホストが送ってくる opcode 0x0A）への返事。**同じ opcode を** フラグ 0・データ無しで返す。
 *
 * ホストは Attn / SysReq を受けると invite を取り消し、この返事が来るまで**次のデータを送らない**。
 * 返さないとホストが止まり、画面が変わらずキーボードもロックしたままになる
 * （実機で対照実験済み。返さない場合、次の AID を送った時点で 1 手遅れて出てくる）。
 * tn5250j `tnvt#cancelInvite` の `writeGDS(0, 10, null)` と同じバイト列。
 */
export function buildCancelInviteAck(): Uint8Array {
  return buildRecord(OPCODE.CANCEL_INVITE, new Uint8Array(0));
}
