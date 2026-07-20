import { As400Error } from "../errors.js";
import { FFW } from "../protocol/constants.js";
import type {
  ParsedScrollBar,
  ParsedSelectionField,
  ParsedWindow
} from "../protocol/wdsf-parser.js";
import { decodeAttribute, DEFAULT_ATTR } from "./attributes.js";
import type {
  Cell,
  CellKind,
  Field,
  GuiConstructs,
  GuiScrollBar,
  GuiSelectionField,
  GuiWindow,
  ScreenSnapshot
} from "./types.js";

/**
 * 内部セル: 属性バイト or 文字（Unicode）。null = 未設定（既定属性の空白）。
 * charKind は so/si/dbcs-lead/dbcs-tail を保持（既定 sbcs。DBCS の桁位置維持に使う）。
 */
type CharKind = "sbcs" | "so" | "si" | "dbcs-lead" | "dbcs-tail";
export type InternalCell =
  | { type: "attr"; byte: number }
  | { type: "char"; char: string; charKind: CharKind; rawByte?: number }
  | null;

export interface InternalField {
  startAddr: number;
  length: number;
  ffw: number;
  /** フィールド直前の属性バイト（hidden 判定に使う） */
  attrByte: number;
  mdt: boolean;
  /** DBCS フィールド種別（FCW 由来。undefined = SBCS） */
  dbcsType?: "pure" | "open" | "either";
}

/** 内部 charKind → snapshot の CellKind */
function cellKindFor(charKind: CharKind): CellKind {
  switch (charKind) {
    case "so":
      return "so";
    case "si":
      return "si";
    case "dbcs-lead":
      return "dbcs-lead";
    case "dbcs-tail":
      return "dbcs-tail";
    default:
      return "sbcs";
  }
}

/** 位置一致で GUI 構造体を除去。一致が無ければ全除去（ホストが位置無指定で再構築する場合に対応） */
function removeByPos<T extends { row: number; col: number }>(list: T[], row: number, col: number): T[] {
  const matched = list.filter((g) => g.row === row && g.col === col);
  return matched.length > 0 ? list.filter((g) => !(g.row === row && g.col === col)) : [];
}

/**
 * 5250 画面バッファ（design: 画面モデルが唯一の真実。Unicode セルのみ保持）。
 * アドレスは 0 始まりの線形（addr = row*cols + col）。対外は 1 始まり row/col（snapshot で変換）。
 */
export class ScreenBuffer {
  rows: 24 | 27 = 24;
  cols: 80 | 132 = 80;
  private cells: InternalCell[];
  private fields: InternalField[] = [];
  cursorAddr = 0;
  systemMessage: string | undefined;
  /** 拡張 5250 GUI 構造体（WDSF 由来）。id は生成順の連番 */
  private guiSelections: GuiSelectionField[] = [];
  private guiWindows: GuiWindow[] = [];
  private guiScrollBars: GuiScrollBar[] = [];
  private guiIdSeq = 0;
  /** 代替（ワイド）画面の許可サイズ。CLEAR UNIT ALTERNATE で切替える（27x132 端末のみ） */
  private readonly alternate: { rows: 27; cols: 132 } | undefined;

  constructor(opts: { primary?: "24x80"; alternate?: "27x132" } = {}) {
    this.cells = new Array<InternalCell>(this.rows * this.cols).fill(null);
    if (opts.alternate === "27x132") this.alternate = { rows: 27, cols: 132 };
  }

  get size(): number {
    return this.rows * this.cols;
  }

  private resize(rows: 24 | 27, cols: 80 | 132): void {
    this.rows = rows;
    this.cols = cols;
    this.cells = new Array<InternalCell>(rows * cols).fill(null);
    this.fields = [];
    this.cursorAddr = 0;
    this.systemMessage = undefined;
    this.clearGui();
  }

  /** GUI 構造体をすべて除去（画面クリア・REM_ALL_GUI_CONSTRUCTS 時） */
  clearGui(): void {
    this.guiSelections = [];
    this.guiWindows = [];
    this.guiScrollBars = [];
  }

