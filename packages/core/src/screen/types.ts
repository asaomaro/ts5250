/** 画面スナップショット共有型（spec「画面スナップショット」。MCP/WS がそのまま使う唯一の画面表現） */

export type ScreenColor = "green" | "white" | "red" | "turquoise" | "yellow" | "pink" | "blue";

export type CellKind = "sbcs" | "dbcs-lead" | "dbcs-tail" | "so" | "si" | "attr";

export interface Cell {
  /** 表示文字 1 文字。attr/so/si と nonDisplay は常に " " */
  char: string;
  kind: CellKind;
  color: ScreenColor;
  reverse: boolean;
  underline: boolean;
  blink: boolean;
  columnSeparator: boolean;
  nonDisplay: boolean;
  /** SBCS セルの生 EBCDIC バイト（カタカナ⇔英小文字の表示再解釈に使う。DBCS/制御桁は undefined） */
  rawByte?: number;
}

export interface Field {
  /** snapshot 時点の連番（1 始まり・画面順） */
  index: number;
  /** フィールド先頭（属性バイトの次の桁）。1 始まり */
  row: number;
  col: number;
  length: number;
  protected: boolean;
  /** 非表示（パスワード等）。value は常に "" */
  hidden: boolean;
  numeric: boolean;
  dbcsType?: "pure" | "open" | "either";
  mdt: boolean;
  value: string;
}

/** 拡張 5250 GUI コントロール（WSF/WDSF class 0xD9 由来。SC30-3533 / GNU tn5250 参照） */

/** 選択フィールドの見た目（web 描画の分類）。single=ラジオ / multiple=チェック / button=プッシュボタン / menu=メニューバー */
export type GuiSelectionKind = "radio" | "checkbox" | "pushbutton" | "menu";

export interface GuiChoice {
  /** フィールド内 1 始まり連番 */
  index: number;
  text: string;
  /** 既定/現在の選択状態 */
  selected: boolean;
  /** 選択可能か（不可 = グレーアウト） */
  available: boolean;
  /** 数字選択文字（あれば。生バイト） */
  numericChar?: number;
  /** 選択時に返す AID（あれば。生バイト） */
  aid?: number;
}

export interface GuiSelectionField {
  /** 画面内で一意の識別子（生成順） */
  id: number;
  /** 1 始まり画面座標（データストリームの現在位置） */
  row: number;
  col: number;
  kind: GuiSelectionKind;
  /** 生フィールドタイプ（0x11/0x12/0x41 等） */
  fieldType: number;
  /** 複数選択可（チェックボックス系） */
  multiple: boolean;
  choices: GuiChoice[];
}

export interface GuiWindow {
  id: number;
  row: number;
  col: number;
  width: number;
  height: number;
  title?: string;
  /** カーソルをウィンドウ内に制限 */
  restrictCursor: boolean;
  /** プルダウンウィンドウ */
  pulldown: boolean;
}

export interface GuiScrollBar {
  id: number;
  row: number;
  col: number;
  /** true = 水平 / false = 垂直 */
  horizontal: boolean;
  /** スクロール可能な総行/桁数 */
  total: number;
  /** つまみ位置 */
  sliderPos: number;
  /** つまみサイズ */
  size: number;
}

export interface GuiConstructs {
  selectionFields: GuiSelectionField[];
  windows: GuiWindow[];
  scrollBars: GuiScrollBar[];
}

export interface ScreenSnapshot {
  sessionId: string;
  rows: 24 | 27;
  cols: 80 | 132;
  cursor: { row: number; col: number };
  keyboardLocked: boolean;
  cells: Cell[][];
  fields: Field[];
  systemMessage?: string;
  /** 拡張 5250 GUI コントロール（存在する場合のみ。空なら省略） */
  gui?: GuiConstructs;
}
