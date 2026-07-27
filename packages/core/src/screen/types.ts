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

/** WDWTITLE の見出し／脚注（枠の辺に載る） */
export interface GuiWindowTitle {
  text: string;
  /** 辺に沿った寄せ方（既定は中央。ACS も中央に出す） */
  align: "center" | "left" | "right";
  /** true なら窓の下辺に出る脚注 */
  footer: boolean;
  /** カラー用の属性バイト */
  cba: number;
}

export interface GuiWindow {
  id: number;
  row: number;
  col: number;
  width: number;
  height: number;
  /** ホストが WDWTITLE で指定した見出し／脚注 */
  title?: GuiWindowTitle;
  /** カーソルをウィンドウ内に制限 */
  restrictCursor: boolean;
  /** プルダウンウィンドウ */
  pulldown: boolean;
  /**
   * ホストが WDWBORDER で指定した枠。**無ければクライアント設定の枠を使う**
   * （ホスト指定があるならそちらが「実機と同じ見た目」なので優先する）。
   */
  border?: GuiWindowBorder;
}

/** WDWBORDER の罫線文字（8 隅・辺）。デコード済みの 1 文字 */
export interface GuiWindowBorderChars {
  ulbc: string;
  tbc: string;
  urbc: string;
  lbc: string;
  rbc: string;
  llbc: string;
  bbc: string;
  lrbc: string;
}

/** WDWBORDER が指定した枠。**色だけの指定なら `chars` は無い**（実機で確認） */
export interface GuiWindowBorder {
  /** カラー用の属性バイト（decodeAttribute で色に落とす） */
  cba: number;
  chars?: GuiWindowBorderChars;
}

/**
 * グリッド罫線（DDS の GRDATR / GRDLIN）。
 * ホストは「箱」や「片側の線」を指定し、内部の等間隔罫線も指定できる。
 */
export interface GuiGridLine {
  id: number;
  /** GRID_MINOR の値（0x00 上辺 … 0x07 縦横罫線付きの箱） */
  minorType: number;
  /** 1 始まり */
  row: number;
  col: number;
  width: number;
  height: number;
  /** 線種（GRID_LINE_STYLE） */
  lineStyle: number;
  /** 色（属性バイト。0 なら既定色） */
  color: number;
  /**
   * DDS `*TYPE` の後ろの 2 つの数値。**意味は minorType で変わる**
   * （単独罫線 0x00–0x03 は「繰り返し本数・間隔」、箱 0x04–0x07 は「横罫の行間隔・縦罫の桁間隔」）。
   * 詳細は `ParsedGridItem` の表を参照。
   */
  value1: number;
  value2: number;
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
  /** グリッド罫線（GRDATR / GRDLIN）。ホストが引いた線をそのまま持つ */
  gridLines: GuiGridLine[];
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
