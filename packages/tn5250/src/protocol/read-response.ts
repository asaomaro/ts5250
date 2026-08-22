import type { Codec } from "@ts5250/ebcdic";
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
  return buildFieldResponse(buf, codec, aid, buf.mdtFields(), cursor);
}

/**
 * **READ MDT IMMEDIATE ALT（0x83）応答。**
 *
 * `0x72` と同じく**利用者を待たずに即送信**し、**AID は 0**。違うのは**欄の選び方**——
 * 名前どおり **MDT の立った欄だけ**を送る（`0x72` は全ての欄）。
 *
 * ## なぜ実装したか（2026-08-22）
 *
 * ~~2 実装で扱いが割れているので入れない~~ ← **実機で測ったら固まった。**
 *
 * IBM の DSM API `QsnReadMDTImmAlt`（`QSYSINC/H(QSNAPI)`）で実機から発行させると:
 *
 * ```
 * 受信  12B  04 83        ← パラメータ無し
 * 送信  （無し）           ← 当方は返していなかった
 * 結果  こちらは応答待ちで時間切れ／ホスト側は QsnReadMDTImmAlt から戻ってこない
 * ```
 *
 * **返さないとホストが待つ**——backlog `datastream-commands.md` が存在する理由そのもの
 * （「捨てた後ろに READ があると入力待ちに入り、利用者には『待機中』としか見えない」）。
 *
 * ## 中身の根拠
 *
 * tn5250j `ScreenFields.readFormatTable` が `CMD_READ_MDT_IMMEDIATE_ALT` を
 * `masterMDT` の門番 ＋ `sf.mdt` の絞り込みで送る。**`buildReadMdtResponse` に AID 0 を
 * 渡したものと同値**（門番は「MDT の立った欄が 0 個なら何も送らない」に畳める）。
 *
 * tn5250(C) は `0x83` を無視するが、**無視すると固まる**ことが実機で分かった以上、
 * 「2 実装が一致した点だけ」の原則より**実測を採る**。
 */
export function buildReadMdtImmediateAltResponse(
  buf: ScreenBuffer,
  codec: Codec,
  cursor?: { row: number; col: number }
): { record: Uint8Array; substituted: number } {
  return buildReadMdtResponse(buf, codec, 0, cursor);
}

/**
 * **READ IMMEDIATE（0x72）応答。**
 *
 * 形は Read MDT Fields と同じ（行・桁・AID ＋ SBA ＋ 欄データ）だが、中身が 2 つ違う:
 *
 * 1. **AID は 0**。利用者が押した鍵ではなく、ホストが「いま送れ」と言っているだけ
 * 2. **欄ごとの MDT を見ない**——`master MDT`（画面のどこかが変更されたか）が立っていれば
 *    **全ての欄**を送る。立っていなければ**欄を 1 つも送らない**（行・桁・AID だけ）
 *
 * 原典 GNU tn5250 `session.c` の `tn5250_session_read_immediate` →
 * `tn5250_session_send_fields(This, 0)` の `case CMD_READ_IMMEDIATE`:
 *
 * ```c
 * case CMD_READ_IMMEDIATE:
 *     if (tn5250_dbuffer_mdt(dbuffer)) {          // ← 画面単位の門番
 *         field = dbuffer->field_list;
 *         do { tn5250_session_send_field(...); field = field->next; }  // 欄ごとの MDT は見ない
 *         while (field != dbuffer->field_list);
 *     }
 *     break;
 * ```
 *
 * **`master MDT` は「MDT の立った欄が 1 つでもあるか」と同値**（`field.c` の
 * `tn5250_field_set_mdt` と同時に `tn5250_dbuffer_set_mdt` が呼ばれる）。
 *
 * ## 2 実装の突き合わせ（`20260822-read-immediate`）
 *
 * tn5250j は **`0x72` を扱わず**、`0x83`（READ MDT IMMEDIATE ALT）だけを実装している
 * （`tnvt.readImmediate` → `ScreenFields.readFormatTable`）。**矛盾ではなく別のコマンド**——
 * 名前どおり `0x83` は MDT の欄だけを送る（`sf.mdt` で絞る）。**両者が一致するのは**
 * 「`masterMDT` が門番」「待たずに即送信」「レコードの opcode は PUT_GET」の 3 点。
 *
 * ⚠ tn5250j の `readImmediate` は**行・桁・AID の前置きを書いていない**
 * （同じクラスの `sendAidKey` は書いている）。手落ちと見て tn5250 側に合わせた。
 *
 * ## 実機で裏を取った（2026-08-22・実機 / IBM i 7.3）
 *
 * 通常の画面では届かないが、**IBM 自身が 0x72 を発行する API を出荷している**——
 * 動的画面管理（DSM）の `QsnReadImm`（`QSYSINC/H(QSNAPI)` に `#define QSN_READ_IMM 0x72`）。
 * これを呼ぶ C プログラムを実機に置いて発行させた（`scripts/build-rdimm.mjs` /
 * `scripts/diag-read-immediate.mjs`）。
 *
 * ```
 * 受信  12B  04 72                       ← パラメータ無し
 * 送信  34B  14 07 00 11 14 07 c3c1d3d3  ← 行20 桁7 **AID=0x00** ＋ SBA(20,7) ＋ "CALL…"
 * ホスト側  QsnReadImm rc=21 bytesRead=21 fdbk_bytes=0   ← エラー無しで受理
 * ```
 *
 * 送った 24 バイトのうち**欄データ 21 バイトをホストが受け取っている**（残り 3 は行・桁・AID）。
 * 直前の Enter が `AID=0xf1` なのに対しこちらは `0x00`——**原典どおり**。
 */
export function buildReadImmediateResponse(
  buf: ScreenBuffer,
  codec: Codec,
  cursor?: { row: number; col: number }
): { record: Uint8Array; substituted: number } {
  // **画面単位の MDT が門番**。立っていなければ欄は 1 つも送らない
  const fields = buf.mdtFields().length > 0 ? buf.orderedFields() : [];
  return buildFieldResponse(buf, codec, 0, fields, cursor);
}

/** 行・桁・AID ＋ 指定された欄の並び。`buildReadMdtResponse` と READ IMMEDIATE で共有する */
function buildFieldResponse(
  buf: ScreenBuffer,
  codec: Codec,
  aid: number,
  fields: readonly InternalField[],
  cursor?: { row: number; col: number }
): { record: Uint8Array; substituted: number } {
  const w = new ByteWriter();
  const cur = cursor ?? buf.rowColOf(buf.cursorAddr);
  w.u8(cur.row).u8(cur.col).u8(aid);

  let substituted = 0;
  for (const f of fields) {
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
