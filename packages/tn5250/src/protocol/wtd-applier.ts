import { As400Error } from "@ts5250/base";
import { type Codec, SO, SI } from "@ts5250/ebcdic";
import type { ScreenBuffer } from "../screen/buffer.js";
import type { WriteExtent } from "../screen/types.js";
import { ByteReader } from "./bytes.js";
import { ESC, COMMAND, ORDER, UNMAPPABLE, isAttribute, isKnownCommand } from "./constants.js";
import { detectPcoMarker, readPcCommand, type PcCommandRequest } from "./pc-command.js";
import { parseWdsf } from "./wdsf-parser.js";

/** データストリーム適用の結果（キーボード状態の遷移は Session が判断する） */
export interface ApplyResult {
  lockKeyboard: boolean;
  unlockKeyboard: boolean;
  /** Read 系コマンドを受けた（＝ホストが入力を待っている） */
  readRequested: boolean;
  alarm: boolean;
  /** ホストが 5250 QUERY を送ってきた（Query Reply を返す必要がある） */
  queryRequested: boolean;
  /** ホストが SAVE SCREEN を送ってきた（画面を送り返す必要がある） */
  saveScreenRequested: boolean;
  /** ホストが READ SCREEN を送ってきた（現在の画面イメージを送り返す必要がある） */
  readScreenRequested: boolean;
  /**
   * READ IMMEDIATE（0x72）が来た。**利用者を待たずにその場で欄を送り返す**
   * （`buildReadImmediateResponse`）。`readRequested` と違い**入力待ちに入らない**。
   */
  readImmediateRequested: boolean;
  /**
   * READ MDT IMMEDIATE ALT（0x83）が来た。`0x72` と同じく即送信だが、
   * **MDT の立った欄だけ**を送る（`buildReadMdtImmediateAltResponse`）。
   */
  readMdtImmediateAltRequested: boolean;
  /** ホストが READ SCREEN EXTENDED を送ってきた（0x62 とは応答形式が異なる） */
  readScreenExtendedRequested: boolean;
  /** このレコード中で IC/MC によりカーソル位置が明示された */
  cursorSet: boolean;
  /**
   * PC Organizer（`STRPCCMD`）のコマンドを受けた。呼び出し側が実行し、実行キーを返す
   * （`pc-command.ts`。**実行の可否に関わらず実行キーは返す**——返さないとホストが待ち続ける）
   */
  pcCommand?: PcCommandRequest;
  /** PC Organizer 終了の標識を受けた（コマンドは伴わない。実行キーだけ返す） */
  pcCommandEnd?: boolean;
  /**
   * このレコードの書き込み範囲（`ScreenSnapshot.lastWrite` と同じ値）。
   * 窓かどうかの判定材料。詳細は `WriteExtent` を参照。
   */
  lastWrite: WriteExtent;
  /**
   * SAVE PARTIAL SCREEN（ESC 0x03）を受けた。**ホストは応答を待っている**
   * （opcode は PUT/GET）。付いてきたパラメータ 5 バイトをそのまま渡す
   * ——応答に写して返すため（`buildSavePartialScreenResponse`）。
   */
  savePartialScreen?: Uint8Array;
}

/** CC2 ビット（SC30-3533。GNU tn5250 session.h と一致確認済み） */
const CC2_UNLOCK = 0x08;
const CC2_ALARM = 0x04;

/** PC Organizer 標識の先頭バイト（非表示属性）。ここを見てから 11 バイトを照合する */
const PCO_ATTR = 0x27;
/** 標識照合＋コマンド本文の読み取りに覗く最大バイト数 */
const PCO_MARKER_SCAN = 512;

export type WarnFn = (message: string) => void;

/**
 * 1 レコード分のデータストリーム（ESC+コマンド列）を ScreenBuffer に適用する。
 *
 * 未知のコマンド（ESC 直後の 1 バイト）は警告してレコードの残りを打ち切る
 * （レコード境界で再同期。spec「エラー処理」）。**未知のオーダー（WTD の中の 1 バイト）は
 * 次の ESC まで読み飛ばして次のコマンドから復帰する**——ここでレコード全部を捨てると、
 * 未知のオーダーより後ろにある WRITE（キーボード解放）や READ ごと失われ、
 * ホストは応答したつもりでもクライアントの鍵盤が開かないまま固まる
 * （実機で正体不明のオーダーに当たったときに観測）。
 */
