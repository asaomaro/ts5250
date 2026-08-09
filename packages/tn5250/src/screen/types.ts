/** 画面スナップショット共有型（spec「画面スナップショット」。MCP/WS がそのまま使う唯一の画面表現） */

export type ScreenColor = "green" | "white" | "red" | "turquoise" | "yellow" | "pink" | "blue";

/**
 * セルの種類。
 *
 * `unmappable` は**ホストが「このコードページでは表せない」と言って送ってきた桁**
 * （0x1F。`UNMAPPABLE` を参照）。文字は空白だが、**空白と区別できるようにする**
 * ——区別しないと「ヘルプが虫食い」としか見えない。ACS も同じ桁を塗り潰しで描く
 * （利用者提供の画面で確認）。
 */
export type CellKind = "sbcs" | "dbcs-lead" | "dbcs-tail" | "so" | "si" | "attr" | "unmappable";

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

/**
 * FFW の ADJUST（右寄せ）指定。**欄を出るとき（Field Exit）に端末が値を整形するための指定**で、
 * ホストは整形しない（実機 SR-OSAKA で実測。左詰めで送れば左詰めのまま格納される）。
 * `mandatory-fill` は右寄せではなく「全桁を埋めよ」の検証指定（GNU tn5250 / tn5250j とも桁を動かさない）。
 */
export type FieldAdjust = "right-zero" | "right-blank" | "mandatory-fill";

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
  /** FFW の ADJUST 指定（0x0005/0x0006/0x0007）。無指定・予約値では付かない */
  adjust?: FieldAdjust;
  /**
   * FFW の shift が signed-num（0x0700）のとき **true**。**ADJUST 無指定でも空白で右寄せする**
   * 規則と、**最終桁が符号桁である**ことを表す（GNU tn5250 `display.c` は signed-num の adjust を
   * 無条件で RIGHT_BLANK へ差し替え、右寄せ時に最終桁を動かさない）。
   * `numeric` は数値 3 種をまとめた既存フラグなので、これだけでは signed-num を見分けられない。
   *
   * `dbcsType` / `adjust` と同じく**当てはまるときだけ付ける**（false は情報を持たないため）。
   */
  signedNumeric?: boolean;
  /**
   * FFW の shift が digits-only（**0x0500**）のとき **true**。**この欄だけは真に数字しか受け付けない**
   * （`field-validate.ts` の許容集合が `/^[0-9]*$/`。他の数値欄は `.` `,` `+` `-` も通る）。
   *
   * `numeric` は数値 3 種をまとめた既存フラグなので、これだけでは見分けられない。
   * `signedNumeric` / `dbcsType` と同じく**当てはまるときだけ付ける**。
   */
  digitsOnly?: boolean;
  /**
   * FFW の shift が alpha-only（0x0100。DDS 35 桁の `X`）のとき true。
   * **英字・`,`・`.`・`-`・空白しか受け付けない**（数字を弾く）。
   * GNU tn5250 `field.c:404` と tn5250j `Screen5250.java:1372` が同じ許容集合を持つ。
   */
  alphaOnly?: boolean;
  /**
   * FFW の shift が io（0x0600。DDS 35 桁の `I` = Inhibit keyboard entry）のとき true。
   * **キーボードからは入力できない**欄（磁気ストライプ読み取り装置等のための入力欄）。
   * GNU tn5250 は `DATA_DISALLOWED` で拒否し、tn5250j は case 自体を持たず打鍵を捨てる。
   *
   * **「キーボードから」の制約なので送信時検証（`validateFieldContent`）では弾かない**——
   * ペースト・マクロ・MCP 経由の設定まで塞いでしまうため。判定は端末側で行う。
   */
  keyboardInhibited?: boolean;
  /**
   * FFW の MONOCASE（0x0020）。この欄に打った **ASCII 英小文字**を大文字にして格納する。
   * 全角・カナ・記号には触らない（GNU tn5250 `display.c:924` の `isalpha` 相当）。
   *
   * **実機では既定で立つ。** DDS の文字欄は `CHECK(LC)` を書かない限りこのビットが載る
   * （SR-OSAKA で実測。`CHECK(LC)` 付きだけ 0x4020 → 0x4000 になった）。
   */
  monocase?: boolean;
  /**
   * FFW の FIELD_EXIT_REQUIRED（0x0040。DDS の `CHECK(FE)`）。
   * **欄が満杯になっても自動で次欄へ送らない**——Field Exit か Tab で明示的に出る。
   */
  fieldExitRequired?: boolean;
  /**
   * FFW の AUTO_ENTER（0x0080。DDS の `CHECK(ER)`）。
   * **欄が満杯になった時点・欄を出た時点で Enter を自動送信する**。
   */
  autoEnter?: boolean;
  /**
   * FFW の MANDATORY_ENTER（0x0008。DDS の `CHECK(ME)`）。空のままでは送信できない。
   *
   * **ホストはこれを検証しない**（SR-OSAKA で実測: 空のまま Enter を送っても素通りした）。
   * 端末が検証しなければ誰も検証しない。
   */
  mandatoryEnter?: boolean;
  /**
   * FFW の DUP_ENABLE（0x1000。DDS の `DUP` キーワード）。**Dup キーが使える欄**。
   * Dup はカーソルから欄末尾までを `0x1C` で埋める（アプリが「前と同じ」と解釈する印）。
   * SR-OSAKA で `DUP` を書いた欄が `0x5020` になることを実測済み。
   */
  dupEnable?: boolean;
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

