/**
 * 3270 データストリームの定数。
 *
 * **すべて実測で確定させた**（推測で書いていない）。手法は `s3270` の `-trace` が
 * 受信ストリームを意味へ復号して残す性質を利用したもので、既知のバイトを流して
 * 復号結果を読んだ。採取したトレースは `.aidev/works/20260815-tn3270-emulator/artifacts/`
 * に置いてある（`attr.trc` / `order.trc` / `wcc3.trc` / `negotiation-hercules.trc`）。
 */

/** ホスト → 端末のコマンド（レコードの先頭 1 バイト） */
export const CMD3270 = {
  /** 消さずに書く */
  WRITE: 0xf1,
  /** 消して書く。**標準サイズ（24x80）**で（RFC 1576 / spec D5） */
  ERASE_WRITE: 0xf5,
  /** 消して書く。**代替サイズ（モデル依存）**で（spec D5） */
  ERASE_WRITE_ALTERNATE: 0x7e,
  /** バッファ全体を返させる */
  READ_BUFFER: 0xf2,
  /** 変更された欄を返させる */
  READ_MODIFIED: 0xf6,
  /** 変更された欄を返させる（AID によらず全部） */
  READ_MODIFIED_ALL: 0x6e,
  /** 非保護欄を消し MDT を落とす */
  ERASE_ALL_UNPROTECTED: 0x6f,
  /** 構造化フィールド */
  WRITE_STRUCTURED_FIELD: 0xf3
} as const;

/**
 * オーダー（コマンドの後ろに並ぶ）。
 *
 * 実測（`order.trc`）: 流したバイトに対する `s3270` の復号は次のとおりだった。
 * `11`→SetBufferAddress / `1D`→StartField / `13`→InsertCursor / `29`→StartFieldExtended /
 * `28`→SetAttribute / `3C`→RepeatToAddress / `12`→EraseUnprotectedAll /
 * `08`→GraphicEscape / `05`→ProgramTab / `2C`→ModifyField
 */
export const ORDER = {
  /** Program Tab: 次の非保護欄の先頭へ */
  PT: 0x05,
  /** Graphic Escape: 次の 1 文字を拡張文字集合として扱う */
  GE: 0x08,
  /** Set Buffer Address（アドレス 2 バイトが続く） */
  SBA: 0x11,
  /** Erase Unprotected to Address（アドレス 2 バイトが続く） */
  EUA: 0x12,
  /** Insert Cursor: カーソルを現在アドレスへ */
  IC: 0x13,
  /** Start Field（基本属性 1 バイトが続く）。**属性はバッファの 1 桁を占める** */
  SF: 0x1d,
  /** Set Attribute（type, value の 2 バイトが続く） */
  SA: 0x28,
  /** Start Field Extended（対の個数 1 バイト＋ (type,value) × n が続く） */
  SFE: 0x29,
  /** Modify Field（対の個数 1 バイト＋ (type,value) × n が続く） */
  MF: 0x2c,
  /** Repeat to Address（アドレス 2 バイト＋繰り返す文字 1 バイト） */
  RA: 0x3c
} as const;

/**
 * WCC（Write Control Character）のビット。**実測**（`wcc3.trc`）:
 *
 * | 値 | s3270 の復号 |
 * |---|---|
 * | 0x01 | resetMDT |
 * | 0x02 | restore |
 * | 0x04 | alarm |
 * | 0x40 | reset |
 * | 0x08 / 0x10 / 0x20 / 0x80 | （表示端末では無視） |
 *
 * 0x08/0x10/0x20 はプリンタ関連、0x80 はバイトを EBCDIC の図形文字にするための埋め。
 */
export const WCC = {
  RESET_MDT: 0x01,
  /** キーボードのロックを解除する。**セッションの状態機械はこれで待機へ戻る** */
  RESTORE: 0x02,
  ALARM: 0x04,
  RESET: 0x40
} as const;

/**
 * 基本フィールド属性バイトのビット。**実測**（`attr.trc`。単一ビットを流して復号を読んだ）:
 *
 * | 値 | s3270 の復号 |
 * |---|---|
 * | 0x01 | modified（MDT） |
 * | 0x04 | detectable |
 * | 0x08 | intensified |
 * | 0x0C | nondisplay |
 * | 0x10 | numeric |
 * | 0x20 | protected |
 * | 0x02 / 0x40 / 0x80 | default（**無視される**） |
 * | 0xF0（protected+numeric） | protected,**skip** |
 *
 * **保護と数字が同時に立つと「自動スキップ」**になる（カーソルが飛ばす欄）。
 * 0x40 / 0x80 はバイトを EBCDIC の図形文字にするための埋めで、意味を持たない——
 * だから `0xE0` と `0x20` は同じ「保護」を意味する。
 */
export const ATTR = {
  MDT: 0x01,
  /** 表示種別の 2 ビット。下の DISPLAY_* と比較する */
  DISPLAY_MASK: 0x0c,
  NUMERIC: 0x10,
  PROTECTED: 0x20
} as const;

export const DISPLAY = {
  NORMAL: 0x00,
  DETECTABLE: 0x04,
  INTENSIFIED: 0x08,
  NONDISPLAY: 0x0c
} as const;

/**
 * 拡張属性の type コード（SFE / SA / MF の対で使う）。
 *
 * 実測（`order.trc`）: `C0` の対は `3270(protected,intensified)` と復号され基本属性そのもの、
 * `42` は `foreground(red)`、`41` は `highlighting(blink)` と復号された。
 */
export const XA = {
  /** 基本 3270 属性（SFE の中で SF と同じ属性バイトを運ぶ） */
  BASIC: 0xc0,
  HIGHLIGHT: 0x41,
  FOREGROUND: 0x42,
  CHARSET: 0x43,
  BACKGROUND: 0x45
} as const;

/**
 * 拡張ハイライト（XA.HIGHLIGHT の値）。**実測**（`color2.trc`。F0〜F4 を流して復号を読んだ）:
 * `F0`→normal / `F1`→blink / `F2`→reverse / `F3`→**unknown（未定義）** / `F4`→underscore。
 *
 * `0x00` は「指定なし（既定に従う）」で、`F0`（normal）とは別物。
 */
export const HILITE = {
  DEFAULT: 0x00,
  NORMAL: 0xf0,
  BLINK: 0xf1,
  REVERSE: 0xf2,
  UNDERSCORE: 0xf4
} as const;

/**
 * 前景色（XA.FOREGROUND の値）。**実測**（`color2.trc`。F0〜F7 を流して復号を読んだ）:
 *
 * | 値 | s3270 の呼び名 |
 * |---|---|
 * | F0 | neutralBlack |
 * | F1 | blue |
 * | F2 | red |
 * | F3 | pink |
 * | F4 | green |
 * | F5 | turquoise |
 * | F6 | yellow |
 * | F7 | neutralWhite |
 *
 * **`F0` は「既定」ではなく黒**。指定なしは `0x00` で、
 * 「フィールドの強度から決める」を意味する（3279 の既定色は緑）。
 */
export const COLOR = {
  DEFAULT: 0x00,
  NEUTRAL_BLACK: 0xf0,
  BLUE: 0xf1,
  RED: 0xf2,
  PINK: 0xf3,
  GREEN: 0xf4,
  TURQUOISE: 0xf5,
  YELLOW: 0xf6,
  NEUTRAL_WHITE: 0xf7
} as const;

/** DBCS の切り替え（バッファ上でそれぞれ 1 桁を占める。research F5 実測） */
export const SO = 0x0e;
export const SI = 0x0f;

/** 空の桁（Erase/Write 後の初期値） */
export const NUL = 0x00;
