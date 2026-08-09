/**
 * 5250 データストリーム定数（SC30-3533-04 / RFC 1205。名前は文書の用語に合わせる）。
 * SBCS サブセット（subtask 01 scope）。WSF/QUERY・DBCS 関連は subtask 04 で追加。
 */

/** GDS レコード種別（RFC 1205） */
export const GDS_TYPE = 0x12a0;

/** レコードヘッダの opcode（RFC 1205） */
export const OPCODE = {
  NOOP: 0x00,
  INVITE: 0x01,
  OUTPUT_ONLY: 0x02,
  PUT_GET: 0x03,
  SAVE_SCREEN: 0x04,
  RESTORE_SCREEN: 0x05,
  READ_IMMEDIATE: 0x06,
  READ_SCREEN: 0x08,
  CANCEL_INVITE: 0x0a,
  MESSAGE_LIGHT_ON: 0x0b,
  MESSAGE_LIGHT_OFF: 0x0c
} as const;

/** ヘッダフラグ（1 バイト目）ビット（RFC 1205 の Flags。値は tn5250 record.h と一致） */
export const HDR_FLAG = {
  ERR: 0x80, // データストリーム出力エラー
  ATN: 0x40, // Attention キー
  SRQ: 0x04, // System Request キー
  TRQ: 0x02, // Test Request キー
  HLP: 0x01 // Help in Error State
} as const;

/** コマンド（ESC 0x04 に続く 1 バイト） */
export const ESC = 0x04;
export const COMMAND = {
  WRITE_TO_DISPLAY: 0x11,
  CLEAR_UNIT: 0x40,
  CLEAR_UNIT_ALTERNATE: 0x20,
  CLEAR_FORMAT_TABLE: 0x50,
  READ_INPUT_FIELDS: 0x42,
  READ_MDT_FIELDS: 0x52,
  READ_MDT_FIELDS_ALT: 0x82,
  READ_SCREEN: 0x62,
  /**
   * READ SCREEN EXTENDED。READ SCREEN（0x62）の拡張版で、応答形式は同じ。
   * 拡張 5250 を Query Reply で申告している端末には、ホストは 0x62 ではなく
   * こちらを送ってくる（日本語実機の PDM F1 ヘルプで確認）。
   */
  READ_SCREEN_EXTENDED: 0x64,
  WRITE_ERROR_CODE: 0x21,
  /**
   * WRITE ERROR CODE TO WINDOW。**窓が開いている間のエラーはこちらで来る**（0x21 ではない）。
   * 形式は 0x21 の前に「メッセージ行の開始桁・終了桁」の 2 バイトが付くだけ。
   * 実機の DDS 窓（WINDOW(8 25 8 30)）で無効なファンクション・キーを押すと
   * `04 22 1a 38 22 0e…0f 04 52 00 00` が来た（0x1a=26・0x38=56＝窓内のメッセージ行）。
   * 未処理だと同一レコード後半の READ MDT FIELDS ごと捨ててしまい、キーボードが
   * ロックしたまま応答なしになる。
   */
  WRITE_ERROR_CODE_WINDOW: 0x22,
  SAVE_SCREEN: 0x02,
  RESTORE_SCREEN: 0x12,
  /**
   * SAVE PARTIAL SCREEN。**QSH（Qshell）が起動直後に送ってくる**（実機で実測。
   * `04 03 00 00 00 00 00` ＝ ESC＋コマンド＋**パラメータ 5 バイト**）。
   *
   * SAVE SCREEN（0x02）と同じく**端末に画面を送り返させる要求**で、opcode は `PUT/GET(0x03)`
   * ——返さない限りホストは次を送ってこない。未処理のときは
   * 「unknown command 0x3 — discarding rest of record」で捨てており、
   * **QSH が「待機中・ホストから応答がない」で固まる原因**だった。
   */
  SAVE_PARTIAL_SCREEN: 0x03,
  /** RESTORE PARTIAL SCREEN。保管しておいた内容をホストが返してくる側（0x03 の対） */
  RESTORE_PARTIAL_SCREEN: 0x13,
  ROLL: 0x23,
  /**
   * 印刷用の画面読み取り（4 種）と即時読み取り（2 種）。**いずれもパラメータを持たない**
   * ——原典（tn5250 `session.c`）がバイトを読まずに無視していることで確認した
   * （`20260730-tn5250-cross-check` research F5）。
   * 当方も応答は実装していないが、**レコードの残りを捨てない**ために受理だけする。
   */
  READ_SCREEN_TO_PRINT: 0x66,
  READ_SCREEN_TO_PRINT_EXTENDED: 0x68,
  READ_SCREEN_TO_PRINT_GRID: 0x6a,
  READ_SCREEN_TO_PRINT_EXT_GRID: 0x6c,
  READ_IMMEDIATE: 0x72,
  READ_IMMEDIATE_ALT: 0x83,
  WRITE_STRUCTURED_FIELD: 0xf3
} as const;

