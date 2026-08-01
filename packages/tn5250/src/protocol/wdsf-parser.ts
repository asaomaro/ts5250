import type { GuiSelectionKind } from "../screen/types.js";
import { ByteReader } from "./bytes.js";

/**
 * WDSF（Write to Display Structured Field, WTD オーダー 0x15）GUI 構造体パーサ。
 * ワイヤ仕様は SC30-3533 と GNU tn5250（define_selection_field / create_window_structured_field /
 * define_scrollbar）を挙動・バイト仕様の参考として実装（GPL コードは移植せず）。
 *
 * 位置はデータストリームの現在の書き込みアドレス（applyWtd 側で 1 始まり row/col に変換して付与）。
 * ここでは class 0xD9 の type ごとに構造をモデル化し、id/row/col は buffer が採番・付与する。
 */

/** WDSF type コード（tn5250 codes5250.h） */
export const WDSF_TYPE = {
  DEFINE_SELECTION_FIELD: 0x50,
  CREATE_WINDOW: 0x51,
  UNREST_WIN_CURS_MOVE: 0x52,
  DEFINE_SCROLL_BAR_FIELD: 0x53,
  WRITE_DATA: 0x54,
  REM_GUI_SEL_FIELD: 0x58,
  REM_GUI_WINDOW: 0x59,
  REM_GUI_SCROLL_BAR_FIELD: 0x5b,
  REM_ALL_GUI_CONSTRUCTS: 0x5f,
  /** DDS の GRDATR/GRDLIN（グリッド罫線）がコンパイルされる先 */
  DRAW_ERASE_GRID_LINES: 0x60,
  CLEAR_GRID_LINE_BUFFER: 0x61
} as const;

/**
 * グリッド線の線種。Wireshark `packet-tn5250.c` の `vals_tn5250_deg_lines` と、
 * IBM の DDS リファレンス（`GRDATR` の Table 15「Valid line types」）が**完全に一致**する:
 * SLD=X'00' / THK=X'01' / DBL=X'02' / DOT=X'03' / DSH=X'08' / THKDSH=X'09' / DBLDSH=X'0A' / NONE=X'FF'。
 * 0xFF は「端末の既定」＝こちらの既定（実線）に倒す。
 */
export const GRID_LINE_STYLE = {
  SOLID: 0x00,
  THICK_SOLID: 0x01,
  DOUBLE: 0x02,
  DOTTED: 0x03,
  DASHED: 0x08,
  THICK_DASHED: 0x09,
  DOUBLE_DASHED: 0x0a,
  DISPLAY_DEFAULT: 0xff
} as const;

/**
 * グリッド線のマイナー構造の種別（同上 `UPPER_HORIZONTAL_LINE` 〜
 * `HORIZONTALLY_AND_VERTICALLY_RULED_BOX`）。この 8 種の間だけ構造が続く。
 */
/**
 * **グリッド線の色は 5250 の属性バイトではない。**
 *
 * IBM の DDS リファレンス（`GRDATR` の Table 14「Valid color values」）が定める
 * 専用のコード。表示属性バイト（0x20–0x3F）とは別物なので、`decodeAttribute` に
 * 渡してはいけない（渡すと緑一色になる）。X'FF' は「表示装置の既定」。
 */
export const GRID_COLOR: Readonly<Record<number, string>> = {
  0x01: "blue",
  0x02: "green",
  0x03: "turquoise",
  0x04: "red",
  0x05: "pink",
  0x06: "yellow",
  0x07: "white",
  0x08: "white",
  0x09: "blue",
  0x0a: "green",
  0x0b: "turquoise",
  0x0c: "red",
  0x0d: "pink",
  0x0e: "yellow",
  0x0f: "white",
  0x10: "white"
};

/** 「表示装置の既定を使う」を表す値（DDS リファレンスの NONE = X'FF'） */
export const GRID_DEFAULT = 0xff;

export const GRID_MINOR = {
  UPPER_HORIZONTAL: 0x00,
  LOWER_HORIZONTAL: 0x01,
  LEFT_VERTICAL: 0x02,
  RIGHT_VERTICAL: 0x03,
  PLAIN_BOX: 0x04,
  H_RULED_BOX: 0x05,
  V_RULED_BOX: 0x06,
  HV_RULED_BOX: 0x07
} as const;

export interface ParsedChoice {
  text: string;
  selected: boolean;
  available: boolean;
  numericChar?: number;
  aid?: number;
}

export interface ParsedSelectionField {
  fieldType: number;
  kind: GuiSelectionKind;
  multiple: boolean;
  choices: ParsedChoice[];
}