  /** DEFINE SELECTION FIELD を GUI 選択フィールドとして登録（位置は 1 始まり row/col） */
  addSelectionField(parsed: ParsedSelectionField, row: number, col: number): void {
    this.guiSelections.push({
      id: ++this.guiIdSeq,
      row,
      col,
      kind: parsed.kind,
      fieldType: parsed.fieldType,
      multiple: parsed.multiple,
      choices: parsed.choices.map((c, i) => {
        const choice = {
          index: i + 1,
          text: c.text,
          selected: c.selected,
          available: c.available
        } as GuiSelectionField["choices"][number];
        if (c.numericChar !== undefined) choice.numericChar = c.numericChar;
        if (c.aid !== undefined) choice.aid = c.aid;
        return choice;
      })
    });
  }

  /** CREATE WINDOW を GUI ウィンドウとして登録 */
  addWindow(parsed: ParsedWindow, row: number, col: number): void {
    const win: GuiWindow = {
      id: ++this.guiIdSeq,
      row,
      col,
      width: parsed.width,
      height: parsed.height,
      restrictCursor: parsed.restrictCursor,
      pulldown: parsed.pulldown
    };
    if (parsed.title !== undefined) win.title = parsed.title;
    this.guiWindows.push(win);
  }

  /** DEFINE SCROLL BAR FIELD を GUI スクロールバーとして登録 */
  addScrollBar(parsed: ParsedScrollBar, row: number, col: number): void {
    this.guiScrollBars.push({
      id: ++this.guiIdSeq,
      row,
      col,
      horizontal: parsed.horizontal,
      total: parsed.total,
      sliderPos: parsed.sliderPos,
      size: parsed.size
    });
  }

  /** REM_GUI_SEL_FIELD: 選択フィールドを除去（位置一致優先、無ければ全除去） */
  removeSelectionField(row: number, col: number): void {
    this.guiSelections = removeByPos(this.guiSelections, row, col);
  }

  removeWindow(row: number, col: number): void {
    this.guiWindows = removeByPos(this.guiWindows, row, col);
  }

  removeScrollBar(row: number, col: number): void {
    this.guiScrollBars = removeByPos(this.guiScrollBars, row, col);
  }

  /** CLEAR UNIT ALTERNATE: 27x132 へ切替えクリア（許可時のみ。24x80 端末では呼び出し側が警告） */
  clearUnitAlternate(): boolean {
    if (!this.alternate) return false;
    this.resize(this.alternate.rows, this.alternate.cols);
    return true;
  }

  addrOf(row1: number, col1: number): number {
    if (row1 < 1 || row1 > this.rows || col1 < 1 || col1 > this.cols) {
      throw new As400Error("PROTOCOL_ERROR", `address out of range: row=${row1}, col=${col1}`);
    }
    return (row1 - 1) * this.cols + (col1 - 1);
  }

  rowColOf(addr: number): { row: number; col: number } {
    return { row: Math.floor(addr / this.cols) + 1, col: (addr % this.cols) + 1 };
  }

  private savedStack: {
    /**
     * **サイズも退避する。** cells の長さは rows*cols に一致していなければならない。
     * ヘルプ画面が CLEAR UNIT で 24x80 に落としたあと 27x132 の cells だけ戻すと、
     * 描画が cols=80 で折り返して 24 行を超えた分が消える（SEU の F1→F12 で実際に崩れた）。
     */
    rows: 24 | 27;
    cols: 80 | 132;
    cells: InternalCell[];
    fields: InternalField[];
    cursorAddr: number;
    guiSelections: GuiSelectionField[];
    guiWindows: GuiWindow[];
    guiScrollBars: GuiScrollBar[];
  }[] = [];

  /** CLEAR UNIT: 既定サイズ（24x80）でクリア */
  clearUnit(): void {
    if (this.rows !== 24 || this.cols !== 80) {
      this.resize(24, 80);
      return;
    }
    this.cells.fill(null);
    this.fields = [];
    this.cursorAddr = 0;
    this.systemMessage = undefined;
    this.clearGui();
  }

  /** SAVE SCREEN（ESC 0x02）: 現在のバッファを退避（SysReq のシステム要求行オーバーレイ等で使う） */
  /** 指定アドレスのセル（未書き込みは null）。SAVE SCREEN 応答の直列化で使う */
  cellAt(addr: number): InternalCell {
    this.checkAddr(addr);
    return this.cells[addr] ?? null;
  }