export function applyDataStream(
  data: Uint8Array,
  buf: ScreenBuffer,
  codec: Codec,
  warn: WarnFn = () => {}
): ApplyResult {
  const r = new ByteReader(data);
  const result: ApplyResult = {
    lockKeyboard: false,
    unlockKeyboard: false,
    readRequested: false,
    alarm: false,
    queryRequested: false,
    saveScreenRequested: false,
    readScreenRequested: false,
    readImmediateRequested: false,
    readMdtImmediateAltRequested: false,
    readScreenExtendedRequested: false,
    cursorSet: false,
    lastWrite: { cleared: false, restored: false, cells: 0 }
  };

  // **レコード境界はここ**（1 レコード＝1 回の呼び出し）。書き込み範囲の記録をここで開始する。
  // 何も書かずに終わったレコードでは、buffer 側が前回の確定値を残す（窓を描くレコードと
  // 入力を待つだけのレコードが分かれて届いても窓が消えないようにするため）。
  buf.beginRecord();
  const finish = (): ApplyResult => {
    result.lastWrite = buf.lastWrite;
    return result;
  };

  while (r.remaining > 0) {
    const esc = r.u8();
    if (esc !== ESC) {
      warn(`expected ESC, got 0x${esc.toString(16)} — discarding rest of record`);
      break;
    }
    const cmd = r.u8();
    switch (cmd) {
      case COMMAND.CLEAR_UNIT:
        buf.clearUnit();
        break;
      case COMMAND.CLEAR_UNIT_ALTERNATE: {
        // Clear Unit Alternate は 1 バイトのパラメータ（アルタネート形式・通常 0x00）を伴う。
        // これを消費しないと後続コマンドの ESC 同期がずれ、画面本体を取りこぼす
        // （DBCS 端末 IBM-5555-C01 の SEU 等がこの命令を使う）。
        r.u8();
        // 27x132 へ切替えクリア。24x80 端末（alternate 未許可）では通常クリアにフォールバック
        if (!buf.clearUnitAlternate()) {
          warn("CLEAR UNIT ALTERNATE on 24x80 terminal — falling back to CLEAR UNIT");
          buf.clearUnit();
        }
        break;
      }
      case COMMAND.CLEAR_FORMAT_TABLE:
        buf.clearFormatTable();
        break;
      case COMMAND.SAVE_SCREEN:
        // SAVE SCREEN（ESC 0x02）: 現バッファを退避。後続の WTD がオーバーレイを描く。
        // **加えてホストへ画面を送り返す必要がある**（呼び出し側が応答レコードを送る）。
        // 返信しないとホストは待ち続ける——SEU の F1 でヘルプが返らなかった原因。
        buf.saveScreen();
        result.saveScreenRequested = true;
        break;
      case COMMAND.RESTORE_SCREEN:
        if (!buf.restoreScreen()) warn("RESTORE SCREEN with empty save stack");
        break;
      case COMMAND.SAVE_PARTIAL_SCREEN: {
        // SAVE PARTIAL SCREEN（ESC 0x03）: **パラメータ 5 バイト**（実機の QSH で
        // `00 00 00 00 00`）。SAVE SCREEN と同じく**ホストは応答を待っている**（opcode PUT/GET）
        // ——返さないと次を送ってこない（QSH が「待機中」で固まっていた原因）。
        // パラメータは応答へそのまま写す（意味を解釈しない。ホストにとっては保管物）。
        const params = r.bytes(5);
        buf.saveScreen();
        result.savePartialScreen = params;
        break;
      }
      case COMMAND.RESTORE_PARTIAL_SCREEN:
        // RESTORE PARTIAL SCREEN（ESC 0x13）: **パラメータは持たない**。
        // 原典（tn5250 `session.c`）も 1 バイトも読まずに無視し、
        // 「後続は妥当な WRITE TO DISPLAY のはず」とコメントしている
        // （`20260730-tn5250-cross-check` research F3）。
        //
        // ⚠ 以前ここで 5 バイト読み飛ばしていたのは、**こちらの応答が先頭に
        // `ESC 13 ＋ 写し` を埋め込んでいた**ため——ホストは積荷をそのまま返すので、
        // 自分が付けたものを「ホストのパラメータ」と誤解していた（自作自演。research F4）。
        // 応答からその前置きを外したので、ここも原典どおり読まない。
        if (!buf.restoreScreen()) warn("RESTORE PARTIAL SCREEN with empty save stack");
        break;
      case COMMAND.ROLL: {
        // ROLL（ESC 0x23）: `方向＋行数(1) 上端行(1) 下端行(1)`。
        //
        // **方向は上位ビット（0x80）が落ちていれば上へ・立っていれば下へ**。
        // 原典 2 実装が一致している（tn5250 `session.c`: ビットが落ちていれば行数を負にし、
        // `dbuffer.c` は負を "Move text up" として扱う／tn5250j `Screen5250.rollScreen` の
        // コメント「0 - up / 1 - down」）。**当方は逆に実装していた**
        // （`20260730-tn5250-cross-check` research F1）。
        //
        // 行数は下位 5 ビット（tn5250 と同じ。tn5250j は `& 0x7f` だが、
        // 32 以上は 24〜27 行の画面を超えるので**実際には差が出ない**）。
        //
        // ⚠ **実機で ROLL を送ってくる画面は見つかっていない**（11 画面の国勢調査で 0 件。
        // `20260730-datastream-command-census`）。根拠は原典 2 実装の一致だけである。
        const dir = r.u8();
        const top = r.u8();
        const bottom = r.u8();
        const lines = dir & 0x1f;
        buf.roll(top, bottom, (dir & 0x80) !== 0 ? -lines : lines);
        break;
      }
      // **原典がパラメータ無しとして無視しているコマンド**（tn5250 `session.c`。research F5）。
      // 当方も**捨てずに次のコマンドへ進む**——レコードごと捨てると後続の READ を失い、
      // キーボードが開かないまま固まる（この不具合をこれまで 3 回踏んでいる）。
      case COMMAND.READ_SCREEN_TO_PRINT:
      case COMMAND.READ_SCREEN_TO_PRINT_GRID:
        // **画面イメージを返す**（`READ SCREEN`(0x62) と同じ形）。印刷要求なので
        // ホストは受け取った画像を印刷経路へ回す。**返さないとホストが固まる**
        // ——実機で `QsnPutInpCmd(0x66)` を出させて確かめた
        // （`scripts/diag-5250-commands.mjs`）。
        result.readScreenRequested = true;
        break;
      case COMMAND.READ_SCREEN_TO_PRINT_EXTENDED:
      case COMMAND.READ_SCREEN_TO_PRINT_EXT_GRID:
        // 拡張版。`READ SCREEN EXTENDED`(0x64) と同じ行区切り形式で返す
        result.readScreenExtendedRequested = true;
        break;
      case COMMAND.READ_IMMEDIATE:
        // **利用者を待たずに欄を送り返す**（原典 GNU tn5250 `tn5250_session_read_immediate`）。
        // パラメータは無い（原典も 1 バイトも読まない）。中身の決まりは
        // `buildReadImmediateResponse` の JSDoc に原典の該当箇所ごと控えてある。
        //
        // **実機で裏を取ってある**（実機 / IBM i 7.3）。通常の画面では届かないが、
        // IBM 自身が発行する API（DSM の `QsnReadImm`）で出させて往復を確かめた
        // （`scripts/diag-read-immediate.mjs`）。
        result.readImmediateRequested = true;
        break;
      case COMMAND.READ_IMMEDIATE_ALT:
        // **MDT の立った欄だけを即送信する**（名前どおり。`buildReadMdtImmediateAltResponse`）。
        // パラメータは無い（実機で 12B ＝ ヘッダ 10 ＋ `04 83` を確認）。
        //
        // ⚠ **返さないとホストが固まる。** tn5250(C) は無視しているが、実機で
        // `QsnReadMDTImmAlt` を発行させたら**こちらは応答待ちで時間切れ、ホストは API から
        // 戻ってこなかった**（`scripts/diag-5250-commands.mjs`）。
        result.readMdtImmediateAltRequested = true;
        break;
      case COMMAND.WRITE_TO_DISPLAY:
        applyWtd(r, buf, codec, result, warn);
        break;
      case COMMAND.WRITE_ERROR_CODE:
        applyWriteErrorCode(r, buf, codec);
        break;
      case COMMAND.WRITE_ERROR_CODE_WINDOW:
        // 窓が開いている間のエラーはこちら。メッセージ行の開始桁・終了桁（2 バイト）を
        // 読み捨ててから本文へ——**捨てないと桁が 1 つずれて先頭が化ける**。
        // 描画は 0x21 と同じ扱い（systemMessage）で、窓の中への描き込みまではしない。
        r.skip(2);
        applyWriteErrorCode(r, buf, codec);
        break;
      case COMMAND.WRITE_STRUCTURED_FIELD:
        if (applyStructuredField(r, warn)) result.queryRequested = true;
        break;
      case COMMAND.READ_MDT_FIELDS:
      case COMMAND.READ_MDT_FIELDS_ALT:
      case COMMAND.READ_INPUT_FIELDS: {
        applyCc(r.u8(), buf, result);
        applyCc2(r.u8(), result);
        result.readRequested = true;
        result.unlockKeyboard = true; // Read はキーボードを解放して入力を待つ
        break;
      }
      case COMMAND.READ_SCREEN:
        // READ SCREEN（opcode 0x08 / ESC 0x62）: パラメータ無し。現在の画面イメージを
        // ホストへ送り返す要求。ASSUME 付き WINDOW（別表示ファイルの画面に重ねる）で、
        // ホストが「既にあると仮定した画面」を取得するために送ってくる。返信しないと
        // ホストは停止し、後続のウィンドウ描画を送ってこない（キーボードがロックのまま）。
        result.readScreenRequested = true;
        break;
      case COMMAND.READ_SCREEN_EXTENDED:
        // 拡張 5250 を申告した端末にはホストがこちらを送ってくる。応答形式は 0x62 と別
        // （buildReadScreenExtendedResponse 参照）。
        result.readScreenExtendedRequested = true;
        break;
      default:
        warn(`unknown command 0x${cmd.toString(16)} — discarding rest of record`);
        return finish();
    }
  }
  return finish();
}