/**
 * WDWBORDER が指定する窓枠。**罫線文字はホストが EBCDIC 1 バイトで寄越す**
 * （原典 `dissect_create_window` の `cwbp_fields` が `ENC_EBCDIC` で読んでいる）。
 * 8 隅・辺の文字と、モノクロ/カラー用の属性バイトを持つ。
 */
export interface ParsedWindowBorderChars {
  /** 左上 / 上辺 / 右上 / 左辺 / 右辺 / 左下 / 下辺 / 右下 */
  ulbc: string;
  tbc: string;
  urbc: string;
  lbc: string;
  rbc: string;
  llbc: string;
  bbc: string;
  lrbc: string;
}

export interface ParsedWindowBorder {
  /** モノクロ用の属性バイト */
  mba: number;
  /** カラー用の属性バイト */
  cba: number;
  /**
   * 罫線文字。**ホストが指定したときだけ入る**——`WDWBORDER((*COLOR PNK))` のように
   * 色だけを指定すると、ホストは文字を載せない短い構造を送ってくる（実機で確認）。
   */
  chars?: ParsedWindowBorderChars;
}

/** 窓の見出し／脚注（原典 `CW_TITLE_FOOTER`） */
export interface ParsedWindowTitle {
  text: string;
  /** 枠の辺に沿った寄せ方（既定は中央） */
  align: "center" | "left" | "right";
  /** true なら窓の**下辺**に出る脚注 */
  footer: boolean;
  /** カラー用の属性バイト。`WDWTITLE((*COLOR YLW))` なら 0x32 */
  cba: number;
}

export interface ParsedWindow {
  width: number;
  height: number;
  title?: ParsedWindowTitle;
  restrictCursor: boolean;
  pulldown: boolean;
  /** ホストが WDWBORDER で指定した枠（無ければクライアント設定の枠を使う） */
  border?: ParsedWindowBorder;
}

/** グリッド線 1 本（または箱）の指定 */
export interface ParsedGridItem {
  /** GRID_MINOR のいずれか */
  minorType: number;
  /** true = 消去、false = 描画（原典 `ms_flag1` bit0） */
  erase: boolean;
  /** 1 始まり */
  row: number;
  col: number;
  /** 桁数（横の広がり） */
  width: number;
  /** 行数（縦の広がり） */
  height: number;
  /** 色コード（`GRID_DEFAULT` なら主構造の既定色を使う） */
  color: number;
  /** 線種（`GRID_DEFAULT` なら主構造の既定線種を使う） */
  lineStyle: number;
  /**
   * **意味が minorType で変わる 2 つの数値**（DDS `*TYPE` の後ろの引数）。
   * 名前を付けずに生のまま持つのは、片方の意味で名付けると他方の読み手を誤らせるため。
   *
   * | minorType | value1 | value2 |
   * |---|---|---|
   * | 0x00–0x03 単独罫線（GRDLIN） | 繰り返し本数 | 本の間隔 |
   * | 0x04–0x07 箱（GRDBOX） | 横罫の**行間隔** | 縦罫の**桁間隔** |
   *
   * 実機で実測: `GRDLIN((*POS (4 3 40)) (*TYPE UPPER 3 2))` → 3, 2（3 本を 2 行おき）。
   * `GRDBOX((*POS (15 5 6 40)) (*TYPE HRZVRT 2 8))` → 2, 8（2 行ごと・8 桁ごと）。
   */
  value1: number;
  value2: number;
}

export interface ParsedGridLines {
  /** 主構造 flag1 bit0: 既存のグリッドバッファを消してから描く */
  clearBuffer: boolean;
  /** 主構造の既定色（属性バイト） */
  defaultColor: number;
  /** 主構造の既定線種（GRID_LINE_STYLE） */
  defaultLine: number;
  items: ParsedGridItem[];
}

export interface ParsedScrollBar {
  horizontal: boolean;
  total: number;
  sliderPos: number;
  size: number;
}

export type WdsfEvent =
  | { kind: "selection"; field: ParsedSelectionField }
  | { kind: "window"; window: ParsedWindow }
  | { kind: "scrollbar"; scrollbar: ParsedScrollBar }
  | { kind: "grid-lines"; grid: ParsedGridLines }
  | { kind: "clear-grid-lines" }
  | { kind: "remove-selection" }
  | { kind: "remove-window" }
  | { kind: "remove-scrollbar" }
  | { kind: "remove-all" }
  | { kind: "unknown"; type: number };

type Decode = (b: number) => number;