  saveScreen(): void {
    this.savedStack.push({
      rows: this.rows,
      cols: this.cols,
      cells: this.cells.map((c) => (c === null ? null : { ...c })),
      fields: this.fields.map((f) => ({ ...f })),
      cursorAddr: this.cursorAddr,
      guiSelections: this.guiSelections.map((s) => ({ ...s, choices: s.choices.map((c) => ({ ...c })) })),
      guiWindows: this.guiWindows.map((w) => ({ ...w })),
      guiScrollBars: this.guiScrollBars.map((b) => ({ ...b }))
    });
  }

  /** RESTORE SCREEN（ESC 0x12）: 直近の退避を復元 */
  restoreScreen(): boolean {
    const saved = this.savedStack.pop();
    if (!saved) return false;
    this.rows = saved.rows;
    this.cols = saved.cols;
    this.cells = saved.cells;
    this.fields = saved.fields;
    this.cursorAddr = saved.cursorAddr;
    this.guiSelections = saved.guiSelections;
    this.guiWindows = saved.guiWindows;
    this.guiScrollBars = saved.guiScrollBars;
    return true;
  }

  clearFormatTable(): void {
    this.fields = [];
  }

  setChar(addr: number, char: string, rawByte?: number): void {
    this.checkAddr(addr);
    this.cells[addr] = { type: "char", char, charKind: "sbcs", ...(rawByte !== undefined ? { rawByte } : {}) };
  }

  /** SO/SI 制御桁を配置（見た目は空白・1 桁占有。DBCS 桁位置維持の要） */
  setShift(addr: number, kind: "so" | "si"): void {
    this.checkAddr(addr);
    this.cells[addr] = { type: "char", char: " ", charKind: kind };
  }

  /** DBCS 1 文字を lead/tail の 2 桁に配置する */
  setDbcs(addr: number, char: string): void {
    this.checkAddr(addr);
    this.checkAddr(addr + 1);
    this.cells[addr] = { type: "char", char, charKind: "dbcs-lead" };
    this.cells[addr + 1] = { type: "char", char: "", charKind: "dbcs-tail" };
  }

  setAttr(addr: number, byte: number): void {
    this.checkAddr(addr);
    this.cells[addr] = { type: "attr", byte };
  }

  /** from から to まで（両端含む・線形）を null（既定空白）にする */
  eraseRange(from: number, to: number): void {
    this.checkAddr(from);
    this.checkAddr(to);
    for (let i = from; i <= to; i++) this.cells[i] = null;
  }

  /** SF オーダー: フィールド定義（attrByte は startAddr-1 に書かれた属性バイト） */
  addField(
    startAddr: number,
    length: number,
    ffw: number,
    attrByte: number,
    dbcsType?: "pure" | "open" | "either"
  ): void {
    this.checkAddr(startAddr);
    if (length < 1 || startAddr + length > this.size) {
      throw new As400Error("PROTOCOL_ERROR", `field out of range: start=${startAddr}, len=${length}`);
    }
    // 同一開始アドレスの再定義は置換（画面再送で二重登録しない）
    this.fields = this.fields.filter((f) => f.startAddr !== startAddr);
    this.fields.push({
      startAddr,
      length,
      ffw,
      attrByte,
      mdt: (ffw & FFW.MDT) !== 0,
      ...(dbcsType !== undefined ? { dbcsType } : {})
    });
  }

  /** 画面順のフィールド一覧（1 始まり index はこの順） */
  orderedFields(): readonly InternalField[] {
    return [...this.fields].sort((a, b) => a.startAddr - b.startAddr);
  }

  fieldByIndex(index1: number): InternalField {
    const f = this.orderedFields()[index1 - 1];
    if (!f) throw new As400Error("FIELD_NOT_FOUND", `field #${index1} not found`);
    return f;
  }

  fieldAt(row1: number, col1: number): InternalField {
    const addr = this.addrOf(row1, col1);
    const f = this.fields.find((x) => x.startAddr === addr);
    if (!f) throw new As400Error("FIELD_NOT_FOUND", `no field starts at (${row1},${col1})`);
    return f;
  }

