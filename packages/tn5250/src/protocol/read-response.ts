import type { Codec } from "@as400web/ebcdic";
import type { ScreenBuffer } from "../screen/buffer.js";
import { ByteWriter } from "./bytes.js";
import { ORDER, OPCODE, FFW } from "./constants.js";
import { buildRecord, type RecordHeaderFlags } from "./gds.js";
import { isRawSentinel, rawSentinel, sentinelByte } from "../screen/attr-sentinel.js";
import type { InternalField } from "../screen/buffer.js";

/**
 * **符号付き数値欄（FFW shift 0x0700）の送信表現。**
 *
 * 欄はワイヤ上 `桁数 + 1` バイトで、**最終桁は符号桁**（空白 = 正 / `-` = 負）。
 * ホストへ送るときは:
 *
 * 1. **符号桁は送らない**（送ると桁あふれになる）
 * 2. 符号桁が `-` で手前が数字なら、**その数字のゾーンを 0xD にする**（ゾーン 10 進の負値表現）
 *
 * GNU tn5250 `session.c:551-566`（Read MDT Fields の組み立て）の移植。
 *
 * **実機で裏づけ済み**（実機・2026-07-30。`scripts/research-sign.mjs`）:
 * - `-12`（先頭に符号）を送ると**符号が黙って落ちて `12` になる**＝いまの実装では負値が送れない
 * - `    12-` を 7 バイトそのまま送ると **CPF5257（入出力エラー）**＝桁あふれ
 * - `    12`（6 バイト）は `12` として通る
 *
 * 加工後の最終桁は `rawSentinel` で運ぶ（呼び出し側が生バイト 1 つとして書き出す）。
 */
function signedNumericValue(full: string, codec: Codec): string {
  const sign = full.slice(-1);
  let digits = full.slice(0, -1); // ① 符号桁は送らない
  if (sign === "-") {
    const last = digits.slice(-1);
    if (last >= "0" && last <= "9") {
      const b = codec.encode(last).bytes[0];
      // ② ゾーンを 0xD へ（EBCDIC の数字は 0xF0–0xF9。下位 4 ビットが数字）
      if (b !== undefined) digits = digits.slice(0, -1) + rawSentinel(0xd0 | (b & 0x0f));
    }
  }
  return digits.replace(/ +$/, ""); // 末尾空白は従来どおり落とす
}

/** その欄が符号付き数値（FFW shift 0x0700）か */
function isSignedNumeric(f: InternalField): boolean {
  return (f.ffw & FFW.SHIFT_MASK) === FFW.SHIFT_SIGNED_NUMERIC;
}

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
    // 末尾ブランクは落ちる。SBCS の埋め込み属性はセンチネル。
    // **符号付き数値欄だけは符号桁を見るため末尾ブランクを残した値**から作る（上の関数）。
    const value = isSignedNumeric(f)
      ? signedNumericValue(buf.fieldValue(f, true), codec)
      : buf.fieldValue(f);
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