/** 選択フィールドの生 fieldType（下位ニブル 1=単一/2=複数）を web 描画分類へ */
function selectionKind(fieldType: number): { kind: GuiSelectionKind; multiple: boolean } {
  if (fieldType === 0x01) return { kind: "menu", multiple: false };
  if (fieldType === 0x41 || fieldType === 0x51) return { kind: "pushbutton", multiple: false };
  const low = fieldType & 0x0f;
  if (low === 0x02) return { kind: "checkbox", multiple: true };
  return { kind: "radio", multiple: false };
}

/** EBCDIC バイト列を表示文字列へ（末尾の空白・NUL は落とす） */
function decodeText(bytes: Uint8Array, decode: Decode): string {
  let s = "";
  for (const b of bytes) {
    if (b === 0x00) continue;
    s += String.fromCharCode(decode(b));
  }
  return s.replace(/\s+$/u, "");
}

/**
 * WDSF 構造体（[class, type, ...body]）を GUI イベントへ。
 * 破損入力は ByteReader が例外を投げる（呼び出し側で捕捉し警告読み飛ばし）。
 */
export function parseWdsf(sf: Uint8Array, decode: Decode): WdsfEvent {
  const r = new ByteReader(sf);
  const cls = r.u8();
  const type = r.u8();
  if (cls !== 0xd9) return { kind: "unknown", type };
  switch (type) {
    case WDSF_TYPE.DEFINE_SELECTION_FIELD:
      return { kind: "selection", field: parseSelectionField(r, decode) };
    case WDSF_TYPE.CREATE_WINDOW:
      return { kind: "window", window: parseWindow(r, decode) };
    case WDSF_TYPE.DEFINE_SCROLL_BAR_FIELD:
      return { kind: "scrollbar", scrollbar: parseScrollBar(r) };
    case WDSF_TYPE.REM_GUI_SEL_FIELD:
      return { kind: "remove-selection" };
    case WDSF_TYPE.REM_GUI_WINDOW:
      return { kind: "remove-window" };
    case WDSF_TYPE.REM_GUI_SCROLL_BAR_FIELD:
      return { kind: "remove-scrollbar" };
    case WDSF_TYPE.REM_ALL_GUI_CONSTRUCTS:
      return { kind: "remove-all" };
    case WDSF_TYPE.DRAW_ERASE_GRID_LINES:
      return { kind: "grid-lines", grid: parseGridLines(r) };
    case WDSF_TYPE.CLEAR_GRID_LINE_BUFFER:
      return { kind: "clear-grid-lines" };
    default:
      return { kind: "unknown", type };
  }
}

/** DEFINE SELECTION FIELD（0x50）: ヘッダ 16 バイト＋選択項目マイナー構造の並び */
function parseSelectionField(r: ByteReader, decode: Decode): ParsedSelectionField {
  r.u8(); // flagbyte1（マウス/オートエンター特性。web 描画では未使用）
  r.u8(); // flagbyte2（スクロールバー等）
  r.u8(); // flagbyte3
  const fieldType = r.u8();
  r.skip(5); // 予約
  const itemSize = r.u8();
  r.u8(); // height（行数）
  r.u8(); // items（選択肢数。マイナー構造の実数を優先するため未使用）
  r.u8(); // padding
  r.u8(); // separator
  r.u8(); // selection char
  r.u8(); // cancel AID
  // ここまでで 16 バイト（tn5250 の length-=16 に対応）

  const { kind, multiple } = selectionKind(fieldType);
  const choices: ParsedChoice[] = [];
  while (r.remaining >= 2) {
    const minorTotal = r.u8(); // このマイナー構造の総長（自身含む）
    const minorType = r.u8();
    const contentLen = minorTotal - 2;
    if (contentLen < 0 || contentLen > r.remaining) break;
    const content = r.bytes(contentLen);
    if (minorType === 0x10) {
      const choice = parseSelectionItem(content, itemSize, decode);
      if (choice) choices.push(choice);
    }
    // 0x01/0x02/0x03/0x09（表示属性・区切り・インジケータ）は読み飛ばす
  }
  return { fieldType, kind, multiple, choices };
}

