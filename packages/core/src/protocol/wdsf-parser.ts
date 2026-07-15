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
  REM_ALL_GUI_CONSTRUCTS: 0x5f
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

export interface ParsedWindow {
  width: number;
  height: number;
  title?: string;
  restrictCursor: boolean;
  pulldown: boolean;
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
    if (borderType === 0x10 && body.length > 4) {
      // flags(1) mono(1) color(1) reserved(1) の後がタイトル文字
      const title = decodeText(body.subarray(4), decode);
      if (title !== "") win.title = title;
    }
  }
  return win;
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