/**
 * 直近に適用したレコードがバッファへ書いた範囲。**「重ね書きか否か」の判定材料**として web-ui へ渡す。
 *
 * 罫線・反転からの推測では「左右に `:` が並ぶ帳票」「反転バナー」を窓と誤検出する。判定が見た目しか
 * 見られないのは材料が渡っていないためで、受信データを渡せば裏が取れる——というのが出発点だった。
 *
 * **ただし万能ではない。** 実機（SR-OSAKA・IBM i 7.3）で採った実測:
 *
 * | 画面 | 記録 |
 * |---|---|
 * | Attn の窓（ATNPGM。反転枠） | `cleared=false` / `rect=r18-24` ＝**重ね書き** |
 * | **F1 ヘルプ窓**（`.`／`:` の箱） | **`cleared=true` / `rect=r1-24` ＝全画面書き直し** |
 * | 通常画面（メニュー・PDM・DSPLIBL） | `cleared=true` / `rect=r1-24` |
 *
 * ヘルプ窓はホストが画面をクリアしてから背景の見出しごと箱を描き直すので、
 * **受信データ上は通常画面と区別が付かない**。よってこの記録で言えるのは
 * 「そのレコードが重ね書きだったか」までで、**窓かどうかを一般に決められはしない**。
 * 消費側（`web-ui/src/composables/fkeyLegend.ts` の `isOverlayWrite`）はこの限界を前提にしている。
 *
 * 通常画面側の裏付けは実機採取レコード（`packages/tn5250/test/fixtures/pub400-*.jsonl`）の再生でも
 * 取れており、**全画面遷移 6/6 すべてに CLEAR が付いていた**。
 */
export interface WriteExtent {
  /** 書き込みの外接矩形（1 始まり・両端含む）。書き込みが 1 セルも無ければ省略 */
  rect?: { row1: number; row2: number; col1: number; col2: number };
  /** CLEAR UNIT / CLEAR UNIT ALTERNATE を通った */
  cleared: boolean;
  /** RESTORE SCREEN（ESC 0x12）で画面を丸ごと戻した */
  restored: boolean;
  /** 実際に書かれたセル数（矩形の面積とは別。矩形が疎かどうかを見る余地を残す） */
  cells: number;
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
  /**
   * 直近レコードの書き込み範囲（記録がある場合のみ）。
   *
   * **任意にしてあるのは意図的**——既存のテスト資産は手組み snapshot／描画済み fixture で
   * これを持たない。消費側は**不在を許容し、その場合は従来どおりに振る舞う**こと。
   */
  lastWrite?: WriteExtent;
}