/** CC1（上位 3 ビット）: ロックと MDT リセット/フィールド null 化（GNU tn5250 の解釈と一致） */
function applyCc(cc1: number, buf: ScreenBuffer, result: ApplyResult): void {
  const mode = cc1 & 0xe0;
  if (mode !== 0x00) result.lockKeyboard = true;
  switch (mode) {
    case 0x40:
      buf.resetMdtNonBypass();
      break;
    case 0x60:
      buf.resetMdt();
      break;
    case 0x80:
      buf.nullNonBypass(true);
      break;
    case 0xa0:
      buf.resetMdtNonBypass();
      buf.nullNonBypass(false);
      break;
    case 0xc0:
      buf.resetMdtNonBypass();
      buf.nullNonBypass(true);
      break;
    case 0xe0:
      buf.resetMdt();
      buf.nullNonBypass(false);
      break;
  }
}

function applyCc2(cc2: number, result: ApplyResult): void {
  if ((cc2 & CC2_UNLOCK) !== 0) result.unlockKeyboard = true;
  if ((cc2 & CC2_ALARM) !== 0) result.alarm = true;
}

function applyWtd(
  r: ByteReader,
  buf: ScreenBuffer,
  codec: Codec,
  result: ApplyResult,
  warn: WarnFn
): void {
  applyCc(r.u8(), buf, result);
  applyCc2(r.u8(), result);

  let addr = 0; // WTD 開始時のバッファアドレスは SBA で設定される（未設定時は先頭）
  let dbcsMode = false; // SO..SI 間は DBCS（2 バイト）モード
  /**
   * 「表せない文字」の数。**1 度だけまとめて知らせる**——1 画面に 500 個以上出る
   * （実測）ので 1 バイトずつ警告するとログが埋まる。
   */
  let unmappable = 0;

  while (r.remaining > 0) {
    const b = r.peek();
    if (b === ESC) {
      // 次のコマンドへ。**抜ける前に知らせる**——ここが WTD の正常な終わりなので、
      // 関数末尾だけに置くと（ほぼ毎回ここで返るため）警告が出ない
      warnUnmappable(unmappable, warn);
      return;
    }

    // PC Organizer の標識（非表示属性＋固定 11 バイト）。**消費しない**——
    // 標識・コマンド本文は今までどおり画面へ書く（非表示なので見えない）。
    // 検出だけ結果に載せ、実行と応答は Session が行う（`pc-command.ts`）
    if (b === PCO_ATTR) {
      // 標識(11) + PAUSE(1) + 本文（実機の上限は 123。余裕を見て 512）
      const ahead = r.peekUpTo(PCO_MARKER_SCAN);
      const kind = detectPcoMarker(ahead);
      if (kind === "start") result.pcCommand = readPcCommand(ahead, (x) => codec.decodeByte(x));
      else if (kind === "end") result.pcCommandEnd = true;
    }

    r.u8();
    // SO/SI: 空白 1 桁の制御セルを置き、DBCS モードを切り替える（桁位置維持）
    if (b === SO) {
      buf.setShift(addr++, "so");
      dbcsMode = true;
      continue;
    }
    if (b === SI) {
      buf.setShift(addr++, "si");
      dbcsMode = false;
      continue;
    }
    if (isAttribute(b)) {
      buf.setAttr(addr++, b);
      dbcsMode = false; // 属性桁で DBCS 連続は切れる
      continue;
    }
    if (dbcsMode && codec.decodeDbcsPair && b >= 0x40) {
      // DBCS 2 バイトを lead/tail の 2 桁に配置
      const b2 = r.u8();
      buf.setDbcs(addr, String.fromCharCode(codec.decodeDbcsPair(b, b2)), b, b2);
      addr += 2;
      continue;
    }
    if (b >= 0x40) {
      buf.setChar(addr, String.fromCharCode(codec.decodeByte(b)), b);
      addr++;
      continue;
    }
    if (b === 0x00) {
      // NUL は表示データ（ブランク）。フィールド初期値等でインラインに現れる
      buf.eraseRange(addr, addr);
      addr++;
      continue;
    }
    if (b === UNMAPPABLE) {
      /**
       * **オーダーではなく「表せない文字」の印**（`UNMAPPABLE` の doc を参照）。
       * 1 桁を占める文字として扱い、**空白として置く**——桁がずれるとヘルプ本文の
       * 見出しや罫線が総崩れになる。オーダーとして扱うと解析が崩れ、レコード末尾の
       * READ ごと捨てて「応答待ち」で固まる。
       *
       * **空白と区別できるようにする**（`setUnmappable`）——区別しないと
       * 「ヘルプが虫食い」としか見えない。ACS も同じ桁を塗り潰しで描く。
       */
      buf.setUnmappable(addr++);
      unmappable++;
      continue;
    }
    switch (b) {
      case ORDER.SBA:
        addr = buf.addrOf(r.u8(), r.u8());
        break;
      case ORDER.IC:
      case ORDER.MC:
        // 01 では IC/MC とも「カーソル位置の設定」として扱う（IC_ULOCK の厳密な扱いは必要時に拡張）
        buf.cursorAddr = buf.addrOf(r.u8(), r.u8());
        result.cursorSet = true;
        break;
      case ORDER.RA: {
        const target = buf.addrOf(r.u8(), r.u8());
        const fill = r.u8();
        if (target < addr) {
          throw new As400Error("PROTOCOL_ERROR", `RA target ${target} < current ${addr}`);
        }
        for (; addr <= target; addr++) {
          if (fill === 0x00) buf.eraseRange(addr, addr);
          else if (isAttribute(fill)) buf.setAttr(addr, fill);
          else buf.setChar(addr, String.fromCharCode(codec.decodeByte(fill)));
        }
        break;
      }
      case ORDER.EA: {
        // EA = 行 桁 length [属性タイプ×(length-1)]（length=2〜5。SC30-3533 / tn5250 erase_to_address）
        const target = buf.addrOf(r.u8(), r.u8());
        const len = r.u8();
        if (len < 2 || len > 5) {
          warn(`invalid EA length ${len} — discarding rest of record`);
          r.skip(r.remaining);
          return;
        }
        r.skip(len - 1); // 属性タイプバイト群（未対応。全消去として扱う）
        if (target < addr) {
          throw new As400Error("PROTOCOL_ERROR", `EA target ${target} < current ${addr}`);
        }
        // 消去は target を含む（tn5250 erase_region と一致）。再開アドレスは tn5250 に合わせ target
        buf.eraseRange(addr, target);
        addr = target;
        break;
      }
      case ORDER.SOH: {
        // フォーマットテーブルの開始: 既存フィールドをクリアし、エラー行等のヘッダを読み飛ばす
        const len = r.u8();
        r.skip(len);
        buf.clearFormatTable();
        break;
      }
      case ORDER.TD: {
        const len = r.u16();
        const bytes = r.bytes(len);
        for (const tb of bytes) {
          buf.setChar(addr++, String.fromCharCode(codec.decodeByte(tb)));
        }
        break;
      }
      case ORDER.SF: {
        addr = applySf(r, buf, addr);
        break;
      }
      case ORDER.WDSF: {
        applyWdsf(r, buf, codec, addr, warn);
        break;
      }
      case ORDER.UNKNOWN_1C:
        // 表示は "*" 1 文字（桁を 1 つ占有）。詳細は ORDER.UNKNOWN_1C の doc コメント参照。
        //
        // **rawByte は渡さない。** 0x1C は実際に受信した EBCDIC 文字バイトではなく
        // このオーダー自身の識別バイトなので、rawByte として持たせるとカタカナ表示
        // モード（ScreenGrid.vue の katakanaView）がこれを生バイトとして半角カナに
        // 再解釈してしまい、"*" のはずが文字化けする（利用者報告で発覚）。
        buf.setChar(addr++, "*");
        break;
      default:
        warn(`unknown order 0x${b.toString(16)} — skipping to next command`);
        // **オーダーの長さは分からないが、レコード全体を捨てない。**
        // 次のコマンドまで読み飛ばして復帰する。捨ててしまうと、後続の WRITE
        // （キーボード解放の CC2 等）や READ が丸ごと失われ、ホストは送ったつもりでも
        // クライアントの鍵盤が開かず「応答待ちのまま固まる」。
        //
        // **`0x04` を見つけただけでは ESC と決めない。** `0x04` はオーダーの
        // パラメータにも現れる——実測した PUB400 のヘルプ画面では `11 04 05`
        // （SBA 行 4 桁 5）の行バイトを ESC と読み違え、続く `05` を未知コマンドと見なして
        // **末尾の READ MDT FIELDS ごと捨てていた**。直後が既知のコマンドである
        // ものだけを ESC と認めれば、この取り違えは起きない。
        while (r.remaining > 0) {
          if (r.peek() === ESC && r.remaining >= 2 && isKnownCommand(r.peekAt(1))) break;
          r.u8();
        }
        warnUnmappable(unmappable, warn);
        return;
    }
  }
  warnUnmappable(unmappable, warn);
}

