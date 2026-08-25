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
 * **実機で裏づけ済み**（2026-07-30。`scripts/research-sign.mjs`）:
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
 * **継続入力フィールドは先頭区間 1 つに畳む。**
 *
 * ホストは DDS の `EDTMSK` 等で 1 つの入力欄を編集文字（`/` など）で分割し、区間ごとに
 * SF を送ってくる（FCW `0x8601`/`0x8603`/`0x8602`）。**画面上は別々の欄でも、ホストから見れば
 * 1 つの欄**なので、返すのは**先頭区間の位置に載せた全区間の連結値 1 つだけ**。
 *
 * GNU tn5250 `session.c` `tn5250_session_send_field`:
 * > We also must only send back data for the first subfield of a continuous field.
 * > All subfields are treated as one and are sent as part of the first subfield.
 * （先頭でなければ `return` して 1 バイトも送らない。tn5250j も `ScreenField.getString` が
 * 先頭区間から後続を連結する形で同じ結果を出す。）
 *
 * MDT は `setFieldValue` が先頭区間へ畳んでいるので普通は先頭しか来ないが、ホストが
 * FFW の MDT ビットを中間・最終だけに立てて送ってきても**値を落とさない**よう、
 * ここでも並びの先頭へ寄せてから重複を除く。
 */