  /**
   * フィールド値のローカル編集（spec: protected/長さは同期エラー）。
   * skipCharLengthCheck=true（DBCS フィールド）は文字数チェックを省く（呼び出し側がバイト長で検証済み）。
   */
  setFieldValue(field: InternalField, value: string, skipCharLengthCheck = false): void {
    if ((field.ffw & FFW.BYPASS) !== 0) {
      const { row, col } = this.rowColOf(field.startAddr);
      throw new As400Error("FIELD_PROTECTED", `field at (${row},${col}) is protected`);
    }
    if (!skipCharLengthCheck && value.length > field.length) {
      throw new As400Error(
        "FIELD_OVERFLOW",
        `value length ${value.length} exceeds field length ${field.length}`
      );
    }
    for (let i = 0; i < field.length; i++) {
      const ch = value[i];
      this.cells[field.startAddr + i] = ch !== undefined ? { type: "char", char: ch, charKind: "sbcs" } : null;
    }
    field.mdt = true;
  }

  fieldValue(field: InternalField): string {
    let s = "";
    for (let i = 0; i < field.length; i++) {
      const c = this.cells[field.startAddr + i];
      s += c?.type === "char" ? c.char : " ";
    }
    return s.replace(/ +$/, "");
  }

  /** MDT の立ったフィールド（Read MDT Fields 応答用・画面順） */
  mdtFields(): readonly InternalField[] {
    return this.orderedFields().filter((f) => f.mdt);
  }

  /** CC1 の MDT リセット等で使用 */
  resetMdt(): void {
    for (const f of this.fields) f.mdt = false;
  }

  /** CC1: 非 bypass フィールドの MDT のみリセット */
  resetMdtNonBypass(): void {
    for (const f of this.fields) {
      if ((f.ffw & FFW.BYPASS) === 0) f.mdt = false;
    }
  }

  /** CC1: 非 bypass フィールドの内容を null 化する（onlyMdt=true なら MDT の立つものだけ） */
  nullNonBypass(onlyMdt: boolean): void {
    for (const f of this.fields) {
      if ((f.ffw & FFW.BYPASS) !== 0) continue;
      if (onlyMdt && !f.mdt) continue;
      for (let i = 0; i < f.length; i++) this.cells[f.startAddr + i] = null;
    }
  }

  isFieldHidden(field: InternalField): boolean {
    return decodeAttribute(field.attrByte).nonDisplay;
  }