/**
 * 「表せない文字」があったことを**理由と直し方まで添えて**1 度だけ知らせる。
 *
 * 黙って空白にすると、利用者には「ヘルプが虫食いで出る」としか見えない。
 * 直せるのは接続の CCSID なので、そこまで書く。
 */
function warnUnmappable(count: number, warn: WarnFn): void {
  if (count === 0) return;
  warn(
    `ホストがこのコードページで表せない文字を ${count} 個送ってきました（空白にしました）。` +
      "英語のシステムへカタカナのコードページ（CCSID 930 / 5026＝コードページ 290）で" +
      "繋いだときに起きます。接続設定の CCSID を 37 か 5035 にすると読めるようになります。"
  );
}

/**
 * WDSF オーダー（0x15）: 拡張 5250 GUI 構造体（Create Window / Define Selection Field / Scroll Bar 等）。
 * 構造は [LL(2, 自身含む)] [class(1)=0xD9] [type(1)] [body...]。位置はデータストリームの現在アドレス。
 */
function applyWdsf(
  r: ByteReader,
  buf: ScreenBuffer,
  codec: Codec,
  addr: number,
  warn: WarnFn
): void {
  const len = r.u16();
  if (len < 4 || len - 2 > r.remaining) {
    warn(`invalid WDSF length ${len} — discarding rest of record`);
    r.skip(r.remaining);
    return;
  }
  const sf = r.bytes(len - 2); // [class, type, ...body]
  const { row, col } = buf.rowColOf(addr);
  let event;
  try {
    event = parseWdsf(sf, (b) => codec.decodeByte(b));
  } catch {
    warn("malformed WDSF structured field — ignored");
    return;
  }
  switch (event.kind) {
    case "selection":
      buf.addSelectionField(event.field, row, col);
      break;
    case "window":
      buf.addWindow(event.window, row, col);
      break;
    case "scrollbar":
      buf.addScrollBar(event.scrollbar, row, col);
      break;
    case "remove-selection":
      buf.removeSelectionField(row, col);
      break;
    case "remove-window":
      buf.removeWindow(row, col);
      break;
    case "remove-scrollbar":
      buf.removeScrollBar(row, col);
      break;
    case "remove-all":
      buf.clearGui();
      break;
    case "grid-lines":
      buf.applyGridLines(event.grid);
      break;
    case "clear-grid-lines":
      buf.clearGridLines();
      break;
    case "unknown":
      warn(`unhandled WDSF type 0x${event.type.toString(16)} — ignored`);
      break;
  }
}

