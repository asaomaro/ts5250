import { type Codec, SO, SI } from "@ts5250/ebcdic";
import { nextSystemMessageSeq, type ScreenBuffer } from "../screen/buffer.js";
import type { ContinuedPart, DbcsFieldType, SelfCheckKind, WriteExtent } from "../screen/types.js";
import { ByteReader } from "./bytes.js";
import { ESC, COMMAND, ORDER, FFW, UNMAPPABLE, isAttribute, isControlData, controlDataText } from "./constants.js";
import {
  detectPcoMarker,
  readPcCommand,
  PCO_SCAN_BYTES,
  type PcCommandRequest
} from "./pc-command.js";
import { parseWdsf } from "./wdsf-parser.js";

/** WSF への応答の 1 本（`ApplyResult.wsfReplies`） */
export type WsfReply = { kind: "query" } | { kind: "d972"; flags: number; next: number };

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
   * **否定応答で返すセンス・コード**（`20260921-negative-responses`）。立ったらレコードの残りは読まない（ACS `DS5250.processCommand` は
   * `sense_code` が立つとループを抜け、`tokenizeData` の終わりで否定応答を送る）。ACS と同じ条件でだけ立てる:
   * コマンドの位置に ESC が無い（0x10050121。WSF の長さが 0・1 のときも、長さの 2 バイトが次のコマンドとして読まれてここへ来る）・ROLL の指定が不正（0x1005012C）・CLEAR UNIT ALTERNATE の引数が 0 でない（0x10030101）・
   * WSF D9/72 のフラグに 0x80（0x10050112）。**返さないとホストは入力コマンドを待ち続ける**（社内機で WSF D9/72 の 0x80 を DSM に出させて実測。
   * ACS では `QsnPutInpCmd` が CPFA304 で戻り、当 PJ ではキーボードが施錠されたままになった）
   */
  senseCode?: number;
  /**
   * **WSF への応答（起きた順）**。ACS `DS5250.processWSF` は WSF ごとにその場で応答を送る（`20260921-wsf-d9-72` の節目の点検の指摘。
   * ~~Query と D9/72 のどちらか 1 本~~——同じレコードに WSF が 2 つあると片方の応答が落ち、D9/72 ならホストが待ち続けた）。
   * - `query`: クラス D9・種類 70 で、フラグ（SF の 5 バイト目）が 0（ACS は 0 のときだけ応答する）
   * - `d972`: クラス D9・種類 72・長さ 6（`20260921-wsf-d9-72`。**応答しないとホストは待ち続ける**——社内機で DSM に出させたところ、
   *   応答が無いままキーボードが施錠され続けた）。値は SF の 5 バイト目（フラグ）と 6 バイト目。フラグ 0x80 は応答せず否定応答
   */
  wsfReplies: WsfReply[];
  /**
   * **ホストのエラーのメッセージを出している間に来た WTD の位置**（`data` の中の ESC の添字。`20260927-host-error-hold`）。
   * ACS は WRITE ERROR CODE のメッセージを出している間、WTD の処理の頭で待ち（`DS5250.checkContention`）、エラー状態を抜けてから処理する。
   * 立っていれば、ここから後ろ（WTD とその後ろのコマンド）はまだ処理していない——呼び出し側が溜めて、抜けたときに処理する
   */
  heldFrom?: number;
  /** このレコードに WRITE ERROR CODE（0x21 / 0x22）があった（ACS はここで `initKeyboard`＝エラー状態なら施錠を解く。`20260927-wec-only-unlock`） */
  errorCodeWritten?: true;
  /**
   * **その場で戻る否定応答で終わった**（`abortRecord`）。ACS はこのときレコードの終わりの処理を飛ばし、SAVE PARTIAL の応答を
   * 次のレコードの終わりで送る（`bSavePartial` を先頭で捨てない。`20260927-early-return-rest`。実機のワイヤでも否定応答の後に来た）
   */
  earlyReturn?: boolean;
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
  /** 復元した画面の退避の時点で READ が出ていたか（`RestoreResult.readOutstanding`） */
  restoredReadOutstanding?: boolean;
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
 * ~~未知のコマンド（ESC 直後の 1 バイト）は警告してレコードの残りを打ち切る
 * （レコード境界で再同期。spec「エラー処理」）~~ → 未知のコマンドは 1 バイト読み飛ばして続け、コマンドの位置に ESC が無ければ
 * 否定応答 0x10050121 で打ち切る（ACS `processCommand`。`20260921-negative-responses`）。**未知のオーダー（WTD の中の 1 バイト）は
 * 次の ESC まで読み飛ばして次のコマンドから復帰する**——ここでレコード全部を捨てると、
 * 未知のオーダーより後ろにある WRITE（キーボード解放）や READ ごと失われ、
 * ホストは応答したつもりでもクライアントの鍵盤が開かないまま固まる
 * （実機で正体不明のオーダーに当たったときに観測）。
 */
