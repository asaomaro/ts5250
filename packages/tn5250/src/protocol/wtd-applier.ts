import { As400Error } from "@ts5250/base";
import { type Codec, SO, SI } from "@ts5250/ebcdic";
import { nextSystemMessageSeq, type ScreenBuffer } from "../screen/buffer.js";
import type { ContinuedPart, DbcsFieldType, SelfCheckKind, WriteExtent } from "../screen/types.js";
import { ByteReader } from "./bytes.js";
import { ESC, COMMAND, ORDER, UNMAPPABLE, isAttribute, isKnownCommand } from "./constants.js";
import {
  detectPcoMarker,
  readPcCommand,
  PCO_SCAN_BYTES,
  type PcCommandRequest
} from "./pc-command.js";
import { parseWdsf } from "./wdsf-parser.js";

/** データストリーム適用の結果（キーボード状態の遷移は Session が判断する） */
export interface ApplyResult {
  lockKeyboard: boolean;
  unlockKeyboard: boolean;
  /** Read 系コマンドを受けた（＝ホストが入力を待っている） */
  readRequested: boolean;
  /**
   * **入力待ちに入った Read のコマンドバイト**（`0x52` / `0x82` / `0x42`）。
   *
   * **応答の形式がこれで変わる。** `0x52`/`0x82` は `SBA + MDT の立った欄`、
   * `0x42` は **SBA 無し・全欄・欄長そのまま**（`buildReadInputFieldsResponse`）。
   * どの Read で待たされているかを憶えておかないと、次の AID で誤った形式を返す。
   */
  readCommand?: number;
  alarm: boolean;
  /** ホストが 5250 QUERY を送ってきた（Query Reply を返す必要がある） */
  queryRequested: boolean;
  /**
   * ホストが WSF クラス D9・種類 72 を送ってきた（`20260921-wsf-d9-72`）。**応答しないとホストは待ち続ける**
   * （社内機で DSM に出させたところ、応答が無いままキーボードが施錠され続けた）。値は SF の 3 バイト目（フラグ）と 4 バイト目
   */
  wsfD972?: { flags: number; next: number };
  /**
   * **このレコードで起きた退避の一覧**（起きた順。SAVE SCREEN / SAVE PARTIAL SCREEN）。
   * 空でなければ、**1 件につき 1 本の応答をホストへ返す必要がある**——返さないとホストは
   * 先へ進まない（SEU の F1 でヘルプが返らなかった／QSH が「待機中」で固まった原因）。
   *
   * **真偽値ではなく一覧なのは、1 レコードに SAVE が 2 回入る形に耐えるため。**
   * 応答を組むのはレコードを流し終えた後なので、真偽値だと「どの段に積荷を添えるか」が
   * 分からなくなる（`20260920-restore-screen-parity` の T4 独立点検で実測: 2 段目の RESTORE で
   * 積荷が適用され、欠陥が無警告で再発した）。`depth` は `ScreenBuffer.saveScreen()` が返した段の番号。
   *
   * `params` は SAVE PARTIAL の 5 バイト。**応答には写さない**（ホストは使っていない。
   * `save-screen.ts` の注記）——記録として持つだけ。
   */
  saveRequests: { kind: "full" | "partial"; depth: number; params?: Uint8Array }[];
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
  /**
   * **このレコードがカーソルを置いた**（WTD の終わりの `placeCursorAfterWtd`・RESTORE・エラーのレコード）。
   * ~~偽なら呼び出し側が既定動作（先頭入力欄へ）を適用する~~——既定位置も WTD の終わりで置く
   * （ACS `preprocessWCC2`。`20260921-cursor-per-wtd-acs`）。READ では触れない。
   */
  cursorSet: boolean;
  /**
   * CC2 がメッセージ待ち表示（MW）を点けた／消した。**触れなかったら `undefined`**
   * （前の状態を保つ。CC2 のビットが立っていない WTD で消してはいけない）。
   */
  messageWaiting?: boolean;
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
   * このレコードで RESTORE SCREEN / RESTORE PARTIAL SCREEN が**成功した回数**。
   * 退避スタックが空で復元できなかった回は数えない。
   *
   * **本番の分岐には使わない**（復元した入力状態は `restoredReadCommand` で渡す）。
   * 残してあるのは、テストと障害切り分けで「復元が本当に成立したか」を外から見るため
   * ——`restoredReadCommand` は積荷を添えた段でしか埋まらないので、これだけでは
   * 「復元が起きなかった」と「積荷が無かった」を区別できない
   * （`20260920-restore-screen-parity` review ラウンド 1）。
   */
  restoredCount: number;
  /**
   * 復元した画面が待っていた READ のコマンドバイト（ACS `Save5250Net.SavePendingRead`）。
   * このレコードで複数回復元したら**最後のもの**。
   * **セッション層は `applyDataStream` の直後にこれを反映すること**——後段には早期 return が
   * 並んでおり、同じレコードに READ SCREEN 等が載っていると届かない
   * （`20260920-restore-screen-parity` の cross 点検で実測）。
   */
  restoredReadCommand?: number;
}