/** SF オーダー: [FFW(2)] [FCW(2)*] attr(1) length(2)。FFW 省略時は出力専用（フィールド登録なし） */
function applySf(r: ByteReader, buf: ScreenBuffer, addr: number): number {
  const first = r.peek();
  if (isAttribute(first)) {
    // FFW なし = 出力専用フィールド定義: 属性と長さのみ（フォーマットテーブルに載せない）
    const attr = r.u8();
    r.u16(); // length（表示専用のため未使用）
    buf.setAttr(addr, attr);
    return addr + 1;
  }
  const ffw = r.u16();
  if ((ffw & 0xc000) !== 0x4000) {
    throw new As400Error("PROTOCOL_ERROR", `invalid FFW 0x${ffw.toString(16)}`);
  }
  // FCW（上位 2 ビットが 10）: DBCS 種別等を解釈（SC30-3533 / tn5250 の ideographic FCW）
  let dbcsType: "pure" | "open" | "either" | undefined;
  while (r.remaining >= 2 && (r.peek() & 0xc0) === 0x80) {
    const fcw = r.u16();
    if (fcw === 0x8200) dbcsType = "pure"; // ideographic-only
    else if (fcw === 0x8240) dbcsType = "either"; // ideographic-either
    else if (fcw === 0x8280 || fcw === 0x82c0) dbcsType = "open"; // ideographic-open
  }
  const attr = r.u8();
  const length = r.u16();
  buf.setAttr(addr, attr);
  const fieldStart = addr + 1;
  buf.addField(fieldStart, length, ffw, attr, dbcsType);
  return fieldStart;
}