  snapshot(sessionId: string, keyboardLocked: boolean): ScreenSnapshot {
    const cells: Cell[][] = [];
    // フィールド属性はフィールド長で境界付ける（ACS 準拠）。閉じ属性を送らないアプリ（PDM 等）で
    // 下線・カラー等の属性がフィールドを越えて非編集エリアへ漏れるのを防ぐため、フィールド終端
    // （startAddr+length）に明示属性が無ければ既定属性へ戻す。
    const fieldEnds = new Set<number>();
    for (const f of this.fields) fieldEnds.add(f.startAddr + f.length);
    let attr = DEFAULT_ATTR;
    for (let r = 0; r < this.rows; r++) {
      const rowCells: Cell[] = [];
      for (let c = 0; c < this.cols; c++) {
        const addr = r * this.cols + c;
        const cell = this.cells[addr];
        if (cell?.type !== "attr" && fieldEnds.has(addr)) attr = DEFAULT_ATTR;
        if (cell?.type === "attr") {
          attr = decodeAttribute(cell.byte);
          rowCells.push({
            char: " ",
            kind: "attr",
            color: attr.color,
            reverse: false,
            underline: false,
            blink: false,
            columnSeparator: false,
            nonDisplay: false
          });
        } else {
          const charKind = cell?.type === "char" ? cell.charKind : "sbcs";
          const raw = cell?.type === "char" ? cell.char : " ";
          const rawByte = cell?.type === "char" ? cell.rawByte : undefined;
          // so/si/属性桁・nonDisplay は空白表示（桁は保持）。それ以外は文字を出す
          const isControl = charKind === "so" || charKind === "si";
          const out: Cell = {
            // nonDisplay は core 段階でマスク（spec 不変条件: 平文が外に出る経路を持たない）
            char: attr.nonDisplay || isControl ? " " : raw,
            kind: cellKindFor(charKind),
            color: attr.color,
            reverse: attr.reverse,
            underline: attr.underline,
            blink: attr.blink,
            columnSeparator: attr.columnSeparator,
            nonDisplay: attr.nonDisplay
          };
          // 生バイトは非マスク SBCS のみ露出（カタカナ再解釈用。パスワードは出さない）
          if (rawByte !== undefined && !attr.nonDisplay) out.rawByte = rawByte;
          rowCells.push(out);
        }
      }
      cells.push(rowCells);
    }

    const fields: Field[] = this.orderedFields().map((f, i) => {
      const { row, col } = this.rowColOf(f.startAddr);
      /**
       * **表示を決めるのは画面上の実効属性であり、SF 記録時の属性バイトではない。**
       * 両者は食い違うことがあり（SEU の F1 ヘルプで実際に hidden=false / セルは nonDisplay=true）、
       * attrByte 側を信じると非表示欄に打った文字がそのまま見えてしまう。
       * セルは描画が従う唯一の真実なので、そこに合わせて真実を一本化する。
       */
      const hidden = cells[row - 1]?.[col - 1]?.nonDisplay ?? this.isFieldHidden(f);
      const shift = f.ffw & FFW.SHIFT_MASK;
      const field: Field = {
        index: i + 1,
        row,
        col,
        length: f.length,
        protected: (f.ffw & FFW.BYPASS) !== 0,
        hidden,
        numeric:
          shift === FFW.SHIFT_NUMERIC_ONLY ||
          shift === FFW.SHIFT_DIGITS_ONLY ||
          shift === FFW.SHIFT_SIGNED_NUMERIC,
        mdt: f.mdt,
        value: hidden ? "" : this.fieldValue(f)
      };
      if (f.dbcsType !== undefined) field.dbcsType = f.dbcsType;
      return field;
    });

    const snap: ScreenSnapshot = {
      sessionId,
      rows: this.rows,
      cols: this.cols,
      cursor: this.rowColOf(this.cursorAddr),
      keyboardLocked,
      cells,
      fields
    };
    if (this.systemMessage !== undefined) snap.systemMessage = this.systemMessage;
    const gui = this.guiSnapshot();
    if (gui) snap.gui = gui;
    return snap;
  }

  /** GUI 構造体を snapshot 用に複製（存在しなければ undefined） */
  private guiSnapshot(): GuiConstructs | undefined {
    if (
      this.guiSelections.length === 0 &&
      this.guiWindows.length === 0 &&
      this.guiScrollBars.length === 0
    ) {
      return undefined;
    }
    return {
      selectionFields: this.guiSelections.map((s) => ({
        ...s,
        choices: s.choices.map((c) => ({ ...c }))
      })),
      windows: this.guiWindows.map((w) => ({ ...w })),
      scrollBars: this.guiScrollBars.map((b) => ({ ...b }))
    };
  }

  /** 選択フィールドの選択状態を更新（web/MCP の選択操作で使う）。id で対象を特定 */
  setSelectionChoice(fieldId: number, choiceIndex: number, selected: boolean): boolean {
    const field = this.guiSelections.find((s) => s.id === fieldId);
    if (!field) return false;
    const choice = field.choices.find((c) => c.index === choiceIndex);
    if (!choice || !choice.available) return false;
    if (field.multiple) {
      choice.selected = selected;
    } else {
      // 単一選択（ラジオ/プッシュボタン/メニュー）: 他を解除
      for (const c of field.choices) c.selected = false;
      choice.selected = selected;
    }
    return true;
  }

  /** 選択フィールドを id で取得（Read 応答の AID 解決用） */
  getSelectionField(fieldId: number): GuiSelectionField | undefined {
    return this.guiSelections.find((s) => s.id === fieldId);
  }

  private checkAddr(addr: number): void {
    if (addr < 0 || addr >= this.size) {
      throw new As400Error("PROTOCOL_ERROR", `buffer address out of range: ${addr}`);
    }
  }
}