/** WTD オーダー */
export const ORDER = {
  SOH: 0x01, // Start of Header
  RA: 0x02, // Repeat to Address
  EA: 0x03, // Erase to Address
  TD: 0x10, // Transparent Data
  SBA: 0x11, // Set Buffer Address
  WEA: 0x12, // Write Extended Attribute
  IC: 0x13, // Insert Cursor
  MC: 0x14, // Move Cursor
  WDSF: 0x15, // Write to Display Structured Field
  /**
   * **正体未確認。SC30-3533 / tn5250（lib5250/codes5250.h）のどちらにも定義が無い
   * （0x15〜0x1D の間の空き番地）。実機の標準システム画面「スプール・ファイルの表示」
   * （DSPSPLF 系）のトレースで 1 回だけ観測した——桁末尾で打ち切られた DBCS 見出し
   * フィールドの直後・サブファイル明細データの直前という、フィールド境界のような位置。
   * 画面下部に「データ行で印刷桁の調整が行われた。」という同システムのメッセージが
   * 出ており、印刷用データを画面幅に収めるために桁を詰めた境界を示す印だと見られる。**
   * 表示は "*" 1 文字（パラメータ無し、1 桁占有）。ACS の実際の表示（"仕*"）と
   * 突き合わせて確定した——当初は 0 引数の読み飛ばし（no-op）として実装したが、
   * その版では "*" が 1 文字欠けたまま出ていた（利用者のスクリーンショット比較で発覚）。
   * 実際の 5250 プロトコル上の正式名称・意味までは未確認（要再確認）。
   */
  UNKNOWN_1C: 0x1c,
  SF: 0x1d // Start of Field
} as const;

/**
 * **オーダーではない。ホストが「このコードページで表せない」と言うために置く印。**
 *
 * PUB400（英語システム）へ **CCSID 5026**（＝コードページ 290・カタカナ）で繋ぎ、
 * メインメニューや PDM で F1（ヘルプ）を押すと、ヘルプ本文の**英小文字がすべて
 * このバイトに置き換わって届く**（1076 バイトの記録に 531 個。実測）。
 * 同じ画面を CCSID 37 / 5035 で採ると 0 個で、本文もそのまま読める
 * ——つまり 290 に英小文字の割り当てが無いことをホストが埋めている。
 *
 * **オーダーとして扱ってはならない。** 扱うと解析がそこで崩れ、復帰の途中で
 * SBA の行桁パラメータ（`11 04 05`）の `0x04` を ESC と読み違え、
 * **レコード末尾の READ MDT FIELDS ごと捨てる**。読み取り要求が失われるので
 * 鍵盤が開かず、画面は途中まで出たまま「ホストからの応答待ち」で固まる（利用者報告）。
 */
export const UNMAPPABLE = 0x1f;

/** コマンドとして既知のバイトか（未知オーダーからの復帰で ESC を見極めるのに使う） */
const COMMAND_BYTES: ReadonlySet<number> = new Set(Object.values(COMMAND));
export function isKnownCommand(b: number): boolean {
  return COMMAND_BYTES.has(b);
}

/** AID コード（キーボード → ホスト） */
export const AID = {
  ENTER: 0xf1,
  F1: 0x31,
  F2: 0x32,
  F3: 0x33,
  F4: 0x34,
  F5: 0x35,
  F6: 0x36,
  F7: 0x37,
  F8: 0x38,
  F9: 0x39,
  F10: 0x3a,
  F11: 0x3b,
  F12: 0x3c,
  F13: 0xb1,
  F14: 0xb2,
  F15: 0xb3,
  F16: 0xb4,
  F17: 0xb5,
  F18: 0xb6,
  F19: 0xb7,
  F20: 0xb8,
  F21: 0xb9,
  F22: 0xba,
  F23: 0xbb,
  F24: 0xbc,
  CLEAR: 0xbd,
  HELP: 0xf3,
  PAGE_UP: 0xf4, // Roll Down
  PAGE_DOWN: 0xf5, // Roll Up
  PRINT: 0xf6,
  RECORD_BACKSPACE: 0xf8
} as const;

/** 属性バイトの範囲（0x20–0x3F。画面上 1 桁を占有する） */
export function isAttribute(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x3f;
}

/** FFW（Field Format Word）ビット定義。上位バイトの 01xx xxxx が FFW 識別 */
export const FFW = {
  ID_MASK: 0xc000,
  ID_VALUE: 0x4000,
  BYPASS: 0x2000,
  DUP_ENABLE: 0x1000,
  MDT: 0x0800,
  SHIFT_MASK: 0x0700,
  SHIFT_ALPHA: 0x0000,
  SHIFT_ALPHA_ONLY: 0x0100,
  SHIFT_NUMERIC_SHIFT: 0x0200,
  SHIFT_NUMERIC_ONLY: 0x0300,
  SHIFT_KATAKANA: 0x0400,
  SHIFT_DIGITS_ONLY: 0x0500,
  SHIFT_IO: 0x0600,
  SHIFT_SIGNED_NUMERIC: 0x0700,
  AUTO_ENTER: 0x0080,
  FIELD_EXIT_REQUIRED: 0x0040,
  MONOCASE: 0x0020,
  MANDATORY_ENTER: 0x0008,
  ADJUST_MASK: 0x0007,
  ADJUST_RIGHT_ZERO: 0x0005,
  ADJUST_RIGHT_BLANK: 0x0006,
  ADJUST_MANDATORY_FILL: 0x0007
} as const;