/**
 * WRITE STRUCTURED FIELD（ホスト → クライアント）。5250 QUERY（class 0xD9 / type 0x70）を検出したら
 * true を返す（呼び出し側が Query Reply を送る）。その他の SF は読み飛ばす（subtask 04 で拡張）。
 */
function applyStructuredField(r: ByteReader, warn: WarnFn): boolean {
  let isQuery = false;
  while (r.remaining >= 2) {
    if (r.peek() === ESC) break; // 次のコマンド
    const len = r.u16();
    if (len < 2) {
      warn(`invalid structured field length ${len}`);
      return isQuery;
    }
    const bodyLen = len - 2;
    if (r.remaining < bodyLen) {
      warn(`structured field truncated (need ${bodyLen}, have ${r.remaining})`);
      return isQuery;
    }
    const body = r.bytes(bodyLen);
    // body[0]=class, body[1]=type
    if (body[0] === 0xd9 && body[1] === 0x70) isQuery = true;
  }
  return isQuery;
}

/**
 * WRITE ERROR CODE: エラー行のメッセージを systemMessage として保持する（表示行への描画は簡略化）。
 * WRITE ERROR CODE TO WINDOW（0x22）も、桁指定の 2 バイトを読み飛ばしたうえでここへ来る。
 *
 * **SO/SI で挟まれた DBCS（漢字）は 2 バイト 1 組で読む。** 1 バイトずつ `decodeByte` に
 * 通すと、DBCS のペアがそれぞれ無関係な SBCS 文字に化ける（メッセージが日本語のとき、
 * 画面下部のエラー行が文字化けする不具合として利用者から報告された）。
 */
function applyWriteErrorCode(r: ByteReader, buf: ScreenBuffer, codec: Codec): void {
  let msg = "";
  let dbcsMode = false;
  while (r.remaining > 0 && r.peek() !== ESC) {
    const b = r.u8();
    if (b === SO) {
      dbcsMode = true;
      continue;
    }
    if (b === SI) {
      dbcsMode = false;
      continue;
    }
    if (dbcsMode && codec.decodeDbcsPair && b >= 0x40) {
      const b2 = r.u8();
      msg += String.fromCharCode(codec.decodeDbcsPair(b, b2));
      continue;
    }
    if (b >= 0x40) msg += String.fromCharCode(codec.decodeByte(b));
    else if (b === ORDER.IC || b === ORDER.SBA || b === ORDER.MC) r.skip(2);
    // その他の制御は読み飛ばす
  }
  const trimmed = msg.trim();
  if (trimmed !== "") buf.systemMessage = trimmed;
}