/** CC2 ビット（SC30-3533。GNU tn5250 session.h と一致確認済み） */
const CC2_UNLOCK = 0x08;
/** CC2: キーボードを解錠してもカーソルを動かさない（ACS `preprocessWCC2` の 0x40） */
const CC2_NO_CURSOR_MOVE = 0x40;
const CC2_ALARM = 0x04;

/** PC Organizer 標識の先頭バイト（非表示属性）。ここを見てから 11 バイトを照合する */
const PCO_ATTR = 0x27;
/** 標識照合＋コマンド本文の読み取りに覗く最大バイト数 */

export type WarnFn = (message: string) => void;

/**
 * IC/MC が指したカーソル位置の**保留値**（ACS の `DS5250.WTD_IC_addr` / `WTD_MC_addr` 相当。
 * いまは `ScreenBuffer.icAddr` / `mcAddr` が持つ——**レコードをまたいで持ち越す**。
 * ~~1 レコードの中だけで持つ~~ と、IC を送った WTD の後に別のレコードで IC の無い WTD が来たとき
 * ACS（IC に置く）と食い違う。`20260921-cursor-per-wtd-acs`）。
 *
 * **IC は「見つけた瞬間にカーソルを動かす」ものではない。** ACS は IC/MC をこの保留値に
 * 溜め、WRITE TO DISPLAY 1 つを処理し終えた時点（`preprocessWCC2`）で初めて
 * `ps.setCursorPosition()` する。そして**保留値は SOH（フォーマットテーブルの開始）で
 * 捨てられる**——`processWriteToDisplay` の SOH 分岐が `processClearFMT()` を呼び、
 * その中で `WTD_IC_addr = -1; WTD_MC_addr = -1` に戻す（CLEAR UNIT /
 * CLEAR FORMAT TABLE も同じ経路）。
 *
 * この差が実画面に出る。PA0100R（出荷予測売上係数入力）は 1 レコードの中で
 * 「年月度ヘッダを描く WTD（CSRLOC により毎回 `IC(2,10)`）」→「明細を描く WTD（SOH あり・
 * IC なし）」と続けて送ってくる。レコード全体で「最後に見た IC」を採ると、明細側の WTD が
 * 位置を指していないのに、既に保護化された年月度 (2,10) が最終位置になってしまう
 * （利用者報告の不具合。`work/pa0100j-cursor/` の証跡）。SOH で捨てれば、明細側の WTD は
 * 「指定なし」となり、ACS と同じく先頭入力欄 (3,23) へ落ちる。
 */
/**
 * **1 レコードの中のカーソルの決め方の状態**（ACS `DS5250.processCommand` がレコードの頭で戻す
 * `kbd_state_chg` と `pendingCCbyte2`。`20260921-cursor-per-wtd-acs`）。IC / MC の番地そのものは
 * レコードをまたいで持ち越すので、バッファ（`ScreenBuffer.icAddr` / `mcAddr`）が持つ。
 */