export function applyDataStream(
  data: Uint8Array,
  buf: ScreenBuffer,
  codec: Codec,
  warn: WarnFn = () => {},
  /** `holdWtd`: WTD を処理する前に聞く。true なら WTD から後ろを処理せず `heldFrom` を返す（ホストのエラーの保留。`ApplyResult.heldFrom`） */
  opts: {
    holdWtd?: () => boolean;
    /** CLEAR UNIT・CLEAR UNIT ALTERNATE・WRITE ERROR CODE の頭で呼ぶ（ACS はここで `clearSysreqMode`＝SysReq の行を閉じる。`20260927-sysreq-line-hold`） */
    onClearSysReq?: () => void;
  } = {}
): ApplyResult {
  const r = new ByteReader(data);
  const result: ApplyResult = {
    lockKeyboard: false,
    unlockKeyboard: false,
    readRequested: false,
    alarm: false,
    queryRequested: false,
    wsfReplies: [],
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
    if (errorCodeWritten) result.errorCodeWritten = true;
    result.lastWrite = buf.lastWrite;
    return result;
  };

  /**
   * **SAVE PARTIAL の時点で効いていた CC2**。ACS の SAVE PARTIAL（ESC 0x03）は、それまでに溜めた WTD の CC2 をその場で効かせる
   * （`processCommand` の case 3 の `processWCC2`）ので、その後ろで戻っても消えない（`abortRecord` はここまで戻す）
   */
  let committedCc2: { alarm: boolean; messageWaiting: boolean | undefined } = { alarm: false, messageWaiting: undefined };
  /**
   * **ACS がその場で戻る否定応答**（`DS5250.processCommand` の `return`）。レコードの終わりの CC2 の処理（`processWCC2`＝警報・メッセージ待ち）を
   * 飛ばすので、**同じレコードで先に来た WTD の CC2 も効かせない**（`20260927-early-return-cc2`。社内機で WTD〔CC2＝メッセージ待ちを点ける〕＋不正な ROLL を
   * DSM に出させ、ACS のコアは点けず当 PJ は点けていた——`scripts/acs-probe/early-return-cc2.txt`・`scripts/verify-early-return-cc2.mjs`）。
   * SAVE PARTIAL より前の CC2 は残す（`committedCc2`）。WSF D9/72 のフラグ・WTD の中の誤りは ACS も終わりまで走るので、こちらを通さない。
   * CC2 の解錠ビット（`unlockKeyboard`）は戻さない——読む箇所が無い（解錠は READ で決める。`session.ts`）
   */
  const abortRecord = (sense: number): ApplyResult => {
    result.senseCode = sense;
    result.earlyReturn = true;
    result.alarm = committedCc2.alarm;
    if (committedCc2.messageWaiting === undefined) delete result.messageWaiting;
    else result.messageWaiting = committedCc2.messageWaiting;
    return finish();
  };

  /**
   * **長さの足りないコマンドは否定応答 0x10050121 でその場で戻る**（ACS `processCommand` の WTD・READ・ROLL・WRITE ERROR CODE の長さの検査。
   * `20260927-short-command-sense`）。実測（社内機。DSM に WTD〔CC2＝メッセージ待ち〕＋長さの足りないコマンドの 1 レコード）は WTD・READ MDT（0x52）・ROLL・
   * 0x21・0x22 の 5 通りで、ACS は先の WTD を書き、メッセージ待ちは点けず、否定応答を返した〔ホストの次の出力が CPFA303〕。READ の 0x42・0x82 は原典（同じ検査）から。
   * 以前は読み過ぎの例外でレコードの結果ごと捨て、応答もしなかった
   */
  const tooShort = (need: number, what: string): ApplyResult | undefined => {
    if (r.remaining >= need) return undefined;
    warn(`${what} too short (${r.remaining} of ${need} bytes) (negative response 0x10050121)`);
    return abortRecord(SENSE.COMMAND_EXPECTED);
  };

  while (r.remaining > 0) {
    const esc = r.u8();
    if (esc !== ESC) {
      warn(`expected ESC, got 0x${esc.toString(16)} — discarding rest of record (negative response 0x10050121)`);
      return abortRecord(SENSE.COMMAND_EXPECTED);
    }
    const cmd = r.u8();
    switch (cmd) {
      case COMMAND.CLEAR_UNIT:
        opts.onClearSysReq?.();
        buf.clearUnit(); // IC / MC も捨てる（ACS `processClearFMT`）
        break;
      case COMMAND.CLEAR_UNIT_ALTERNATE: {
        // Clear Unit Alternate は 1 バイトのパラメータ（アルタネート形式・通常 0x00）を伴う。
        // これを消費しないと後続コマンドの ESC 同期がずれ、画面本体を取りこぼす
        // （DBCS 端末 IBM-5555-C01 の SEU 等がこの命令を使う）。
        // **0 でなければ画面を消さずに否定応答**（ACS `DS5250.processCommand` の ESC 0x20: 0 以外は `sense_code = 0x10030101`）。
        // **引数が無い（レコードの終わり）なら 0 として消す**——ACS の長さの検査（`n5 > n2`）はちょうど引数が無い形を通し、実機の ACS のコアでも
        // 否定応答にせず画面を消した（`20260927-early-return-rest`。ACS はレコードの外を読むが、受信の置き場はレコードごとに 0 で埋める〔`clearSaveBuff`〕ので
        // 読むのは常に 0。以前の当 PJ は読み過ぎの例外でレコードごと捨てた）
        if ((r.remaining > 0 ? r.u8() : 0x00) !== 0x00) {
          warn("CLEAR UNIT ALTERNATE with a non-zero parameter (negative response 0x10030101)");
          return abortRecord(SENSE.CLEAR_UNIT_ALTERNATE_PARAM);
        }
        opts.onClearSysReq?.(); // ACS の CUA も `processClearUnit`（`clearSysreqMode`）
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
        committedCc2 = { alarm: result.alarm, messageWaiting: result.messageWaiting };
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
        const cut = tooShort(3, "roll"); // 方向＋行数・上端・下端
        if (cut) return cut;
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
        // **指定が不正なら画面を変えずに否定応答**（ACS `processRoll` が -1 を返すと `sense_code = 0x1005012C` でレコードの残りを読まない）
        if (!buf.roll(top, bottom, (dir & 0x80) !== 0 ? -lines : lines)) {
          warn(`invalid ROLL (top ${top} bottom ${bottom} lines ${lines}) (negative response 0x1005012C)`);
          return abortRecord(SENSE.ROLL_PARAM);
        }
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
      case COMMAND.WRITE_TO_DISPLAY: {
        // **エラーのメッセージを出している間は WTD を処理しない**（ACS `checkContention`。長さの検査より前——ACS も WTD の頭で待つ）
        if (opts.holdWtd?.()) {
          result.heldFrom = r.offset - 2;
          return finish();
        }
        const cut = tooShort(2, "write to display"); // CC1・CC2
        if (cut) return cut;
        const out = applyWtd(r, buf, codec, result, warn, cursorState);
        // WTD の中の誤り: 否定応答を立てて打ち切る。レコードの残りは読まないが、CC2 は落とさない（`applyWtd` の `fail`）
        if (out === "fail") return finish();
        // 長さが画面を超える TD・画面の終わりを越える文字の並び: ACS は WTD をそこで抜け、次のバイトを「ESC が無い」としてその場で戻る——CC2 も落とす
        if (out === "abort") return abortRecord(SENSE.COMMAND_EXPECTED);
        break;
      }
      case COMMAND.WRITE_ERROR_CODE: {
        const cut = tooShort(1, "write error code"); // 本文が 1 バイトも無い
        if (cut) return cut;
        opts.onClearSysReq?.(); // ACS `processWriteErrorCode` の頭で `clearSysreqMode`
        applyWriteErrorCode(r, buf, codec);
        errorCodeWritten = true;
        break;
      }
      case COMMAND.WRITE_ERROR_CODE_WINDOW: {
        // 窓が開いている間のエラーはこちら。0x21 に**メッセージ行の開始桁・終了桁（2 バイト）**が付いた形。
        // ACS はこの 2 桁で書く位置と本文の長さを決める（`20260926-window-error-code`。`applyWriteErrorCode` の説明）。
        // 1 バイトも無ければ否定応答（ACS は 0x21 と同じ検査）。桁の 2 バイトの片方だけ欠けたレコードは、0x21 と同じ扱いで読める範囲を読む（例外にしない）。
        // **欠けの判定は残りのバイト数だけで見る**——桁の値が 4（ESC と同じ値）でも桁として読む（独立点検の must）
        const cut = tooShort(1, "write error code to window");
        if (cut) return cut;
        opts.onClearSysReq?.();
        const sc = r.remaining > 0 ? r.u8() : undefined;
        const ec = sc !== undefined && r.remaining > 0 ? r.u8() : undefined;
        applyWriteErrorCode(r, buf, codec, sc !== undefined && ec !== undefined ? { start: sc, end: ec } : undefined);
        errorCodeWritten = true;
        break;
      }
      case COMMAND.WRITE_STRUCTURED_FIELD: {
        // **1 つの WSF で読むのは最初の SF だけ**（ACS `DS5250.processCommand` の ESC 0xF3: SF の長さ `n12` だけ進めて、次は ESC を求める。
        // `20260921-wsf-d9-72` の節目の点検の指摘）。~~SF を続けて全部読む~~——2 つ目の SF が続けば ACS は「コマンドが無い」（0x10050121）になる
        if (r.remaining < 4) {
          // 長さと class・type が読めない（ACS: `n5 + 4 > n2` で 0x10050121）
          warn("write structured field too short (negative response 0x10050121)");
          return abortRecord(SENSE.COMMAND_EXPECTED);
        }
        const sf = applyStructuredField(r);
        if (sf.reply) {
          result.wsfReplies.push(sf.reply);
          if (sf.reply.kind === "query") result.queryRequested = true;
        }
        if (sf.sense !== undefined) {
          // D9/72 のフラグに 0x80: ACS は応答せず否定応答（`processWSF` の `sense_code = 0x10050112`）。ループを抜けてレコードの残りは読まない
          result.senseCode = sf.sense;
          return finish();
        }
        break;
      }
      case COMMAND.READ_MDT_FIELDS:
      case COMMAND.READ_MDT_FIELDS_ALT:
      case COMMAND.READ_INPUT_FIELDS: {
        const cut = tooShort(2, "read"); // CC1・CC2
        if (cut) return cut;
        // **READ の CC1・CC2 は効かせない**（ACS は `lastReadCCbyte1/2` に控えるだけ。CC2 は先に AID が溜まっていたときだけ効く——
        // `checkPendingAid`。当 PJ の先打ちは画面の側なので、その場合は拾えない）。実機の ACS のコアでも、READ MDT の CC2＝メッセージ待ちを
        // 点けるは点かなかった（`20260927-early-return-rest`）。**CC1 は原典の読みだけで実機では測っていない**。~~CC1 で MDT を戻す・CC2 を効かせる~~
        r.skip(2);
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
        // **知らないコマンドは 1 バイト読み飛ばして続ける**（ACS `DS5250.processCommand` の `default: ++n5`。否定応答は返さない——
        // その次がコマンドでなければ上の「ESC が無い」で否定応答になる）。~~レコードの残りを捨てる~~ と、後ろの READ を失っていた。
        // 社内機で DSM に未知のコマンド（0xFE）を出させたところ、ACS でも当 PJ でもホストは rc=0 で続いた
        warn(`unknown command 0x${cmd.toString(16)} — skipping one byte (like ACS)`);
        if (r.remaining > 0) r.u8();
        break;
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
  const { restored, payload, readCommand, readOutstanding } = buf.restoreScreen();
  if (!restored) {
    warn(`${label} with empty save stack`);
    return;
  }
  result.restoredCount++;
  if (readCommand !== undefined) result.restoredReadCommand = readCommand;
  if (readOutstanding !== undefined) result.restoredReadOutstanding = readOutstanding;
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
): "fail" | "abort" | undefined {
  applyCc(r.u8(), buf, result);
  const cc2 = r.u8();
  applyCc2(cc2, result);

  /** この WTD の終わりでカーソル位置を決める（ACS `preprocessWCC2`。`placeCursorAfterWtd`） */
  const settleCursor = (): void => placeCursorAfterWtd(buf, cc2, result, cursorState);

  let addr = 0; // WTD 開始時のバッファアドレスは SBA で設定される（未設定時は先頭）
  let dbcsMode = false; // SO..SI 間は DBCS（2 バイト）モード
  /**
   * **WEA 0x12 0x05 0x81 … 0x12 0x05 0x80 の間は、SO/SI 無しの DBCS（2 バイト組）**（ACS `PS5250.writeExtAttribute` の `isInExtNLSSegment`）。
   * 純 DBCS の欄（G）のデータをホストはこの形で送ってくる（実機の DDS の G 型で確かめた。`20260921-g-field-sosi`）。
   */
  let nlsSegment = false;
  /**
   * 「表せない文字」の数。**1 度だけまとめて知らせる**——1 画面に 500 個以上出る
   * （実測）ので 1 バイトずつ警告するとログが埋まる。
   */
  let unmappable = 0;
  /**
   * **WTD の中のオーダーの誤りは否定応答にして、この WTD を打ち切る**（ACS `processWriteToDisplay`。`20260927-wtd-order-sense`）。
   * ACS はここで `sense_code` を立てて戻り、コマンドのループは条件で抜けるので**レコードの終わり（CC2）は走る**——その場で戻る否定応答
   * （`abortRecord`）と違い、CC2 は落とさない。誤りの前に書いた文字・カーソルの確定もそのまま（実機の ACS のコアで 5 通り測った:
   * `scripts/acs-probe/wtd-order-sense.txt`・`scripts/verify-wtd-order-sense.mjs`）。以前は読み過ぎ・範囲外の例外でレコードの結果ごと捨て、応答もしなかった
   */
  const fail = (sense: number, why: string): "fail" => {
    warn(`${why} (negative response 0x${sense.toString(16)})`);
    result.senseCode = sense;
    settleCursor();
    warnUnmappable(unmappable, warn);
    return "fail";
  };
  /**
   * **文字の並びが画面の終わりを越えるなら、その並びは 1 桁も書かずに打ち切る**（`20260927-ea-acs`）。ACS は ESC とオーダー以外のバイトの並びを 1 つの
   * 文字列として書き（`processWriteToDisplay` の終わりの `writeString`）、実機の ACS のコアでは、並びが最後の桁を越えると並びの**見える文字**を 1 つも書かず、
   * 0x10050121 で CC2 も落とした（24,79 から XYZ・EA 24,80 の後ろの X——`scripts/acs-probe/ea-acs.txt` の EATESTOVER / EATESTEND）。
   * 原典では手前の桁の HostPlane（READ SCREEN・SAVE の応答に出る）と並びの中の属性は書かれている見込み——当 PJ は書かない（未確認の差。decisions D2）。
   * 以前は画面の外の書き込みの例外でレコードの結果ごと捨てていた。並びの頭で 1 回だけ数える（`runEnd`＝並びが終わる位置の残りバイト数）
   */
  let runEnd = Infinity;
  /**
   * **EA が位置を画面の大きさにしたか**。ACS の文字の並び・RA・TD（`writeString`）は書いた後の位置を画面の大きさで割った余りにする——最後の桁で
   * ちょうど終わると次は 1 行 1 桁（実機の ACS のコアで 24,78 から XYZ → IC → W の W は 1,1 に書かれた。EATESTWRAP）。**EA だけは割らずに
   * 行き先の次のまま**（`eraseToAddress`）なので、その後ろの並びは画面の外になる（EATESTEND）。SBA で位置を置き直せば外れる
   */
  let eaAtEnd = false;
  const runLength = (): number => {
    let n = 0;
    while (n < r.remaining) {
      const x = r.peekAt(n);
      if (x === ESC || WTD_ORDERS.has(x)) break;
      n++;
    }
    return n;
  };
  /** 行・桁が画面の中か（ACS の `< 1 || > 行数・桁数` の検査） */
  const inScreen = (row: number, col: number): boolean => row >= 1 && row <= buf.rows && col >= 1 && col <= buf.cols;

  while (r.remaining > 0) {
    const b = r.peek();
    if (addr === buf.rows * buf.cols && !eaAtEnd) addr = 0;
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

    if (!WTD_ORDERS.has(b) && r.remaining <= runEnd) {
      const n = runLength();
      runEnd = r.remaining - n;
      if (addr + n > buf.rows * buf.cols) {
        warn(`display data (${n} bytes at ${addr}) runs past the end of the screen (negative response 0x10050121)`);
        settleCursor();
        warnUnmappable(unmappable, warn);
        return "abort";
      }
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
    // SO/SI の間・WEA5 の区間・**純 DBCS の欄（G）の中**は 2 バイト組で読む（G の欄は SO/SI 無しで組だけが並ぶ）。
    // **2 バイト目が 0x40 以上のときだけ組にする**（DBCS の 2 バイト目は 0x40 以上）。奇数バイトのまま次のオーダー（WEA・SBA・SF）が来ても、
    // 組の 2 バイト目に食わない——ACS の `processWriteToDisplay` はオーダー 10 個と ESC の手前までを 1 続きの文字列として書くので起きない。
    // 食うと偽の否定応答（0x10050121）を返し、レコードの残り（後ろの READ まで）を失う（`20260921-g-field-sosi` の独立点検 A-S2）
    if (b >= 0x40 && codec.decodeDbcsPair && r.remaining >= 1 && r.peek() >= 0x40 && (dbcsMode || nlsSegment || buf.isPureDbcsAt(addr))) {
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
    if (isControlData(b)) {
      /**
       * **オーダーでない制御バイトは表示データ**（ACS `processWriteToDisplay` のオーダーは SOH・RA・EA・TD・SBA・WEA・IC・MC・WDSF・SF の 10 個だけで、
       * それ以外の ESC 以外のバイトは全部 1 続きの文字列として書く）。0x05〜0x0D・0x16〜0x1B が該当する。
       * ~~未知のオーダーとして次の ESC まで読み飛ばす~~ は誤りだった——同じ WTD の後ろの SBA・SF・IC を失い、同じ族の 0x1C・0x1F が実機で届いていた。
       * 実機の ACS のコア（`scripts/acs-probe/wtd-control-bytes.txt`）は、各バイトを 1 桁の空白として置き（0x07 だけ DEL）、後ろのオーダーをすべて処理した。
       * `20260921-wtd-control-bytes`。元のバイトは送信用にだけ持つ（`hostByte`。画面イメージ・SAVE の応答で返す。ACS は `HostPlane` に受信バイトを入れる）
       */
      buf.setChar(addr++, controlDataText(b), undefined, b);
      continue;
    }
    switch (b) {
      case ORDER.SBA: {
        if (r.remaining < 2) return fail(SENSE.COMMAND_EXPECTED, "SBA too short");
        const row = r.u8();
        const col = r.u8();
        // **行 1・桁 0 は番地 -1**（ACS `processWriteToDisplay` の 0x11。後ろにバイトがあるときだけ——レコードの終わりなら SBCS のセッションは 0x10050122、
        // DBCS のセッションは番地 0）。直後の SF の属性は桁を占めず 1 行 1 桁から効き（ACS `setAttributeToPlanes` の `row1col0*`。`ScreenBuffer.row1col0Attr`）、
        // 欄は 1 行 1 桁から始まる。実機の ACS のコア〔DSM の WTDERRSBA10〕で `SBA 1,0 → SF → AB` の AB が 1 行 1 桁の入力欄に入り、否定応答も無かった
        // （`20260927-wtd-sense-rest`。~~受けられないので例外~~ でレコードごと失っていた）。
        // ⚠ 番地 -1 に SF 以外（文字・RA・EA・TD）が来たときの ACS の振る舞いは**未確認**（ACS は面の -1 を引く）——当 PJ は従来どおり例外で打ち切る（decisions D6）
        if (row === 1 && col === 0) {
          if (r.remaining > 0) addr = -1;
          else if (codec.decodeDbcsPair) addr = 0;
          else return fail(SENSE.ORDER_ADDRESS, "SBA 1,0 at the end of the record");
          eaAtEnd = false;
          break;
        }
        if (!inScreen(row, col)) return fail(SENSE.ORDER_ADDRESS, `SBA out of range (${row},${col})`);
        addr = buf.addrOf(row, col);
        eaAtEnd = false;
        break;
      }
      case ORDER.IC:
        // **ここでは動かさず覚える**——確定は WTD の終わり（`placeCursorAfterWtd`）。IC は MC を捨てる
        // （ACS `processWriteToDisplay` の 0x13: `WTD_MC_addr = -1`）。番地はレコードをまたいで持ち越す
        {
          if (r.remaining < 2) return fail(SENSE.COMMAND_EXPECTED, "IC too short");
          const row = r.u8();
          const col = r.u8();
          if (!inScreen(row, col)) return fail(SENSE.ORDER_ADDRESS, `IC out of range (${row},${col})`);
          buf.icAddr = buf.addrOf(row, col);
        }
        buf.mcAddr = undefined;
        break;
      case ORDER.MC: {
        // MC は「動かさない」指定のときでも効く（ACS `preprocessWCC2` の else 枝）
        if (r.remaining < 2) return fail(SENSE.COMMAND_EXPECTED, "MC too short");
        const row = r.u8();
        const col = r.u8();
        if (!inScreen(row, col)) return fail(SENSE.ORDER_ADDRESS, `MC out of range (${row},${col})`);
        buf.mcAddr = buf.addrOf(row, col);
        break;
      }
      case ORDER.RA: {
        if (r.remaining < 3) return fail(SENSE.COMMAND_EXPECTED, "RA too short");
        const row = r.u8();
        const col = r.u8();
        const fill = r.u8();
        if (!inScreen(row, col)) return fail(SENSE.ORDER_ADDRESS, `RA out of range (${row},${col})`);
        const target = buf.addrOf(row, col);
        if (target < addr) return fail(SENSE.ORDER_BACKWARD, `RA target ${target} < current ${addr}`);
        for (; addr <= target; addr++) {
          if (fill === 0x00) buf.eraseRange(addr, addr);
          else if (isAttribute(fill)) buf.setAttr(addr, fill);
          else buf.setChar(addr, String.fromCharCode(codec.decodeByte(fill)));
        }
        break;
      }
      case ORDER.EA: {
        // EA = 行 桁 length [属性タイプ×(length-1)]（length=2〜5。SC30-3533 / tn5250 erase_to_address）。
        // 検査の順は ACS と同じ: 長さ不足 → 属性タイプがレコードを越える → 行・桁 → length → 後戻り
        if (r.remaining < 3) return fail(SENSE.COMMAND_EXPECTED, "EA too short");
        const row = r.u8();
        const col = r.u8();
        const len = r.u8();
        if (len - 1 > r.remaining) return fail(SENSE.COMMAND_EXPECTED, `EA length ${len} beyond record`);
        if (!inScreen(row, col)) return fail(SENSE.ORDER_ADDRESS, `EA out of range (${row},${col})`);
        if (len < 2 || len > 5) return fail(SENSE.EA_LENGTH, `invalid EA length ${len}`);
        const target = buf.addrOf(row, col);
        // **属性タイプごとに消し、成功すれば行き先の次の番地から書く**（ACS `PS5250.eraseToAddress`。`20260927-ea-acs`。実機の ACS のコアで、
        // EA の後の文字は行き先の次の桁に書かれた——~~tn5250 に合わせて行き先から~~ は 1 桁ずれていた）。
        // - 0x00・0xFF: 今の位置から行き先まで（行き先を含む）を消す（DBCS のセッションの 0xFF は ACS では区間の印も消す——当 PJ は持たない）
        // - 0x05: DBCS のセッションだけ受ける（ACS は DBCS の区間の印だけを消す——当 PJ は区間の印を画面に持たないので消すものは無い）。それ以外のセッションは 0x1005012D
        // - その他のタイプは 0x1005012D（何も消さない）
        // - 2 つ目のタイプは、1 つ目で位置が行き先の次へ進んでいるので必ず後戻り（0x10050123）——ACS は長さ 3 以上の EA を事実上受けない（実機の ACS のコアで 0x10050123）
        for (let t = 0; t < len - 1; t++) {
          const type = r.u8();
          if (target < addr) return fail(SENSE.ORDER_BACKWARD, `EA target ${target} < current ${addr}`);
          if (type === 0x00 || type === 0xff) buf.eraseRange(addr, target);
          // 値は長さの誤りと同じ 0x1005012D（ACS も同じ値を返す）
          else if (type !== 0x05 || !codec.decodeDbcsPair) return fail(SENSE.ATTRIBUTE_TYPE, `EA attribute type 0x${type.toString(16)} not supported`);
          addr = target + 1;
        }
        eaAtEnd = addr === buf.rows * buf.cols;
        break;
      }
      case ORDER.SOH: {
        // フォーマットテーブルの開始: 既存フィールドをクリアし、ヘッダを読む。
        //
        // **ヘッダは読み捨てない。** 本体 5〜7 バイト目の 24 ビットが「**欄データを送らない
        // AID キー**」の申告で（DDS の `CAnn`）、ここを捨てていたため F12 で打鍵した値まで
        // 送っていた——「F12 で取り消したのに反映される」型の事故になる。
        // 並びと意味は `ScreenBuffer.setHeaderData` の JSDoc（実機で採った値つき）。
        if (r.remaining < 1) return fail(SENSE.COMMAND_EXPECTED, "SOH too short");
        const len = r.u8();
        // ACS は長さのバイトが無い形・本体が 1 バイトだけ足りない形をレコードの外の値で読み進める（結果が外の値に依存し再現できない）——当 PJ は否定応答にする（独自の決め）
        if (len > r.remaining) return fail(SENSE.COMMAND_EXPECTED, `SOH length ${len} beyond record`);
        // **長さが 0 か 8 以上なら否定応答**（ACS は 1〜7 のときだけフォーマットテーブルを作り直す。それ以外は何も変えずに 0x1005012B）
        if (len === 0 || len >= 8) return fail(SENSE.SOH_LENGTH, `invalid SOH length ${len}`);
        const body = r.bytes(len);
        // **フォーマットテーブルを作り直すので、保留中の IC/MC も捨てる**
        // （ACS `processWriteToDisplay` の SOH 分岐 → `processClearFMT()` →
        // `WTD_IC_addr = -1`）。これが無いと、前の WTD が指した位置が
        // 「新しい画面に対する指定」として残ってしまう（PA0100R。`placeCursorAfterWtd` 参照）
        // **ヘッダより先に消す**——ACS も `processClearFMT` でメッセージ行を最下行へ戻してから申告を採る
        // （逆にすると申告したメッセージ行が消える。`20260926-wec-msgline-row` decisions D5）
        buf.clearFormatTable("soh"); // 窓は残し、選択欄・スクロール・バーは捨てる（ACS `processClearFMT(true, false)`）
        buf.setHeaderData(body);
        break;
      }
      case ORDER.TD: {
        if (r.remaining < 2) return fail(SENSE.COMMAND_EXPECTED, "TD too short");
        const len = r.u16();
        // **長さが画面の大きさを超える TD は、WTD を否定応答なしに打ち切る**（ACS は WTD の終わりのカーソルの確定だけして TD の位置で戻り、
        // コマンドのループが TD の 0x10 を「ESC が無い」として 0x10050121 でその場で戻る——CC2 は落ちる。原典の読み。実機では出させていない）
        if (len > buf.rows * buf.cols) {
          warn(`TD length ${len} exceeds the screen (negative response 0x10050121)`);
          settleCursor();
          warnUnmappable(unmappable, warn);
          return "abort";
        }
        if (len > r.remaining) return fail(SENSE.COMMAND_EXPECTED, `TD length ${len} beyond record`);
        // **画面の終わりを越える TD は 1 バイトも書かずに 0x10050121 で打ち切る**（文字の並びと同じ。実機の ACS のコア〔DSM の WTDERRTDEND: 24,75 から 10 バイト〕は
        // 24 行を空のまま否定応答を返し、後ろの NEXT も CC2 も効かなかった。`20260927-wtd-sense-rest`。~~入る分だけ書いて例外~~ で、レコードごと失い応答もしていなかった）
        if (addr + len > buf.rows * buf.cols) {
          warn(`TD data (${len} bytes at ${addr}) runs past the end of the screen (negative response 0x10050121)`);
          settleCursor();
          warnUnmappable(unmappable, warn);
          return "abort";
        }
        const bytes = r.bytes(len);
        for (const tb of bytes) {
          buf.setChar(addr++, String.fromCharCode(codec.decodeByte(tb)));
        }
        break;
      }
      case ORDER.SF: {
        if (r.remaining < 2) return fail(SENSE.COMMAND_EXPECTED, "SF too short");
        const sf = applySf(r, buf, addr);
        if (typeof sf !== "number") return fail(sf.sense, sf.why);
        addr = sf;
        break;
      }
      case ORDER.WDSF: {
        const bad = applyWdsf(r, buf, codec, addr, warn);
        if (bad) return fail(bad.sense, bad.why);
        break;
      }
      case ORDER.WEA: {
        // Write Extended Attribute。オーダー本体は属性タイプ・属性値の2バイト
        // （tn5250j `tnvt.java` の `case 18`、GNU tn5250 `session.c`
        // `tn5250_session_write_extended_attribute()` の2つの独立した参照実装で確認済み。
        // `.aidev/works/20260914-dspfmt-field-underline-instability` research.md F7）。
        //
        // ~~**意味的な効果（拡張属性の実際の見た目への反映）は実装しない**~~ → タイプ 5 は効かせ、それ以外は否定応答で打ち切る（下。ACS `writeExtAttribute`）。
        //
        // **`default:` 節（未知オーダー）に落とさないこと。** WEA のバイト数（2）は既知なので正確に 2 バイト読む。
        // `default:` 節に落ちると、次の ESC＋既知コマンドまで読み飛ばす復旧処理が働き、後ろのオーダーを失う
        // （~~正確に2バイトだけ消費して次のオーダーへ進める~~——否定応答のときは進まず打ち切る）。
        if (r.remaining < 2) return fail(SENSE.COMMAND_EXPECTED, "WEA too short");
        const attrType = r.u8();
        const attrValue = r.u8();
        // **タイプ 5（DBCS の区間）だけは効かせる**（ACS `writeExtAttribute`。DBCS のセッションだけ）: 0x81 で区間の始まり・0x80 で終わり。
        // **0x00 は区間の旗を変えない**（ACS の `case 0` は現在位置の印を外すだけで `isInExtNLSSegment` に触れない。~~0x00 で区間を終える~~ は原典・実測の裏づけの無い推測だった。
        // 独立点検 A-S3）。区間の中のバイトは SO/SI 無しの 2 バイト組（純 DBCS の欄 G）。~~未対応~~ だったので G の欄が半角の文字化けになっていた（`20260921-g-field-sosi`）
        // **それ以外は否定応答で WTD を打ち切る**（ACS `writeExtAttribute` の戻り値と `processWriteToDisplay` の `case 18`。`20260927-wea-sense`）。検査の順も ACS と同じ:
        // 今の位置が画面の外（EA で最後の桁を消した後など）→ 0x1005012A / タイプが 5 でない・SBCS のセッションのタイプ 5 → 0x1005012D / タイプ 5 の値が 0x81・0x80・0x00 でない → 0x1005012F。
        // ~~警告して読み飛ばす~~（色・桁区切りを WEA で受ける経路は ACS に無い——台帳の DSPFMT の項）
        if (addr >= buf.rows * buf.cols) return fail(SENSE.WRITE_PAST_END, `WEA at ${addr} past the end of the screen`);
        if (attrType !== 0x05 || !codec.decodeDbcsPair) {
          return fail(SENSE.ATTRIBUTE_TYPE, `WEA attribute type 0x${attrType.toString(16)} not supported${attrType === 0x05 ? " in an SBCS session" : ""}`);
        }
        if (attrValue !== 0x81 && attrValue !== 0x80 && attrValue !== 0x00) {
          return fail(SENSE.ATTRIBUTE_VALUE, `WEA type 5 value 0x${attrValue.toString(16)} not supported`);
        }
        if (attrValue !== 0x00) nlsSegment = attrValue === 0x81;
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
/**
 * **ACS が受け付ける WDSF の型**（`ENPTUI5250.processWSFOrder` の `switch`: 0x50〜0x55・0x58・0x59・0x5B・0x5F・0x60・0x61）。
 * これ以外（とクラスが 0xD9 でないもの）は 0x10050111 で WTD を打ち切る。当 PJ が効かせない 0x52・0x54・0x55 も、ACS が受ける型なので否定応答にはしない
 */
const WDSF_KNOWN_TYPES: ReadonlySet<number> = new Set([0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x58, 0x59, 0x5b, 0x5f, 0x60, 0x61]);

/**
 * WDSF オーダー（0x15）。**否定応答にするときはセンスを返す**（ACS `ENPTUI5250.processWSFOrder` の頭の検査。`20260927-wdsf-sense`）:
 * 長さ・クラス・型の 3 バイトより短い → 0x10050121、長さ（LL）が 4 未満 → 0x10050110、クラスが 0xD9 でない・知らない型 → 0x10050111。
 * 構造体ごとの中身の検査（選択欄・窓の本体）は写していない（台帳）
 */
function applyWdsf(
  r: ByteReader,
  buf: ScreenBuffer,
  codec: Codec,
  addr: number,
  warn: WarnFn
): { sense: number; why: string } | undefined {
  if (r.remaining < 4) return { sense: SENSE.COMMAND_EXPECTED, why: "WDSF too short" };
  const len = r.u16();
  if (len < 4) return { sense: SENSE.WDSF_LENGTH, why: `WDSF length ${len}` };
  if (r.peek() !== 0xd9) return { sense: SENSE.WDSF_CLASS, why: `WDSF class 0x${r.peek().toString(16)}` };
  if (len - 2 > r.remaining) {
    // 長さがレコードを越える（ACS は配列の外を読んで例外になり、否定応答なしに戻る——原典の読み）。従来どおり残りを捨てる
    warn(`invalid WDSF length ${len} — discarding rest of record`);
    r.skip(r.remaining);
    return undefined;
  }
  const sf = r.bytes(len - 2); // [class, type, ...body]
  if (!WDSF_KNOWN_TYPES.has(sf[1]!)) return { sense: SENSE.WDSF_CLASS, why: `unknown WDSF type 0x${sf[1]!.toString(16)}` };
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
      // ACS は受けるが当 PJ は効かせない型（0x52 窓のカーソル制限の解除・0x54 欄への書き込み・0x55 マウス・ボタン）
      warn(`unhandled WDSF type 0x${event.type.toString(16)} — ignored`);
      break;
  }
  return undefined;
}

/**
 * **SF の属性が 0x20〜0x3F か**（ACS `DS5250.isValidStartOfFieldAttribute`。製品の ACS〔`isAcsPackage`〕だけが検査し、外れたら 0x10050130）。
 * 実機の ACS のコア〔`acs-probe`〕は製品の旗を立てないので測れない——原典どおり（`20260927-wtd-sense-rest` decisions）
 */
function invalidSfAttribute(attr: number): { sense: number; why: string } | undefined {
  return attr < 0x20 || attr > 0x3f ? { sense: SENSE.FIELD_ATTRIBUTE, why: `SF attribute 0x${attr.toString(16)} is not 0x20-0x3F` } : undefined;
}

/**
 * **ACS が欄を表に入れないとき**（`FFT5250.addFieldToFFT` が null → `processWriteToDisplay` が 0x10050125 で WTD を打ち切る。`20260927-wtd-sense-rest`）。
 * 実機の ACS のコア（DSM の WTDERRFLEN0・FLDEND・JODD・CONTMID）で、長さ 0・画面の末尾を越える・長さ 5 の J・先頭の無い継続欄の中間が、どれも 0x10050125
 * （CC2 は効く・後ろは書かない）だった。規則は原典（`Field5250.checkFieldLength` / `checkFieldValidity`、`FFT5250.isValidContField`）:
 * - 長さ 0、符号付き数値・J・E・G の長さ 1（O は 1 でもよい）。J・E は 4 以上の偶数、G は偶数、自己点検欄（DBCS でないもの）は 33 以下
 * - 欄が画面の終わりを越える・表が 600 欄に達している
 * - 継続欄（FCW 0x86nn の nn が 0x80 以外）: 区間の順（先頭 → 中間… → 最終）が崩れる・nn が 01/02/03 以外、行をまたぐ、MF・自己点検・符号付き数値・右寄せと組む
 * - ワードラップ（0x8680）: MF・自己点検・符号付き数値・右寄せ・I/O・数字のみ・数値のみ・Dup と組む
 * - カーソル送り（FCW 0x88nn）の欄は、SOH で再順序付けを申告した画面では入れない（ACS `FFT5250.isValidCursorProgressField`。`20260928-resequence`。
 *   ~~当 PJ が再順序付けを持たないので見ない（`20260927-wtd-sense-rest` decisions D7）~~）
 */
function fieldAddFailure(
  buf: ScreenBuffer, start: number, length: number, ffw: number,
  dbcsType: DbcsFieldType | undefined, selfCheck: SelfCheckKind | undefined, cont: SfContinued
): string | undefined {
  const signed = (ffw & FFW.SHIFT_MASK) === FFW.SHIFT_SIGNED_NUMERIC;
  const shift = ffw & FFW.SHIFT_MASK;
  const adjust = ffw & FFW.ADJUST_MASK;
  const rightAdjustOrMf = adjust === FFW.ADJUST_MANDATORY_FILL || adjust === FFW.ADJUST_RIGHT_BLANK || adjust === FFW.ADJUST_RIGHT_ZERO;
  if (length === 0) return "field length 0";
  if (length === 1 && (signed || (dbcsType !== undefined && dbcsType !== "open"))) return "field length 1";
  if ((dbcsType === "only" || dbcsType === "either") && (length < 4 || length % 2 !== 0)) return `DBCS field length ${length}`;
  if (dbcsType === "pure" && length % 2 !== 0) return `pure DBCS field length ${length}`;
  if (dbcsType === undefined && selfCheck !== undefined && length > 33) return `self-check field length ${length}`;
  if (start + length > buf.rows * buf.cols) return `field runs past the end of the screen (start=${start}, len=${length})`;
  if (buf.fieldCount() >= 600) return "600 fields already";
  if (cont.segment !== undefined) {
    if (rightAdjustOrMf || selfCheck !== undefined || signed) return "continued field with MF / self-check / signed numeric / right adjust";
    if (Math.floor(start / buf.cols) < Math.floor((start + length - 1) / buf.cols)) return "continued field spans rows";
    const prev = buf.continuedSegment;
    const n = cont.segment;
    const ok = (prev === undefined && n === 0x01) || ((prev === "first" || prev === "middle") && (n === 0x02 || n === 0x03));
    if (!ok) return `continued field segment out of order (${prev ?? "none"} → 0x${n.toString(16)})`;
  } else if (cont.wrap) {
    if (rightAdjustOrMf || selfCheck !== undefined || signed || shift === FFW.SHIFT_IO || shift === FFW.SHIFT_NUMERIC_ONLY || shift === FFW.SHIFT_DIGITS_ONLY || (ffw & FFW.DUP_ENABLE) !== 0) {
      return "word-wrap field with MF / self-check / signed numeric / right adjust / I-O / numeric only / digits only / Dup";
    }
  }
  return undefined;
}

/** SF の FCW 0x86nn（継続・ワードラップ）の生の値（`fieldAddFailure` が読む） */
interface SfContinued {
  /** nn（0x80 以外）。0x01/0x03/0x02 以外も入る——ACS は不正な区間として断る */
  segment?: number;
  /** nn が 0x80（ワードラップ） */
  wrap?: boolean;
}

/** SF オーダー: [FFW(2)] [FCW(2)*] attr(1) length(2)。FFW 省略時は出力専用（フィールド登録なし）。否定応答にするときはセンスを返す */
function applySf(r: ByteReader, buf: ScreenBuffer, addr: number): number | { sense: number; why: string } {
  const first = r.peek();
  // **0x40 未満なら FFW 無し**（ACS は `>= 64` で FFW と見る。0x20 未満の属性も属性として読み、製品の ACS は属性の検査で断る）
  if (first < 0x40) {
    // FFW なし = 出力専用フィールド定義: 属性と長さのみ（フォーマットテーブルに載せない）
    const attr = r.u8();
    r.u16(); // length（表示専用のため未使用）
    const bad = invalidSfAttribute(attr);
    if (bad) return bad;
    if (addr >= 0) buf.setAttr(addr, attr);
    return addr + 1;
  }
  // **0x40 以上なら FFW**（ACS `processWriteToDisplay` の 0x1D は `>= 64` だけを見る。実機の ACS のコア〔DSM の WTDERRFFWC0〕は FFW 0xC000 の欄を入力欄として受けた。
  // `20260927-wtd-sense-rest`。~~上位 2 ビットが 01 でなければ例外~~ でレコードごと失っていた）
  const ffw = r.u16();
  // FCW（上位 2 ビットが 10）: DBCS 種別等を解釈（SC30-3533 / tn5250 の ideographic FCW）
  let dbcsType: DbcsFieldType | undefined;
  let selfCheck: SelfCheckKind | undefined;
  let continued: ContinuedPart | undefined;
  let cursorProgression: number | undefined;
  let transparent = false;
  let nextResequence: number | undefined;
  const cont: SfContinued = {};
  // FCW は 0x80 以上（ACS も `>= 128` で続ける。属性は 0x20〜0x3F なので取り違えない）
  while (r.remaining >= 2 && r.peek() >= 0x80) {
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
    // 実機（IBM i 7.3・`TESTLIB/MSKTST`）で採った生バイト:
    //   `1d 43 00 86 01 24 00 02` … (3,23) len=2 先頭
    //   `1d 43 00 86 03 24 00 02` … (3,26) len=2 中間
    //   `1d 43 00 86 02 24 00 02` … (3,29) len=2 最終
    else if (fcw === 0x8601) continued = "first";
    else if (fcw === 0x8603) continued = "middle";
    else if (fcw === 0x8602) continued = "last";
    if ((fcw & 0xff00) === 0x8600) {
      if ((fcw & 0xff) === 0x80) cont.wrap = true;
      else cont.segment = fcw & 0xff;
    }
    // **カーソル送り（CURSOR_PROGRESSION_ENTRY_FIELD = 0x88nn）**。DDS の `FLDCSRPRG`。
    // 下位バイトが**送り先の欄番号**（1 始まり・画面順）。ホストが入力の順序をアプリの都合で
    // 決める仕組みで、無視すると「Tab で飛ぶ先が実機と違う」ことになる。
    // 参照実装 2 つとも下位バイトをそのまま持つ（GNU tn5250 `session.c` の
    // `nextfieldprogressionid`、tn5250j `ScreenField.setFCWs` の `cursorProg = fcw2`）。
    //
    // 実機（IBM i 7.3・`TESTLIB/KEYDSPF` の `FLDCSRPRG(IN3)`）で採った値: 欄#1 に `0x8803`。
    else if ((fcw & 0xff00) === 0x8800) cursorProgression = fcw & 0x00ff;
    // （上の 0x86 の `if` は単独で、この連なりは 0x82 からの else-if の続き。上位バイトは互いに排他なので取りこぼさない）
    // **透過の欄（0x84xx）**。ACS `Field5250` は FCW の上位バイトで振り分け、0x84 なら下位バイトを問わず透過（`transparentField`）。
    // 送るときに加工しない（`read-response.ts` の `transparentBytes`）
    else if ((fcw & 0xff00) === 0x8400) transparent = true;
    // **再順序付け（0x80nn）**: 次の欄の番号（ACS `Field5250.nextResequence`）。READ の応答の並びに効く（`ScreenBuffer.readMdtFields`）
    else if ((fcw & 0xff00) === 0x8000) nextResequence = fcw & 0xff;
  }
  const attr = r.u8();
  const length = r.u16();
  const bad = invalidSfAttribute(attr);
  if (bad) return bad;
  const fieldStart = addr + 1;
  // **ACS `FFT5250.checkNewField`**: 表の順に見て、同じ位置の欄があれば FFW だけを書き換え（長さ・FCW は前のまま）、
  // その位置より後ろに始まる欄（継続欄の中間・最終を除く）が先に見つかれば、新しい欄は入れない——どちらも検査せず否定応答もしない（属性は置く）。
  // 後者は昇順でない SF（台帳の節目 9 の「昇順でない SF は ACS が欄に入れない」）
  const existing = buf.checkNewField(fieldStart);
  if (existing === undefined) {
    const failure =
      cursorProgression !== undefined && buf.resequenceFirst !== 0
        ? "cursor progression in a resequenced format table"
        : fieldAddFailure(buf, fieldStart, length, ffw, dbcsType, selfCheck, cont);
    if (failure !== undefined) return { sense: SENSE.FIELD_ADD, why: failure };
  }
  // 番地 -1（SBA 1,0 の後）の属性は桁を占めず 1 行 1 桁から効く（ACS `setAttributeToPlanes` の `row1col0*`）
  if (addr >= 0) buf.setAttr(addr, attr);
  else buf.row1col0Attr = attr;
  if (existing !== undefined) {
    if (existing.startAddr === fieldStart) buf.updateFieldFfw(existing, ffw, attr);
    return fieldStart;
  }
  buf.addField(fieldStart, length, ffw, attr, dbcsType, continued, cursorProgression, selfCheck, transparent, nextResequence);
  // 継続欄の区間の順を憶える（ACS `FFT5250.contFieldSegment`。最終の区間で戻す。**欄の表を消しても戻さない**——ACS も `clearFFT` で触らない）
  if (continued !== undefined) buf.continuedSegment = continued === "last" ? undefined : continued;
  return fieldStart;
}

/** WTD の中で文字の並びを区切るオーダー（ACS `processWriteToDisplay` の終わりの文字列の読み取りが止まるバイト。ESC は別に見る） */
const WTD_ORDERS: ReadonlySet<number> = new Set([
  ORDER.SOH, ORDER.RA, ORDER.EA, ORDER.WEA, ORDER.TD, ORDER.SBA, ORDER.IC, ORDER.MC, ORDER.WDSF, ORDER.SF
]);

/** 否定応答のセンス・コード（ACS `DS5250` の `setSenseCode` / `sense_code` の値） */
export const SENSE = {
  COMMAND_EXPECTED: 0x10050121,
  /** WTD のオーダーの行・桁が画面の外（SBA・IC・MC・RA・EA） */
  ORDER_ADDRESS: 0x10050122,
  /** RA・EA の行き先が今の位置より前 */
  ORDER_BACKWARD: 0x10050123,
  /** SOH の長さが 0 か 8 以上 */
  SOH_LENGTH: 0x1005012b,
  /** EA の長さが 2〜5 でない */
  EA_LENGTH: 0x1005012d,
  /** 属性タイプが扱えない（ACS `SC_Invalid_AttributeType`。EA のタイプ・WEA のタイプ。`EA_LENGTH` と同じ値——ACS は EA の長さの誤りにも同じセンスを使う） */
  ATTRIBUTE_TYPE: 0x1005012d,
  /** 属性の値が扱えない（ACS `SC_Invalid_Attribute`。WEA タイプ 5 の値） */
  ATTRIBUTE_VALUE: 0x1005012f,
  /** 書く位置が画面の外（ACS `SC_WritePastDisplayEnd`。WEA） */
  WRITE_PAST_END: 0x1005012a,
  ROLL_PARAM: 0x1005012c,
  CLEAR_UNIT_ALTERNATE_PARAM: 0x10030101,
  /** 知らないオペコード（ACS `processPassthru` の `default`。値は CLEAR UNIT ALTERNATE の引数の誤りと同じ） */
  UNKNOWN_OPCODE: 0x10030101,
  WSF_D972_FLAG: 0x10050112,
  /** WDSF の長さ（LL）が 4 未満（ACS `ENPTUI5250.processWSFOrder`） */
  WDSF_LENGTH: 0x10050110,
  /** WDSF のクラスが 0xD9 でない・知らない型（同上） */
  WDSF_CLASS: 0x10050111,
  /** 欄を表に入れられない（ACS `addFieldToFFT` が null。`fieldAddFailure`） */
  FIELD_ADD: 0x10050125,
  /** SF の属性が 0x20〜0x3F でない（製品の ACS の `isValidStartOfFieldAttribute`） */
  FIELD_ATTRIBUTE: 0x10050130
} as const;

/**
 * WRITE STRUCTURED FIELD（ホスト → クライアント）の**最初の SF を 1 つだけ**読む（ACS `DS5250.processWSF`）。5250 QUERY（class 0xD9 /
 * type 0x70。フラグが 0 のとき）とクラス D9・種類 72（長さ 6 のとき）の応答を返す（送るのは呼び出し側）。その他の SF は読み飛ばす
 */
function applyStructuredField(r: ByteReader): { reply?: WsfReply; sense?: number } {
  // ACS `processWSF` は SF の頭（長さ 2・class・type）を見るだけで、進めるのは呼び出し側（長さ `n12` の分）
  const len = (r.peekAt(0) << 8) | r.peekAt(1);
  const sf = r.peekUpTo(len);
  // 長さの分だけ進める（足りなければレコードの終わりまで。0・1 なら長さの 2 バイトが次の「コマンド」として読まれ、0x10050121 になる＝ACS と同じ）
  r.skip(Math.min(len, r.remaining));
  if (sf[2] !== 0xd9) return {};
  if (sf[3] === 0x70) return sf[4] === 0 ? { reply: { kind: "query" } } : {}; // ACS はフラグが 0 のときだけ応答する
  if (sf[3] === 0x72 && len === 6) {
    // ACS は長さが 6 のときだけ見る（`n4 != 6` なら何もしない）
    const flags = sf[4] ?? 0;
    if ((flags & 0x80) !== 0) return { sense: SENSE.WSF_D972_FLAG };
    return { reply: { kind: "d972", flags, next: sf[5] ?? 0 } };
  }
  return {};
}

/**
 * 0x22 のメッセージを重ねる位置（ACS `DS5250.processWriteErrorCode` の書き始め・終わりの計算。`20260926-window-error-code` research F1）。
 * 書き始め `s`＝(メッセージ行 − 1)×桁数＋開始桁 − 1。`s`＋桁数が画面の大きさを超えれば最下行の行頭へ戻す（終わりは戻さない）。
 * 空にする範囲は [s, 行頭＋終了桁 − 1)、本文は `s` から `consumed` 桁（書いた桁。IC・SBA・MC は数えない）——重ねるのはその和（行末まで）
 */
function windowErrorArea(buf: ScreenBuffer, win: { start: number; end: number }, consumed: number): { row: number; col: number; width: number } | undefined {
  const cols = buf.cols;
  const size = buf.rows * cols;
  const rowStart = (buf.messageLineRow - 1) * cols;
  let s = rowStart + win.start - 1;
  const e = rowStart + win.end - 1;
  if (s + cols > size) s = size - cols;
  // 行末で止める（ACS は次の行へ続けて書くが、UI は 1 行の重ね。終了桁が桁数を超える実例は無く、ACS の見え方は未確認）
  const width = Math.min(Math.max(e, s + consumed) - s, cols - (s % cols));
  if (width <= 0 || s < 0) return undefined;
  return { row: Math.floor(s / cols) + 1, col: (s % cols) + 1, width };
}

/**
 * WRITE ERROR CODE: エラー行のメッセージを systemMessage として保持する（セルには書かず、UI が重ねて出す）。
 *
 * **WRITE ERROR CODE TO WINDOW（0x22）は `win`（開始桁・終了桁）付きで来る**。ACS（`DS5250.processWriteErrorCode`。
 * `20260926-window-error-code` research F1〜F3。実機の ACS のコアで測定）と同じく:
 * - 書き始め＝メッセージ行（SOH の申告。無ければ最下行）の開始桁。ただし**書き始め＋桁数が画面の大きさを超えれば最下行の行頭へ戻す**
 *   （メッセージ行が最下行なら開始桁は捨てられ、桁 1 から書く——実測どおり）
 * - 本文は**終了桁 − 開始桁 ＋ 1 バイト**まで（属性・SO/SI・DBCS の 2 バイトも 1 バイトずつ数える。先頭が IC なら ＋3）。残りは次の ESC まで読み飛ばす
 * - 重ねる範囲は「空にする桁（書き始め〜終了桁の手前）」と「本文を書いた桁」の和。位置は `systemMessageArea` に持つ
 *
 * **WRITE ERROR CODE（0x21）はメッセージ行（SOH の申告。無ければ最下行）の 1 行全体に重ねる**（ACS は桁 1 に属性・桁 2 から本文。
 * `20260926-wec-msgline-row` research F2）。本文が 1 行より長いと ACS は続きを次の行へ上書きして Reset でも戻さないが、
 * 情報を捨てるので合わせない——当 PJ は 1 行で切る（同 decisions D2）。
 *
 * **SO/SI で挟まれた DBCS（漢字）は 2 バイト 1 組で読む。** 1 バイトずつ `decodeByte` に
 * 通すと、DBCS のペアがそれぞれ無関係な SBCS 文字に化ける（メッセージが日本語のとき、
 * 画面下部のエラー行が文字化けする不具合として利用者から報告された）。
 */
function applyWriteErrorCode(r: ByteReader, buf: ScreenBuffer, codec: Codec, win?: { start: number; end: number }): void {
  let msg = "";
  let dbcsMode = false;
  let limit = Infinity;
  if (win) {
    limit = win.end - win.start + 1;
    if (r.remaining > 0 && r.peek() === ORDER.IC) limit += 3;
  }
  const startRemaining = r.remaining;
  const used = (): number => startRemaining - r.remaining;
  // 書いた桁の数（重ねる幅に使う）。IC・SBA・MC はセルを書かないので数えない（独立点検の指摘。読んだバイト数で幅を出すと 3 桁広くなる）。
  // 上限の境界に IC・SBA・MC や DBCS の組がまたがったとき、当 PJ は組を読み切る。ACS の `processWriteToDisplay` が添字の終わりで
  // 組をどう扱うかは**未確認**（実測は SBCS の本文だけ。`20260926-window-error-code` research F3）
  let orderBytes = 0;
  while (r.remaining > 0 && r.peek() !== ESC && used() < limit) {
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
      if (r.remaining === 0) break;
      const b2 = r.u8();
      msg += String.fromCharCode(codec.decodeDbcsPair(b, b2));
      continue;
    }
    if (b >= 0x40) msg += String.fromCharCode(codec.decodeByte(b));
    else if (b === ORDER.IC || b === ORDER.SBA || b === ORDER.MC) {
      r.skip(2);
      orderBytes += 3;
    }
    // その他の制御は読み飛ばす
  }
  // 0x22 は上限を超えた本文を次の ESC まで読み飛ばす（ACS は `bl` のとき ESC まで添字を進める。research F1）
  const consumed = used() - orderBytes;
  if (win) while (r.remaining > 0 && r.peek() !== ESC) r.u8();
  // 桁の片方が欠けた・不正な 0x22（位置が出せない）は 0x21 と同じくメッセージ行の 1 行全体にする（ACS の見え方は未確認。`20260926-wec-msgline-row` D4）。
  // 0 バイトの 0x22 はここへ来ない（入口で否定応答。`20260927-short-command-sense`）
  buf.systemMessageArea = (win ? windowErrorArea(buf, win, consumed) : undefined) ?? { row: buf.messageLineRow, col: 1, width: buf.cols };
  // **本文が空白だけでも載せて番号を振る**——ACS `DS5250.processWriteErrorCode` は本文を読む前に
  // 無条件で `setErrorMode(true)` とする（独立点検の指摘。空白だけの WEC が実際に届くかは未確認）。
  // 空なら画面に出る文言は無いが、エラー状態には入る（キーボードは Reset・矢印等まで拒否）
  buf.systemMessage = msg.trim();
  // 届くたびに番号を振る（同じ文言でも新しいエラー。UI はこれでエラー状態に入り直す）
  buf.systemMessageSeq = nextSystemMessageSeq();
}