function foldContinued(buf: ScreenBuffer, fields: readonly InternalField[]): InternalField[] {
  const out: InternalField[] = [];
  for (const f of fields) {
    const target = f.continued === undefined ? f : (buf.continuedRun(f)[0] ?? f);
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * 送信する欄の値。継続入力フィールドの先頭区間なら**全区間を連結**した値を返す。
 *
 * 連結の前に区間ごとの末尾空白を落としてはいけない——落とすと `2026` + `1 ` + `31` が
 * `2026131` へ詰まり、**桁がずれてホストに届く**。tn5250 も区間ごとに欄長ぶんを
 * そのまま連結し、**連結し終えた最後にだけ**末尾を落とす（`session.c` の「Strip trailing NULs」）。
 */
function sendValue(buf: ScreenBuffer, f: InternalField, codec: Codec): string {
  if (f.continued === undefined) {
    return isSignedNumeric(f) ? signedNumericValue(buf.fieldValue(f, true), codec) : buf.fieldValue(f);
  }
  const joined = buf
    .continuedRun(f)
    .map((seg) => buf.fieldValue(seg, true))
    .join("");
  return isSignedNumeric(f) ? signedNumericValue(joined, codec) : joined.replace(/ +$/, "");
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
 * **READ INPUT FIELDS（0x42）／ READ IMMEDIATE（0x72）応答。**
 *
 * **この 2 つだけ形式が違う。** `0x52`/`0x82`/`0x83` は `SBA(行,桁) + 値` を MDT の立った欄に
 * ついてだけ並べるが、`0x42`/`0x72` は
 *
 *   - **SBA を付けない**
 *   - **画面順に全ての欄**（欄ごとの MDT は見ない。門番は画面単位の MDT だけ）
 *   - **欄長ぶんそのまま**（NUL は 0x40＝空白へ。**末尾も落とさない**）
 *
 * という**位置で区切る平坦な並び**になる。原典 GNU tn5250 `session.c`
 * `tn5250_session_send_field` が `CMD_READ_INPUT_FIELDS` と `CMD_READ_IMMEDIATE` を
 * **同じ枝**で扱っているところがそれ:
 *
 * ```c
 * case CMD_READ_INPUT_FIELDS:
 * case CMD_READ_IMMEDIATE:
 *     for (n = 0; n < size; n++)
 *         tn5250_buffer_append_byte(buf, data[n] == 0 ? 0x40 : data[n]);
 *     break;                                  // ← SBA なし・欄長そのまま・末尾を落とさない
 * ```
 *
 * tn5250j も同じ（`ScreenFields.readFormatTable` は `CMD_READ_INPUT_FIELDS` で
 * `sf.mdt` の絞り込みも `setSBA` も通らない）。
 *
 * 違いは AID と門番だけ:
 *
 * | | 0x42 | 0x72 |
 * |---|---|---|
 * | AID | 利用者が押した鍵（読み取りは入力待ちに入る） | **0**（待たずに即送信） |
 * | 門番 | 画面単位の MDT ＋ `send_data_for_aid_key` | 画面単位の MDT |
 *
 * ## 実機で確かめた（2026-08-25・実機 / IBM i 7.3）
 *
 * ~~0x72 は実機で裏を取ってある~~ ← **往復が成立することしか見ていなかった。**
 * DSM の `QsnReadImm` は**受け取ったバイト列を素通しで返すだけ**で、形式は検証していない。
 *
 * 位置と長さの分かっている試験画面（欄長 **10 / 6 / 8**、値は `"ABC"` / 未入力 /
 * `"12345678"`）を `QsnPutOutCmd(0x11, …)` で描かせ、`0x52`（対照）・`0x42`・`0x72` を
 * 順に発行させて、**ホストが受け取ったバイト列**を `QsnRtv*` で取り出した
 * （`scripts/host-src/dscmd.c` の `READINP` / `READINPIMM`）。
 *
 * ```
 * [0x52 対照] QsnRtvFldCnt=2  fld[1] (5,10) len=3 "ABC"  fld[2] (9,10) len=8 "12345678"
 *             → ホストが**欄へ分解できている**
 * [0x42 生]   QsnRtvFldCnt → CPFA32E（この読み取りでは欄へ分解しない）
 *             QsnRtvFldDta = 11050ac1c2c311090af1f2f3f4f5f6f7f8   ← 17 バイト
 * [0x72]      QsnRtvFldCnt → CPFA32E
 *             QsnRtvFldDta = 11050ac1c2c311070a11090af1f2f3f4f5f6f7f8  ← 20 バイト
 * ```
 *
 * **`0x42`/`0x72` ではホストは欄へ分解しない**（`QsnRtvFldCnt` が CPFA32E＝
 * 「この入力操作では作られない情報」）。つまり**応用プログラムが欄長で切る**しかない。
 * 欄長 10/6/8 で切るとこうなっていた（当方が SBA 付きで返していたとき）:
 *
 * ```
 * 切片1(10) 11050ac1c2c311090af1   ← 期待は "ABC" ＋ 空白 7
 * 切片2(6)  f2f3f4f5f6f7           ← 期待は 空白 6
 * 切片3(8)  f8 ＋ 足りない 7 バイト  ← 期待は "12345678"
 * ```
 *
 * **打った値と一致しない。** SBA のバイトが値として混ざり、全長も 24 に足りない。
 * 平坦形式へ直すと 3 + 24 バイトになり、10/6/8 で切ると打った値そのものになる。
 *
 * ⚠ **`QsnReadInp`（API 経由の 0x42）は `CPFA306`（この装置ではサポートされない）で
 * 出せない。** 上の `[0x42 生]` は `QsnPutInpCmd(0x42, …)` で生のコマンドとして出したもの。
 * 通常の運用で 0x42 が届く見込みは薄いが、**届いたときに値が壊れる**ことは実測できた。
 */
function buildFlatFieldResponse(
  buf: ScreenBuffer,
  codec: Codec,
  aid: number,
  cursor?: { row: number; col: number }
): { record: Uint8Array; substituted: number } {
  const w = new ByteWriter();
  const cur = cursor ?? buf.rowColOf(buf.cursorAddr);
  w.u8(cur.row).u8(cur.col).u8(aid);

  // **画面単位の MDT が門番**。立っていなければ欄は 1 つも送らない
  const fields = buf.mdtFields().length > 0 ? buf.orderedFields() : [];
  let substituted = 0;
  for (const f of foldContinued(buf, fields)) {
    const width = flatWidth(buf, f);
    // 一旦別の入れ物へ書いてから**欄長ぶんに詰める**——DBCS（1 文字 2 バイト）や
    // センチネル（1 文字 1 バイト）が混ざると文字数では桁が合わないため、
    // **バイト数で** 0x40（空白）詰め・切り詰めをする。位置で区切る形式なので長さが命。
    const tmp = new ByteWriter();
    substituted += writeValue(tmp, flatValue(buf, f, codec), codec);
    const bytes = tmp.toUint8Array();
    w.bytes(bytes.subarray(0, Math.min(bytes.length, width)));
    for (let i = bytes.length; i < width; i++) w.u8(0x40);
  }
  return { record: buildRecord(OPCODE.PUT_GET, w.toUint8Array()), substituted };
}

/** 平坦形式で 1 欄が占めるバイト数。符号付き数値だけは**符号桁を送らない**ぶん 1 短い */
function flatWidth(buf: ScreenBuffer, f: InternalField): number {
  const total =
    f.continued === undefined
      ? f.length
      : buf.continuedRun(f).reduce((n, seg) => n + seg.length, 0);
  return isSignedNumeric(f) ? total - 1 : total;
}

/**
 * 平坦形式で送る値。**末尾空白を落とさない**（落とすと後続の欄との境目がずれる）。
 *
 * 符号付き数値だけは `signedNumericValue` と同じ加工をする——符号桁は送らず、負なら
 * 最終桁のゾーンを 0xD にする。**実機で裏づけ済みの加工**（`signedNumericValue` の
 * JSDoc 参照。7 バイトそのままだと CPF5257）なので平坦形式でも同じにする。
 *
 * ⚠ 原典 tn5250 のこの枝は `for (n = 0; n < size - 1; n++)` のあとに `data[size-2]` を
 * もう一度足しており、**最終桁が二重に出る**（`CMD_READ_MDT_FIELDS` 側にある `size--` が
 * 抜けている）。桁数が合わなくなるので**写さない**。
 */
function flatValue(buf: ScreenBuffer, f: InternalField, codec: Codec): string {
  const full =
    f.continued === undefined
      ? buf.fieldValue(f, true)
      : buf
          .continuedRun(f)
          .map((seg) => buf.fieldValue(seg, true))
          .join("");
  if (!isSignedNumeric(f)) return full;
  const sign = full.slice(-1);
  let digits = full.slice(0, -1);
  if (sign === "-") {
    const last = digits.slice(-1);
    if (last >= "0" && last <= "9") {
      const b = codec.encode(last).bytes[0];
      if (b !== undefined) digits = digits.slice(0, -1) + rawSentinel(0xd0 | (b & 0x0f));
    }
  }
  return digits;
}

/**
 * **READ INPUT FIELDS（0x42）応答。** 形式は `buildFlatFieldResponse` の JSDoc を参照。
 * `0x72` と違い**利用者が押した鍵の AID を載せる**（原典も `aidcode != 0` を assert する）。
 */
export function buildReadInputFieldsResponse(
  buf: ScreenBuffer,
  codec: Codec,
  aid: number,
  cursor?: { row: number; col: number }
): { record: Uint8Array; substituted: number } {
  return buildFlatFieldResponse(buf, codec, aid, cursor);
}

/**
 * **READ IMMEDIATE（0x72）応答。** 形式は `buildFlatFieldResponse` の JSDoc を参照。
 * **AID は 0**（利用者が押した鍵ではなく、ホストが「いま送れ」と言っているだけ）。
 */
export function buildReadImmediateResponse(
  buf: ScreenBuffer,
  codec: Codec,
  cursor?: { row: number; col: number }
): { record: Uint8Array; substituted: number } {
  return buildFlatFieldResponse(buf, codec, 0, cursor);
}

/**
 * 欄の値を 1 つ書き出す。**センチネル位置には生の属性バイトを出す**
 * （編集で動いた桁にそのまま書き戻す＝色/バイトが追従）。センチネル以外の連続部分だけを
 * codec でエンコードし、センチネルは 1 バイトそのまま挟む。戻り値は置換された文字数。
 */
function writeValue(w: ByteWriter, value: string, codec: Codec): number {
  let substituted = 0;
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
  return substituted;
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
  // 継続入力フィールドは先頭区間 1 つに畳む（中間・最終は単独では送らない）
  for (const f of foldContinued(buf, fields)) {
    const { row, col } = buf.rowColOf(f.startAddr);
    w.u8(ORDER.SBA).u8(row).u8(col);
    // 末尾ブランクは落ちる。SBCS の埋め込み属性はセンチネル。
    // **符号付き数値欄だけは符号桁を見るため末尾ブランクを残した値**から作る（上の関数）。
    // 継続入力フィールドは全区間を連結した値になる。
    const value = sendValue(buf, f, codec);
    substituted += writeValue(w, value, codec);
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