interface RecordCursorState {
  /** CC2 の持ち越し（ACS `pendingCCbyte2`）。0x40＝カーソルを動かさない */
  pendingCc2: number;
}

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
    saveRequests: [],
    readScreenRequested: false,
    readImmediateRequested: false,
    readMdtImmediateAltRequested: false,
    readScreenExtendedRequested: false,
    cursorSet: false,
    restoredCount: 0,
    lastWrite: { cleared: false, restored: false, cells: 0 }
  };

  // **レコード境界はここ**（1 レコード＝1 回の呼び出し）。書き込み範囲の記録をここで開始する。
  // 何も書かずに終わったレコードでは、buffer 側が前回の確定値を残す（窓を描くレコードと
  // 入力を待つだけのレコードが分かれて届いても窓が消えないようにするため）。
  buf.beginRecord();
  const cursorState: RecordCursorState = { pendingCc2: 0 };
  const cursorBeforeRecord = buf.cursorAddr;
  /** このレコードに WRITE ERROR CODE（0x21 / 0x22）が含まれていた */
  let errorCodeWritten = false;
  const finish = (): ApplyResult => {
    if (errorCodeWritten) {
      // **エラー通知のレコードでは、カーソルを操作員が置いた位置から動かさない。**
      // ACS 実測（`work/pa0100j-cursor/` の証跡）: 明細 r3c23／r5c23 から PageUp すると
      // 「前ページはありません。」が出るが、カーソルはどちらもその場に留まる。同じ応答には
      // 明細を描き直す WTD（IC なし）とメッセージ行の IC(2,10) が入っているので、通常の
      // 規則をそのまま当てると先頭入力欄や年月度へ飛んでしまう——エラーで打鍵位置を
      // 奪われるのは、打ち直す操作員にとって実害が大きい。
      buf.cursorAddr = cursorBeforeRecord;
      result.cursorSet = true;
    }
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
        buf.clearUnit(); // IC / MC も捨てる（ACS `processClearFMT`）
        break;
      case COMMAND.CLEAR_UNIT_ALTERNATE: {
        // Clear Unit Alternate は 1 バイトのパラメータ（アルタネート形式・通常 0x00）を伴う。
        // これを消費しないと後続コマンドの ESC 同期がずれ、画面本体を取りこぼす
        // （DBCS 端末 IBM-5555-C01 の SEU 等がこの命令を使う）。
        r.u8();
        // 27x132 へ切替えクリア。24x80 端末（alternate 未許可）でも `clearUnitAlternate()` が
        // 現在のサイズでクリアするので、`clearUnit()` へは倒さない——**罫線の扱いが違う**
        // （`clearUnit()` 経由だと 24x80 専用画面で罫線が消える。KSN20 / S9R167D の回帰）。
        // 窓・選択フィールドは 0x40 と同じく閉じる（実機 WINCUA で残骸を確認。`buffer.ts` 参照）。
        if (!buf.clearUnitAlternate()) {
          warn("CLEAR UNIT ALTERNATE on 24x80 terminal — clearing at current size (grid lines kept)");
        }
        break;
      }
      case COMMAND.CLEAR_FORMAT_TABLE:
        buf.clearFormatTable(); // 保留中の IC/MC も捨てる（ACS `processClearFMT`）
        break;
      case COMMAND.SAVE_SCREEN:
        // SAVE SCREEN（ESC 0x02）: 現バッファを退避。後続の WTD がオーバーレイを描く。
        // **加えてホストへ画面を送り返す必要がある**（呼び出し側が応答レコードを送る）。
        // 返信しないとホストは待ち続ける——SEU の F1 でヘルプが返らなかった原因。
        const fullDepth = buf.saveScreen();
        result.saveRequests.push({ kind: "full", depth: fullDepth });
        // **退避のときにエラー表示は解除する**（ACS `DS5250.processSaveScreen` の冒頭が
        // `isErrorMode()` なら `clearErrorMode()` する）。窓の SAVE/RESTORE 往復で
        // メッセージ行を書き替えない画面でも、メッセージが残らないようにするため
        buf.systemMessage = undefined;
        break;
      case COMMAND.RESTORE_SCREEN:
        restoreAndSkipPayload(r, buf, result, warn, "RESTORE SCREEN");
        break;
      case COMMAND.SAVE_PARTIAL_SCREEN: {
        // SAVE PARTIAL SCREEN（ESC 0x03）: **パラメータ 5 バイト**（実機の QSH で
        // `00 00 00 00 00`）。SAVE SCREEN と同じく**ホストは応答を待っている**
        // ——返さないと次を送ってこない（QSH が「待機中」で固まっていた原因）。
        // **パラメータは応答へ写さない**（ホストは使っていない。`save-screen.ts` の注記）。
        // 記録として `saveRequests` に持つだけ。
        const params = r.bytes(5);
        const partialDepth = buf.saveScreen();
        result.saveRequests.push({ kind: "partial", depth: partialDepth, params });
        buf.systemMessage = undefined; // 0x02 と同じ経路（ACS も同じメソッドで解除する）
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
        //
        // **積荷そのものは読み飛ばす**（`restoreAndSkipPayload`）。長さで測るので、
        // 積荷が無い・一致しないときは 1 バイトも進まず、原典どおりの振る舞いに落ちる。
        restoreAndSkipPayload(r, buf, result, warn, "RESTORE PARTIAL SCREEN");
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
        // ~~⚠ 実機で ROLL を送ってくる画面は見つかっていない。根拠は原典 2 実装の一致だけである~~ → DSM に出させて
        // 実測し（`scripts/host-src/dscmd.c` の `ROLLUP` / `ROLLDOWN`・`ROLLTESTUP` / `ROLLTESTDOWN`）、ACS `PS5250.processRoll` とも
        // 突き合わせた（`20260921-roll-vacated-rows`。空いた行は元の内容が残る——`ScreenBuffer.roll`）。
        // 業務の画面で ROLL を送ってくるものは今も見つかっていない（11 画面の国勢調査で 0 件。`20260730-datastream-command-census`）
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
        applyWtd(r, buf, codec, result, warn, cursorState);
        break;
      case COMMAND.WRITE_ERROR_CODE:
        applyWriteErrorCode(r, buf, codec);
        errorCodeWritten = true;
        break;
      case COMMAND.WRITE_ERROR_CODE_WINDOW:
        // 窓が開いている間のエラーはこちら。メッセージ行の開始桁・終了桁（2 バイト）を
        // 読み捨ててから本文へ——**捨てないと桁が 1 つずれて先頭が化ける**。
        // 描画は 0x21 と同じ扱い（systemMessage）で、窓の中への描き込みまではしない。
        r.skip(2);
        applyWriteErrorCode(r, buf, codec);
        errorCodeWritten = true;
        break;
      case COMMAND.WRITE_STRUCTURED_FIELD: {
        const sf = applyStructuredField(r, warn);
        if (sf.query) result.queryRequested = true;
        if (sf.d972) result.wsfD972 = sf.d972;
        break;
      }
      case COMMAND.READ_MDT_FIELDS:
      case COMMAND.READ_MDT_FIELDS_ALT:
      case COMMAND.READ_INPUT_FIELDS: {
        applyCc(r.u8(), buf, result);
        applyCc2(r.u8(), result);
        result.readRequested = true;
        // **どの Read で待つかを残す。** `0x42` だけ応答の形式が違う
        // （SBA 無し・全欄・欄長そのまま。`buildReadInputFieldsResponse` の JSDoc に実測ごと控えた）
        result.readCommand = cmd;
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

/**
 * **RESTORE SCREEN / RESTORE PARTIAL SCREEN: 復元し、ホストが返してきた自分の積荷を読み飛ばす。**
 *
 * ホストは SAVE SCREEN 応答として送ったバイト列を**不透明な保管物**として預かり、RESTORE で
 * そのまま返してくる（ACS も同じ。`DS5250.processRestoreScreen`）。こちらの積荷は
 * `ESC 0x11`（WTD）で始まる**平文のデータストリーム**なので、読み飛ばさないと
 * **自分が送った WTD を「次のコマンド」として適用してしまう**——打鍵した文字は
 * `writeCell` の既定で空白になり、SF は元の FFW を書き戻すので MDT も落ちる
 * （`20260920-restore-screen-parity` research F5・F10）。
 *
 * **「レコードの残りを捨てる」ではなく「送った長さぶん読み飛ばす」**。
 * ACS は残り全部を消費するが、それは ACS の積荷（zlib・約 2,880 バイト）を前提にした境界で、
 * **当 PJ の積荷（793 バイト）だと、QSH から F3 で抜ける経路でホストが同じレコードの末尾に
 * READ MDT を載せてくる**（実機で 2 回再現。Attn→F12 の経路では別レコードだった。
 * `20260920-restore-screen-parity` research F16）。捨てると施錠が解けなくなる（同 decisions D10）。
 *
 * 一致しなければ 1 バイトも進めない——**退行しない側に倒す**。黙って落ちるとホストの振る舞いが
 * 変わったときに気づけないので警告を出す。
 */
function restoreAndSkipPayload(
  r: ByteReader,
  buf: ScreenBuffer,
  result: ApplyResult,
  warn: WarnFn,
  label: string
): void {
  const { restored, payload, readCommand } = buf.restoreScreen();
  if (!restored) {
    warn(`${label} with empty save stack`);
    return;
  }
  result.restoredCount++;
  if (readCommand !== undefined) result.restoredReadCommand = readCommand;
  if (payload === undefined || payload.length === 0) {
    // **黙って落ちない**（この関数の JSDoc の主張どおり）。ここに来るのは
    // 「SAVE 応答を送ったのに積荷を添え損ねた」＝配線のずれ——ただし
    // ⚠ **同一レコードに SAVE → RESTORE が載った場合にも必ず出る**（応答を組むのは
    // レコードを流し終えた後なので、まだ `attachSaveContext` が呼ばれていない）。
    // その場合はホストも積荷を返しようがないので**無害な空振り**だが、本当のずれと
    // 区別が付かない（`20260920-restore-screen-parity` review ラウンド 5。実機では未観測）
    warn(`${label}: no payload recorded for this save — parsing as commands`);
    return;
  }
  // **全バイトで照合する**。先頭だけを見て読み飛ばすと、ホストが積荷を改変していた場合に
  // 別物を黙って捨てることになる（数百バイトの比較なので費用は問題にならない）
  const ahead = r.peekUpTo(payload.length);
  if (ahead.length !== payload.length || !ahead.every((b, i) => b === payload[i])) {
    warn(`${label}: payload mismatch (expected ${payload.length} bytes) — parsing as commands`);
    return;
  }
  r.skip(payload.length);
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
      // **消してから MDT を落とす。順序が逆だと 1 欄も消えない**
      // （`nullNonBypass(true)` は MDT の立った欄だけを対象にするので、
      //  先に MDT を落とすと対象が 0 件になる）。
      // ACS `DS5250.processWCC1` の該当分岐も `clearNonbypassFields(true)` →
      // `resetMDTFields(true)` の順（`20260921-wtd-cc1-c0-order` で原典を確認）。
      buf.nullNonBypass(true);
      buf.resetMdtNonBypass();
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
  // **メッセージ待ち表示（MW）**（`20260921-message-waiting-indicator`）。
  // ACS `DS5250.processWCC2` は `cc2 & 0x02` で消灯（`WCC2_MW_OFF`）、続けて
  // `cc2 & 0x01` で点灯（`WCC2_MW_ON`）する——**両方立てば点灯が勝つ**ので同じ順で評価する。
  // 以前はオペコード（MESSAGE_LIGHT_ON/OFF）だけを見て、**CC2 のビットを見ていなかった**
  if ((cc2 & 0x02) !== 0) result.messageWaiting = false;
  if ((cc2 & 0x01) !== 0) result.messageWaiting = true;
}

/**
 * **WTD の終わりでカーソルを置く**（ACS `DS5250.preprocessWCC2`。`20260921-cursor-per-wtd-acs`）。
 *
 * - CC2 の 0x40（カーソルを動かさない）を持ち越し（最後の WTD の指定が勝つ）、**動かしてよければ IC の番地、
 *   無ければホーム**（最初の非 bypass 欄。欄が無ければ 1 行 1 桁）へ置く。MC があれば MC
 * - 動かさない指定でも MC だけは効く
 * - **READ ではカーソルに触れない**（ACS の READ INPUT / MDT / MDT ALT は `pending_read` を覚えるだけ）。
 *   ~~READ のときに（そのレコードで IC が無ければ）先頭の入力欄へ置く~~ だと、WTD と READ が別のレコードで
 *   来る画面（CL の SNDF → RCVF など）で、WTD の IC が READ で先頭の入力欄へ上書きされていた（実機で確認。
 *   `scripts/acs-probe/read-split-record.txt`: ACS は IC の 7,20、当 PJ は 5,20）
 *
 * ⚠ **原典にある「解錠中に来て、キーボードの状態を変えない WTD には 0x40 を足す」は入れていない**
 * （`kbd_state_chg` と `ps.isKeyboardLocked()` の組み合わせ）。DSPFMT は「CC2 で解錠する出力だけの
 * レコード」の後に「CLEAR も SOH も CC1 の施錠も無い WTD（IC 7,4）＋READ」を送り、原典を素直に読むと
 * 3 つ目では動かないはずだが、**実機の ACS は 7,4 に置いた**（中継で採った ACS 側のレコードも同じ形）。
 * ACS がキーボードを開く時機の読みが確かめられていないので、実測と合わない条件は入れない（decisions D2）。
 */
function placeCursorAfterWtd(buf: ScreenBuffer, cc2: number, result: ApplyResult, st: RecordCursorState): void {
  st.pendingCc2 |= cc2 & 0x4f;
  if ((cc2 & CC2_NO_CURSOR_MOVE) === 0) st.pendingCc2 &= ~CC2_NO_CURSOR_MOVE;
  if ((st.pendingCc2 & CC2_NO_CURSOR_MOVE) === 0) {
    buf.cursorAddr = buf.mcAddr ?? buf.icAddr ?? buf.homeAddr();
    result.cursorSet = true;
  } else if (buf.mcAddr !== undefined) {
    buf.cursorAddr = buf.mcAddr;
    result.cursorSet = true;
  }
}

function applyWtd(
  r: ByteReader,
  buf: ScreenBuffer,
  codec: Codec,
  result: ApplyResult,
  warn: WarnFn,
  cursorState: RecordCursorState
): void {
  applyCc(r.u8(), buf, result);
  const cc2 = r.u8();
  applyCc2(cc2, result);

  /** この WTD の終わりでカーソル位置を決める（ACS `preprocessWCC2`。`placeCursorAfterWtd`） */
  const settleCursor = (): void => placeCursorAfterWtd(buf, cc2, result, cursorState);

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
      settleCursor();
      warnUnmappable(unmappable, warn);
      return;
    }

    // PC Organizer の標識（非表示属性＋固定 11 バイト）。**消費しない**——
    // 標識・コマンド本文は今までどおり画面へ書く（非表示なので見えない）。
    // 検出だけ結果に載せ、実行と応答は Session が行う（`pc-command.ts`）
    if (b === PCO_ATTR) {
      // 標識(11) + PAUSE(1) + 本文。窓は**上限いっぱいの DBCS 本文**まで届く大きさ
      const ahead = r.peekUpTo(PCO_SCAN_BYTES);
      const kind = detectPcoMarker(ahead);
      if (kind === "start") {
        const req = readPcCommand(ahead, (x) => codec.decode(x));
        if (req.truncated) {
          // **切れた本文は渡さない。** 実行すると利用者の意図と違うコマンドが走る
          warn(`PC command body was truncated at ${PCO_SCAN_BYTES} bytes; ignored`);
        } else {
          result.pcCommand = req;
        }
      } else if (kind === "end") result.pcCommandEnd = true;
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
      // **元バイトは送信用にだけ持たせる**（`hostByte`。表示には使わない）。
      // ACS は受信したバイトをそのまま `HostPlane` に入れ、READ SCREEN 応答で返す
      // （`20260920-restore-screen-parity` research F3・F4）
      buf.setUnmappable(addr++, UNMAPPABLE);
      unmappable++;
      continue;
    }
    switch (b) {
      case ORDER.SBA:
        addr = buf.addrOf(r.u8(), r.u8());
        break;
      case ORDER.IC:
        // **ここでは動かさず覚える**——確定は WTD の終わり（`placeCursorAfterWtd`）。IC は MC を捨てる
        // （ACS `processWriteToDisplay` の 0x13: `WTD_MC_addr = -1`）。番地はレコードをまたいで持ち越す
        buf.icAddr = buf.addrOf(r.u8(), r.u8());
        buf.mcAddr = undefined;
        break;
      case ORDER.MC:
        // MC は「動かさない」指定のときでも効く（ACS `preprocessWCC2` の else 枝）
        buf.mcAddr = buf.addrOf(r.u8(), r.u8());
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
        // フォーマットテーブルの開始: 既存フィールドをクリアし、ヘッダを読む。
        //
        // **ヘッダは読み捨てない。** 本体 5〜7 バイト目の 24 ビットが「**欄データを送らない
        // AID キー**」の申告で（DDS の `CAnn`）、ここを捨てていたため F12 で打鍵した値まで
        // 送っていた——「F12 で取り消したのに反映される」型の事故になる。
        // 並びと意味は `ScreenBuffer.setHeaderData` の JSDoc（実機で採った値つき）。
        const len = r.u8();
        const body = r.bytes(len);
        buf.setHeaderData(body);
        // **フォーマットテーブルを作り直すので、保留中の IC/MC も捨てる**
        // （ACS `processWriteToDisplay` の SOH 分岐 → `processClearFMT()` →
        // `WTD_IC_addr = -1`）。これが無いと、前の WTD が指した位置が
        // 「新しい画面に対する指定」として残ってしまう（PA0100R。`placeCursorAfterWtd` 参照）
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
      case ORDER.WEA: {
        // Write Extended Attribute。オーダー本体は属性タイプ・属性値の2バイト
        // （tn5250j `tnvt.java` の `case 18`、GNU tn5250 `session.c`
        // `tn5250_session_write_extended_attribute()` の2つの独立した参照実装で確認済み。
        // `.aidev/works/20260914-dspfmt-field-underline-instability` research.md F7）。
        //
        // **意味的な効果（拡張属性の実際の見た目への反映）は実装しない**——上記の
        // 2つの参照実装もどちらも実装を見送っており、IBM の正式仕様書での確認も
        // 取れていないため、憶測で実装すると誤った見た目を作り込むリスクがある。
        //
        // **ここが本質: `default:` 節（未知オーダー）に落とさないこと。** WEA の
        // バイト数（2）は既知なので、正確に2バイトだけ消費して次のオーダーへ進める。
        // `default:` 節に落ちると、次の ESC＋既知コマンドが見つかるまで読み飛ばす
        // 復旧処理が働き、WEA より後ろの同じ WTD 内の全オーダー
        // （フィールド定義・属性設定を含む）が丸ごと失われてしまう。
        const attrType = r.u8();
        const attrValue = r.u8();
        warn(
          `WEA order (type=0x${attrType.toString(16)}, value=0x${attrValue.toString(16)}) received — not applied`
        );
        break;
      }
      case ORDER.UNKNOWN_1C:
        // 表示は "*" 1 文字（桁を 1 つ占有）。詳細は ORDER.UNKNOWN_1C の doc コメント参照。
        //
        // **rawByte は渡さない。** 0x1C は実際に受信した EBCDIC 文字バイトではなく
        // このオーダー自身の識別バイトなので、rawByte として持たせるとカタカナ表示
        // モード（ScreenGrid.vue の katakanaView）がこれを生バイトとして半角カナに
        // 再解釈してしまい、"*" のはずが文字化けする（利用者報告で発覚）。
        //
        // **ただし送信（画面イメージ応答・SAVE 応答）には 0x1C を使う**——ACS は
        // `PS5250.addChar()` が 0x1C をそのまま `HostPlane` に入れ、`getBuffer()` 経由で
        // 0x1C のまま返す（`20260920-restore-screen-parity` research F3・F4）。
        // 表示用（rawByte）と送信用（hostByte）を分けて持たせる。
        buf.setChar(addr++, "*", undefined, ORDER.UNKNOWN_1C);
        break;
      case ORDER.UNKNOWN_1E:
        // ORDER.UNKNOWN_1C（0x1C）と対称的な扱い。表示は ";" 1 文字（桁を 1 つ占有）。
        // 詳細は ORDER.UNKNOWN_1E の doc コメント参照。rawByte を渡さない理由も同じ
        // （カタカナ表示モードでの再解釈・文字化けを防ぐ）。送信には 0x1E を使う（0x1C と同じ理屈）。
        buf.setChar(addr++, ";", undefined, ORDER.UNKNOWN_1E);
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
        settleCursor();
        warnUnmappable(unmappable, warn);
        return;
    }
  }
  settleCursor();
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
  let dbcsType: DbcsFieldType | undefined;
  let selfCheck: SelfCheckKind | undefined;
  let continued: ContinuedPart | undefined;
  let cursorProgression: number | undefined;
  while (r.remaining >= 2 && (r.peek() & 0xc0) === 0x80) {
    const fcw = r.u16();
    // **DBCS の 4 種は ACS の定数とちょうど一致させる**（`Field5250` の
    // `FCW_DBCS_ONLY=0x8200` / `FCW_DBCS_PURE=0x8220` / `FCW_DBCS_EITHER=0x8240` /
    // `FCW_DBCS_OPEN=0x8280`。値の完全一致で振り分ける lookupswitch で、
    // **それ以外（0x82c0 等）は ACS も無視する**）。
    // 以前は 0x8200 を "pure" と取り違え、本来の "pure"（0x8220）を取りこぼしていた
    if (fcw === 0x8200) dbcsType = "only";
    else if (fcw === 0x8220) dbcsType = "pure";
    else if (fcw === 0x8240) dbcsType = "either";
    else if (fcw === 0x8280) dbcsType = "open";
    // **自己点検欄（SELF CHECK）**。ACS `Field5250` の
    // `FCW_SELF_CHECK_MODULUS_11=0xB140` / `FCW_SELF_CHECK_MODULUS_10=0xB1A0`。
    // 末尾 1 桁がチェック・ディジットで、送信前に検算する（`selfCheckDigitOk`）
    else if (fcw === 0xb140) selfCheck = "mod11";
    else if (fcw === 0xb1a0) selfCheck = "mod10";
    // **継続入力フィールド（CONTINUED_ENTRY = 0x86）**。ホストが DDS の `EDTMSK` 等で
    // 1 つの入力欄を編集文字（`/` など）で分割したとき、区間ごとの SF にこの FCW が付く。
    // 下位バイト 1=先頭 / 3=中間 / 2=最終（GNU tn5250 `session.c` の StartOfField、
    // tn5250j `ScreenField.isContinuedFirst/Middle/Last`、Wireshark の tn5250 ディセクタが一致）。
    //
    // ⚠ **`0x8680` はワードラップで別物**——継続と誤認すると送信で欄を勝手に畳んでしまう。
    // 値が完全一致するものだけを拾う（マスク判定にしない）。
    //
    // 実機（IBM i 7.3・`ASAOLIB/MSKTST`）で採った生バイト:
    //   `1d 43 00 86 01 24 00 02` … (3,23) len=2 先頭
    //   `1d 43 00 86 03 24 00 02` … (3,26) len=2 中間
    //   `1d 43 00 86 02 24 00 02` … (3,29) len=2 最終
    else if (fcw === 0x8601) continued = "first";
    else if (fcw === 0x8603) continued = "middle";
    else if (fcw === 0x8602) continued = "last";
    // **カーソル送り（CURSOR_PROGRESSION_ENTRY_FIELD = 0x88nn）**。DDS の `FLDCSRPRG`。
    // 下位バイトが**送り先の欄番号**（1 始まり・画面順）。ホストが入力の順序をアプリの都合で
    // 決める仕組みで、無視すると「Tab で飛ぶ先が実機と違う」ことになる。
    // 参照実装 2 つとも下位バイトをそのまま持つ（GNU tn5250 `session.c` の
    // `nextfieldprogressionid`、tn5250j `ScreenField.setFCWs` の `cursorProg = fcw2`）。
    //
    // 実機（IBM i 7.3・`ASAOLIB/KEYDSPF` の `FLDCSRPRG(IN3)`）で採った値: 欄#1 に `0x8803`。
    else if ((fcw & 0xff00) === 0x8800) cursorProgression = fcw & 0x00ff;
  }
  const attr = r.u8();
  const length = r.u16();
  buf.setAttr(addr, attr);
  const fieldStart = addr + 1;
  buf.addField(fieldStart, length, ffw, attr, dbcsType, continued, cursorProgression, selfCheck);
  return fieldStart;
}

/**
 * WRITE STRUCTURED FIELD（ホスト → クライアント）。5250 QUERY（class 0xD9 / type 0x70）と、クラス D9・種類 72（長さ 6 のとき。
 * ACS `DS5250.processWSF` と同じ条件）を拾う（呼び出し側が応答を送る）。その他の SF は読み飛ばす。
 */
function applyStructuredField(r: ByteReader, warn: WarnFn): { query: boolean; d972?: { flags: number; next: number } } {
  let isQuery = false;
  let d972: { flags: number; next: number } | undefined;
  const done = () => (d972 ? { query: isQuery, d972 } : { query: isQuery });
  while (r.remaining >= 2) {
    if (r.peek() === ESC) break; // 次のコマンド
    const len = r.u16();
    if (len < 2) {
      warn(`invalid structured field length ${len}`);
      return done();
    }
    const bodyLen = len - 2;
    if (r.remaining < bodyLen) {
      warn(`structured field truncated (need ${bodyLen}, have ${r.remaining})`);
      return done();
    }
    const body = r.bytes(bodyLen);
    // body[0]=class, body[1]=type
    if (body[0] === 0xd9 && body[1] === 0x70) isQuery = true;
    // ACS は長さが 6 のときだけ応答する（`n4 != 6` なら何もしない）
    if (body[0] === 0xd9 && body[1] === 0x72 && len === 6) d972 = { flags: body[2] ?? 0, next: body[3] ?? 0 };
  }
  return done();
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
  // **本文が空白だけでも載せて番号を振る**——ACS `DS5250.processWriteErrorCode` は本文を読む前に
  // 無条件で `setErrorMode(true)` とする（独立点検の指摘。空白だけの WEC が実際に届くかは未確認）。
  // 空なら画面に出る文言は無いが、エラー状態には入る（キーボードは Reset・矢印等まで拒否）
  buf.systemMessage = msg.trim();
  // 届くたびに番号を振る（同じ文言でも新しいエラー。UI はこれでエラー状態に入り直す）
  buf.systemMessageSeq = nextSystemMessageSeq();
}