/** 選択項目マイナー構造（type 0x10 の content）を 1 選択肢へ */
function parseSelectionItem(content: Uint8Array, itemSize: number, decode: Decode): ParsedChoice | null {
  const r = new ByteReader(content);
  if (r.remaining < 3) return null;
  const fb1 = r.u8();
  r.u8(); // flagbyte2（カーソル/ロール挙動）
  const fb3 = r.u8();

  const state = fb1 & 0xc0;
  const available = state !== 0x80; // 0x80 = 選択不可
  const selected = state === 0x40; // 0x40 = 既定選択
  const offsetIncl = (fb1 & 0x08) !== 0;
  const aidIncl = (fb1 & 0x04) !== 0;
  const numericIncl = (fb1 & 0x03) !== 0;

  // flagbyte3 上位 3 ビットが全 0 なら以降無効（tn5250: minor structure ignored）
  if ((fb3 & 0xe0) === 0) return { text: "", selected, available };

  const choice: ParsedChoice = { text: "", selected, available };
  if (offsetIncl && r.remaining > 0) r.u8(); // ニーモニックオフセット
  if (aidIncl && r.remaining > 0) choice.aid = r.u8();
  if (numericIncl && r.remaining > 0) choice.numericChar = r.u8();

  const take = Math.min(itemSize, r.remaining);
  choice.text = decodeText(r.bytes(take), decode);
  return choice;
}

/** CREATE WINDOW（0x51）: 位置は現在アドレス、深さ/幅＋境界マイナー構造（タイトル抽出） */
function parseWindow(r: ByteReader, decode: Decode): ParsedWindow {
  const fb1 = r.u8();
  const restrictCursor = (fb1 & 0x80) !== 0;
  const pulldown = (fb1 & 0x40) !== 0;
  r.skip(2); // 予約
  const height = r.u8(); // depth
  const width = r.u8();

  const win: ParsedWindow = { width, height, restrictCursor, pulldown };
  // 境界マイナー構造（あれば）。タイトル/フッタ構造（type 0x10）からタイトル文字を拾う
  while (r.remaining >= 2) {
    const borderLen = r.u8();
    const contentLen = borderLen - 1; // borderLen は自身を含む
    if (contentLen <= 0 || contentLen > r.remaining) break;
    const borderType = r.u8();
    const body = r.bytes(contentLen - 1);
    if (borderType === CW_TITLE_FOOTER && body.length > 4) {
      // flag1(1) mba(1) cba(1) 予約(1) の後がタイトル文字
      // （原典 `dissect_create_window` の `cw_tf_fields`）
      const text = decodeText(body.subarray(4), decode);
      if (text !== "") {
        const flag1 = body[0]!;
        win.title = {
          text,
          // flag1 の上位 2 ビットが**寄せ方**（0=中央 / 1=右 / 2=左 / 3=予約＝中央）。
          // 実機は 0x00 を送ってくる＝中央寄せで、ACS も中央に出す。
          // ここを見ずに左端へ置くと ACS と食い違う
          align: TITLE_ALIGN[(flag1 & 0xc0) >> 6] ?? "center",
          // bit 0x20 が立っていれば**フッタ**（窓の下辺に出る）
          footer: (flag1 & 0x20) !== 0,
          cba: body[2]!
        };
      }
    } else if (borderType === CW_BORDER_PRESENTATION && body.length >= 3) {
      // **WDWBORDER の実体**（原典 `dissect_create_window` の `cwbp_fields`）。
      // length(1) type(1) を読んだ後の body は
      //   flag1(1) mba(1) cba(1) ulbc tbc urbc lbc rbc llbc bbc lrbc（各 EBCDIC 1 バイト）
      // 罫線文字は **1 バイトずつ** decode する。decodeText は末尾の空白を落とすので使えない
      // ——罫線に空白（＝その辺を描かない）を指定してくるホストがあり、桁がずれる。
      //
      // **罫線文字は「あれば」**。実機（）で `WDWBORDER((*COLOR PNK))` を出すと
      // ホストは `05 01 80 38 38`＝**5 バイトの短い形**で送ってきた（色だけの指定なので
      // 文字を載せない）。原典のフィールド並びは最長形を示しているだけで**長さは可変**で、
      // 13 バイト固定と決め打つと色指定だけの窓を丸ごと取りこぼす。
      const ch = (i: number): string => String.fromCharCode(decode(body[i]!));
      const border: ParsedWindowBorder = { mba: body[1]!, cba: body[2]! };
      if (body.length >= 11) {
        border.chars = {
          ulbc: ch(3), tbc: ch(4), urbc: ch(5), lbc: ch(6),
          rbc: ch(7), llbc: ch(8), bbc: ch(9), lrbc: ch(10)
        };
      }
      win.border = border;
    }
  }
  return win;
}

/** CREATE WINDOW のマイナー構造: Border Presentation（原典 `CW_BORDER_PRESENTATION`） */
const CW_BORDER_PRESENTATION = 0x01;
/** CREATE WINDOW のマイナー構造: 見出し／脚注（原典 `CW_TITLE_FOOTER`） */
const CW_TITLE_FOOTER = 0x10;
/** 見出しの寄せ方（原典 `vals_tn5250_wdsf_cw_tf_flag_orientation`。3 は予約で中央扱い） */
const TITLE_ALIGN = ["center", "right", "left", "center"] as const;

/**
 * DRAW/ERASE GRID LINES（0x60）。DDS の `GRDATR` / `GRDLIN` がここへコンパイルされる。
 *
 * 主構造 7 バイト:
 *   partition(1) / flag1(1) / reserved(1) / flag2(1) / reserved(1) / default_color(1) / default_line(1)
 * マイナー構造 10 バイト（type が 0x00–0x07 の間だけ続く。原典の while ループと同じ打ち切り条件）:
 *   length(1) / minor_type(1) / ms_flag1(1) / start_row(1) / start_column(1) /
 *   horizontal_dimension(1) / vertical_dimension(1) / default_color(1) / line_repeat(1) / line_interval(1)
 *
 * 構造は Wireshark の 5250 ディセクタ（`epan/dissectors/packet-tn5250.c` の
 * `dissect_draw_erase_gridlines`）を直読して確定した。tn5250（C 版）は
 * "Unhandled WDSF" としてログに出すだけで**実装していない**ため参照元にできない。
 */
function parseGridLines(r: ByteReader): ParsedGridLines {
  // **主構造も可変長**。原典のフィールド並びは最長形（7 バイト）を示しているだけで、
  // 実機（）は「バッファをクリアせよ」だけのとき `01 80 00 00 00` ＝
  // **5 バイト**で送ってきた（既定色・既定線種を載せない）。7 バイト固定で読むと
  // レコードの終端に突き当たり、**構造化フィールドごと「壊れている」と捨ててしまう**。
  const next = (fallback = 0): number => (r.remaining > 0 ? r.u8() : fallback);
  next(); // partition（区画。単一区画前提なので使わない）
  const flag1 = next();
  next(); // 予約
  next(); // flag2（原典も bit0 のみ定義。描画に使う情報は無い）
  next(); // 予約
  const defaultColor = next(0x20); // 既定は通常の緑
  const defaultLine = next(GRID_LINE_STYLE.SOLID);

  const items: ParsedGridItem[] = [];
  // マイナー構造は**自分の長さを先頭に持つ**。type が 0x00–0x07 でなくなったら打ち切る（原典と同じ）。
  //
  // **長さを決め打たない。** Wireshark のディセクタは 10 フィールドで模しているが、
  // 実機（）は `length=0x0b`＝**11 バイト**で送ってきた。増えているのは
  // **項目ごとの線種**で、`(*LINTYP DSH)` を指定した箱の実データが
  // `… 01 08 02 08`（色=BLU / 線種=DSH / 横罫 2 / 縦罫 8）と並ぶことから確定した。
  // 長さに従って進めれば、フィールドが増えても位置がずれない。
  while (r.remaining >= 2) {
    const len = r.peek();
    const minorType = r.peekAt(1);
    if (minorType > GRID_MINOR.HV_RULED_BOX) break;
    if (len < 3 || len > r.remaining) break;
    const end = r.offset + len;
    r.u8(); // length
    r.u8(); // minor_type（peek 済み）
    const msFlag1 = r.u8();
    const at = (): number => (r.offset < end ? r.u8() : GRID_DEFAULT);
    const item: ParsedGridItem = {
      minorType,
      erase: (msFlag1 & 0x80) !== 0, // bit0 = 最上位ビット（5250 のビット番号は MSB 起点）
      row: at(),
      col: at(),
      width: at(),
      height: at(),
      color: at(),
      lineStyle: at(),
      value1: at(),
      value2: at()
    };
    items.push(item);
    r.skip(Math.max(0, end - r.offset)); // 未知の追加フィールドがあっても長さぶん進む
  }
  return { clearBuffer: (flag1 & 0x80) !== 0, defaultColor, defaultLine, items };
}

/** DEFINE SCROLL BAR FIELD（0x53）: 方向・総数・つまみ位置・サイズ（数値は 10 進 4 桁） */
function parseScrollBar(r: ByteReader): ParsedScrollBar {
  const fb1 = r.u8();
  const horizontal = (fb1 & 0x80) !== 0;
  r.u8(); // 予約
  const total = 1000 * r.u8() + 100 * r.u8() + 10 * r.u8() + r.u8();
  const sliderPos = 1000 * r.u8() + 100 * r.u8() + 10 * r.u8() + r.u8();
  const size = r.u8();
  return { horizontal, total, sliderPos, size };
}
