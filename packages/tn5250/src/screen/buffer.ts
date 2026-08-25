import { As400Error } from "@ts5250/base";
import { FFW } from "../protocol/constants.js";
import { GRID_DEFAULT } from "../protocol/wdsf-parser.js";
import type {
  ParsedScrollBar,
  ParsedGridLines,
  ParsedSelectionField,
  ParsedWindow
} from "../protocol/wdsf-parser.js";
import { decodeAttribute, DEFAULT_ATTR } from "./attributes.js";
import {
  attrSentinel,
  rawSentinel,
  isAttrSentinel,
  isRawSentinel,
  sentinelByte
} from "./attr-sentinel.js";
import type {
  Cell,
  CellKind,
  ContinuedPart,
  Field,
  FieldAdjust,
  GuiConstructs,
  GuiScrollBar,
  GuiGridLine,
  GuiSelectionField,
  GuiWindow,
  ScreenSnapshot,
  WriteExtent
} from "./types.js";

/** 書き込み範囲の作業用（レコード適用中に min/max を積む。矩形は確定時に 1 始まりへ直す） */
interface PendingWrite {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
  cells: number;
  cleared: boolean;
  restored: boolean;
}

const newPending = (): PendingWrite => ({
  r1: Infinity,
  r2: -1,
  c1: Infinity,
  c2: -1,
  cells: 0,
  cleared: false,
  restored: false
});

/** 作業用に何か記録されたか。無ければ確定値を触らない（＝前回のレコードの値を残す） */
const pendingHasContent = (p: PendingWrite): boolean => p.cells > 0 || p.cleared || p.restored;

/** 作業用を対外形式へ変換する（矩形は 1 始まり・両端含む） */
const extentOf = (p: PendingWrite): WriteExtent => {
  const e: WriteExtent = { cleared: p.cleared, restored: p.restored, cells: p.cells };
  if (p.cells > 0) e.rect = { row1: p.r1 + 1, row2: p.r2 + 1, col1: p.c1 + 1, col2: p.c2 + 1 };
  return e;
};

/** コーデックがマップできなかったバイトのデコード結果（表示は空白・値はセンチネルで運ぶ） */
const UNDISPLAYABLE = "\uFFFD";

/**
 * 内部セル: 属性バイト or 文字（Unicode）。null = 未設定（既定属性の空白）。
 * charKind は so/si/dbcs-lead/dbcs-tail を保持（既定 sbcs。DBCS の桁位置維持に使う）。
 */
type CharKind = "sbcs" | "so" | "si" | "dbcs-lead" | "dbcs-tail" | "unmappable";
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
  /** 継続入力フィールドの区間の役割（FCW 0x8601/0x8603/0x8602 由来。undefined = 単独欄） */
  continued?: ContinuedPart;
  /** カーソル送り先の欄番号（FCW 0x88nn 由来。undefined = 画面順どおり） */
  cursorProgression?: number;
}

/**
 * FFW の ADJUST（下位 3 ビット）を snapshot の種別へ。
 * **0x0001–0x0004 は予約**（tn5250 `field.h` の `MF_RESERVED_1..4`）なので無指定として扱う。
 */
function adjustOf(ffw: number): FieldAdjust | undefined {
  switch (ffw & FFW.ADJUST_MASK) {
    case FFW.ADJUST_RIGHT_ZERO:
      return "right-zero";
    case FFW.ADJUST_RIGHT_BLANK:
      return "right-blank";
    case FFW.ADJUST_MANDATORY_FILL:
      return "mandatory-fill";
    default:
      return undefined;
  }
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
    case "unmappable":
      return "unmappable";
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
  private guiGridLines: GuiGridLine[] = [];
  private guiIdSeq = 0;
  /** 代替（ワイド）画面の許可サイズ。CLEAR UNIT ALTERNATE で切替える（27x132 端末のみ） */
  private readonly alternate: { rows: 27; cols: 132 } | undefined;

  // --- 書き込み範囲の記録（窓判定の材料。`WriteExtent` の説明を参照） ---
  //
  // **確定値（`committed`）と作業用（`pending`）を分ける。** ホストは「窓を描くレコード」と
  // 「入力を待つだけのレコード」を別々に送ることがあり、毎レコードで素直に上書きすると
  // 後続の書き込み無しレコードで窓が消える。そこで **何も起きなかったレコードは確定値を触らない**。
  private committedWrite: WriteExtent = { cleared: false, restored: false, cells: 0 };
  private pending = newPending();

  constructor(opts: { primary?: "24x80"; alternate?: "27x132" } = {}) {
    this.cells = new Array<InternalCell>(this.rows * this.cols).fill(null);
    if (opts.alternate === "27x132") this.alternate = { rows: 27, cols: 132 };
  }

  /**
   * レコード適用の開始を伝える（`applyDataStream` の入口から呼ぶ）。
   *
   * 直前のレコードで何か起きていれば、ここで確定させてから作業用を作り直す。
   * **確定を行うのはこのメソッドだけ**——読み取り側で確定すると、レコードの途中で
   * 読まれたときに前半の記録が確定へ流れて後半だけが残る（記録が静かに欠ける）。
   */
  beginRecord(): void {
    if (pendingHasContent(this.pending)) this.committedWrite = extentOf(this.pending);
    this.pending = newPending();
  }

  /**
   * 直近レコードの書き込み範囲。
   *
   * **純粋な読み取り**（状態を変えない）。レコード適用の途中で読めば、そこまでに記録された分を返す。
   * まだ何も記録されていなければ前回のレコードの確定値を返す（窓を描くレコードと入力を待つだけの
   * レコードが分かれて届いても窓が消えないようにするため）。
   */
  get lastWrite(): WriteExtent {
    return pendingHasContent(this.pending) ? extentOf(this.pending) : this.committedWrite;
  }

  /** 線形アドレス 1 セルを書き込み範囲へ含める */
  private noteWrite(addr: number): void {
    const p = this.pending;
    const r = Math.floor(addr / this.cols);
    const c = addr % this.cols;
    p.cells++;
    if (r < p.r1) p.r1 = r;
    if (r > p.r2) p.r2 = r;
    if (c < p.c1) p.c1 = c;
    if (c > p.c2) p.c2 = c;
  }

  /**
   * 画面全体のクリアを記録する。
   *
   * **矩形は捨てる**——クリアでセルもサイズも作り直されるため、それ以前の座標は意味を失う
   * （CLEAR UNIT ALTERNATE では桁数まで変わる）。判定側は `cleared` を先に見るので、
   * 同一レコード内でクリア後に書かれた分だけが矩形に残ればよい。
   */
  private noteClear(): void {
    const restored = this.pending.restored;
    this.pending = newPending();
    this.pending.cleared = true;
    this.pending.restored = restored;
  }

  /**
   * 線形範囲 `from..to`（両端含む）を書き込み範囲へ含める。
   *
   * **ループを増やさないため矩形へ畳む。** 行をまたぐ範囲は途中の行を端から端まで通るので
   * 全幅に触れたものとして扱う（外接矩形なのでこれで過不足ない）。
   */
  private noteWriteRange(from: number, to: number): void {
    const p = this.pending;
    const r1 = Math.floor(from / this.cols);
    const r2 = Math.floor(to / this.cols);
    const [c1, c2] = r1 === r2 ? [from % this.cols, to % this.cols] : [0, this.cols - 1];
    p.cells += to - from + 1;
    if (r1 < p.r1) p.r1 = r1;
    if (r2 > p.r2) p.r2 = r2;
    if (c1 < p.c1) p.c1 = c1;
    if (c2 > p.c2) p.c2 = c2;
  }

  get size(): number {
    return this.rows * this.cols;
  }

  /**
   * **文字セル・サイズだけを変更する共通処理。GUI 構造体には触れない——呼び出し側の責任。**
   *
   * `clearUnit()` も `clearUnitAlternate()` も**窓・選択フィールド・スクロールバーは閉じる**
   * （`closeWindowsAndSelections()` を各自で呼ぶ）が、**罫線の扱いだけが違う**:
   *
   * - `clearUnit()`（0x40）は罫線も残す（`closeWindowsAndSelections()` は罫線を触らない）
   * - `clearUnitAlternate()`（0x20）も罫線を残す。CLEAR UNIT ALTERNATE は SFLCTL の
   *   再描画のたびに何度も送られてくる（実機・YB0270R で確認。KSN20 罫線が
   *   「一度描かれた直後に消える」不具合の原因だった）。罫線は WDSF の専用コマンド
   *   （Clear Grid Line Buffer 0x61・GRDATR/GRDLIN 主構造の flag1 bit0 等）で
   *   寿命管理されているので、ここで消す必要はない
   *
   * 罫線ごと消すのは `clearGui()`（REM_ALL_GUI_CONSTRUCTS 専用）だけ。
   * ここでは全員に共通する「文字セル・サイズ」の変更だけを行う。
   */
  private resize(rows: 24 | 27, cols: 80 | 132): void {
    this.rows = rows;
    this.cols = cols;
    this.cells = new Array<InternalCell>(rows * cols).fill(null);
    this.fields = [];
    this.retainedEnds.clear(); // 画面の中身ごと消えるので引き継ぎも捨てる
    this.cursorAddr = 0;
    this.systemMessage = undefined;
  }

  /** GUI 構造体をすべて除去（REM_ALL_GUI_CONSTRUCTS 専用コマンド時） */
  clearGui(): void {
    this.closeWindowsAndSelections();
    this.guiGridLines = [];
  }

  /**
   * **窓・選択フィールド・スクロールバーだけを閉じる（罫線は残す）。**
   *
   * `clearUnit()` から使う。実機（PB1000R）のトレースで、CREATE WINDOW の窓を素の
   * CLEAR UNIT だけで暗黙に閉じることは確認できたが、**罫線（GRDATR/GRDLIN）まで
   * 一緒に消えることは確認していない**。むしろ罫線には専用の寿命管理コマンド
   * （Clear Grid Line Buffer 0x61・項目ごとの erase フラグ）が別にあり、実機トレースでも
   * KSN20 の罫線を描いた**同じ画面構築の中で**後続の（OVERLAY を付けない）レコードの
   * 書き込みが CLEAR UNIT を伴って送られてきた——ここで罫線まで消すと、その画面では
   * 罫線が最終的に一切表示されないことになる（S9R167D で確認: 罫線を描いた直後、
   * 同じレコード内で CLEAR UNIT が来て消えていた）。ACS はこの罫線を表示し続けるため、
   * 窓を閉じる効果と罫線を消す効果を分けた。
   */
  private closeWindowsAndSelections(): void {
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
    // ホストが WDWBORDER で枠を指定していれば持ち回す（無ければクライアント設定の枠）
    if (parsed.border !== undefined) {
      const b = parsed.border;
      win.border = { cba: b.cba, ...(b.chars !== undefined ? { chars: { ...b.chars } } : {}) };
    }
    this.guiWindows.push(win);
    this.blankWindowArea(win);
  }

  /**
   * **窓が占める範囲を空白にする。**
   *
   * ホストは窓の下地を消す指示を**送ってこない**（実機で確認: 背景を書いた後に
   * CREATE WINDOW と窓の中身だけを送る）。消すのは表示装置の仕事で、これをやらないと
   * **窓の中に下の画面が透ける**。実際、背景いっぱいに文字を書いた画面に窓を出すと
   * 窓の中に背景文字が残った（利用者からの報告と同じ症状）。
   *
   * 範囲は枠の矩形（行 `row`〜`row+height+1` / 桁 `col+1`〜`col+width+4`）に、
   * 枠の属性バイトが入る 1 桁（`col`）を足したもの。5250 では属性もセルを 1 つ占めるため、
   * この桁に下地の文字が残ることはない。
   *
   * **消した下地は取っておかない。** 窓を閉じるとき、ホストは
   * RESTORE SCREEN（ESC 0x12）で**画面をまるごと送り直してくる**（実機 GRIDCL7 で確認。
   * 窓を出す前に SAVE SCREEN（ESC 0x02）を送っているのはこのため）。
   * こちらで下地を持って戻すと、ホストが書き直した内容を古い下地で上書きしかねない。
   */
  private blankWindowArea(win: GuiWindow): void {
    const rowEnd = Math.min(this.rows, win.row + win.height + 1);
    const colEnd = Math.min(this.cols, win.col + win.width + 4);
    for (let row = Math.max(1, win.row); row <= rowEnd; row++) {
      for (let col = Math.max(1, win.col); col <= colEnd; col++) {
        this.noteWrite((row - 1) * this.cols + (col - 1));
        this.cells[(row - 1) * this.cols + (col - 1)] = null;
      }
    }
  }

  /**
   * DRAW/ERASE GRID LINES を適用する。
   *
   * `clearBuffer`（主構造 flag1 bit0）と各項目の `erase`（ms_flag1 bit0）で
   * 描画・消去を切り替える。消去は**同じ位置・同じ種別**の項目を取り除く
   * （ホストは引いたときと同じ指定で消しに来るため）。
   */
  applyGridLines(parsed: ParsedGridLines): void {
    if (parsed.clearBuffer) this.guiGridLines = [];
    for (const it of parsed.items) {
      const samePlace = (g: GuiGridLine): boolean =>
        g.row === it.row && g.col === it.col && g.minorType === it.minorType;
      if (it.erase) {
        this.guiGridLines = this.guiGridLines.filter((g) => !samePlace(g));
        continue;
      }
      // 同じ場所への再描画は置き換える（線種・色の変更を反映するため）
      this.guiGridLines = this.guiGridLines.filter((g) => !samePlace(g));
      this.guiGridLines.push({
        id: ++this.guiIdSeq,
        minorType: it.minorType,
        row: it.row,
        col: it.col,
        width: it.width,
        height: it.height,
        // **0xFF は「表示装置の既定」**（DDS リファレンス Table 14/15 の NONE）。
        // 項目が既定を指していれば主構造の値へ、主構造も既定なら実線・白へ倒す。
        lineStyle: it.lineStyle !== GRID_DEFAULT ? it.lineStyle : parsed.defaultLine,
        color: it.color !== GRID_DEFAULT ? it.color : parsed.defaultColor,
        // **未指定（ホストがバイトを送ってこない）は 0 に倒す。** 単独罫線（0x00-0x03）は
        // ScreenGrid.vue が `Math.max(1, value1)` で 1 本に、箱（0x04-0x07）は `value1 > 0` の
        // 判定で内部罫線なしになる——どちらも「繰り返し・間隔を指定しない」の正しい既定値。
        // ここを GRID_DEFAULT（0xFF）のまま渡すと単独罫線が「255 本を 255 間隔で」引かれてしまう
        // （GRDLIN((*TYPE LEFT)) のように繰り返し引数を省略した DSPF で発生。KSN20 で確認）。
        value1: it.value1 !== GRID_DEFAULT ? it.value1 : 0,
        value2: it.value2 !== GRID_DEFAULT ? it.value2 : 0
      });
    }
  }

  /** CLEAR GRID LINE BUFFER（0x61） */
  clearGridLines(): void {
    this.guiGridLines = [];
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

  /**
   * CLEAR UNIT ALTERNATE: 27x132 へ切替えクリア（許可時）。
   *
   * **未許可（24x80 端末）でも罫線は残したままクリアする。** DBCS 端末（SEU 等）は
   * alternate を申告していなくてもこの命令を送ってくる（実機で確認）。S9R167D のような
   * 24x80 専用（`DSPSIZ(24 80 *DS3)`）の SFLCTL(SFLDSPCTL) 画面でも同じことが起こり、
   * 呼び出し側が「未許可なら `clearUnit()` へ倒す」実装だと、`clearUnit()` の `clearGui()` で
   * 罫線（GRDATR/GRDLIN）ごと消えてしまう——`clearUnitAlternate()` 自体を直した A の修正が、
   * 24x80 専用画面では素通しになっていた（KSN20 と同じ共有罫線レコードを使う画面での再発）。
   * 戻り値は「実際に 27x132 へ切り替わったか」を保つ（呼び出し側の警告ログ用）。
   *
   * ## 窓は閉じる（2026-08-25 に直した）
   *
   * ~~GUI 構造体は**一切**残す~~ ← **窓を残すと画面に残骸が出る。実機で再現した。**
   *
   * 元の観測（`20260728-datastream-gui-bugfixes`）で「消えては困る」と分かったのは
   * **罫線だけ**で、窓まで残す必要は一度も観測されていなかった。窓まで残していたのは
   * `closeWindowsAndSelections()` がまだ無く、`clearGui()`（罫線も消す）しか無かったため。
   *
   * 実機で確かめた（2026-08-25・`scripts/host-src/dscmd.c` の `WINCUA`）:
   * DSM に背景 → `CREATE WINDOW`(WDSF 0xD9/0x51) → `CLEAR UNIT ALTERNATE` を順に出させると、
   *
   * ```
   * 受信 04 20 00                          ← CUA
   * 受信 04 11 00 00 11 02 02 …AFTER CUA…  ← ホストは画面を作り直している
   * gui.windows = [{ row: 5, col: 10, width: 20, height: 5, title: "WN" }]  ← **残ったまま**
   * ```
   *
   * ホストは画面を消して別のものを描いているのに、こちらは 20x5 の枠と見出しを描き続ける
   * ——**画面に残骸が出る**。参照実装 2 つ（tn5250 `dbuffer.c` / tn5250j `Screen5250`）も
   * CUA で窓を閉じる。罫線は `closeWindowsAndSelections()` の対象外なので巻き添えにならない。
   */
  clearUnitAlternate(): boolean {
    // **窓・選択フィールド・スクロールバーは閉じる。罫線は残す**（上のコメント）
    this.closeWindowsAndSelections();
    if (!this.alternate) {
      this.resize(24, 80);
      this.noteClear();
      return false;
    }
    this.resize(this.alternate.rows, this.alternate.cols);
    this.noteClear();
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

  /**
   * **フォーマットテーブルを消されたときに引き継ぐ、表示属性の打ち切り位置**（終端アドレス）。
   *
   * 下線・色はフィールド長で打ち切る（`docs/PROTOCOL.md` 4.3。閉じ属性を送らないアプリで
   * 非編集エリアへ漏れるのを防ぐ ACS 準拠の処置）。境界の記録は `fields` だけなので、
   * ホストが窓を重ねるとき SOH でテーブルを消すと（実機の Attn でフィールドが
   * 44 → 2 になる）**画面の中身は変わっていないのに背面の下線が伸びる**。そこで消される直前の
   * 終端をここへ引き継ぐ。
   *
   * **ホストがその行を書き直したら捨てる。** 引き継いだ境界を無条件に持ち続けると、窓が重なった行で
   * 古い境界が生き残り、**窓のタイトル帯の反転が途中で切れる**（実機の PDM ＋ Attn で 29 桁目で
   * 切れていた）。行を書き直すのは「そこのレイアウトはもう別物」という意味なので、その行の
   * 引き継ぎは無効にする。
   */
  private retainedEnds = new Set<number>();

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
    retainedEnds: Set<number>;
    guiSelections: GuiSelectionField[];
    guiWindows: GuiWindow[];
    guiScrollBars: GuiScrollBar[];
    guiGridLines: GuiGridLine[];
  }[] = [];

  /**
   * CLEAR UNIT: 既定サイズ（24x80）でクリアし、窓・選択フィールド・スクロールバーを閉じる。
   *
   * **CLEAR UNIT ALTERNATE（`clearUnitAlternate()`）とは違い、こちらは窓等を閉じる。**
   * 実機（PB1000R）のトレースで、CREATE WINDOW で出した窓を閉じて呼び出し元の
   * 画面へ戻るとき、REM_GUI_WINDOW 等の専用コマンドを送らず、素の CLEAR UNIT だけで
   * 窓を暗黙に消していることを確認した（RESTORE SCREEN で戻る実装もあるが、それとは別の経路）。
   * CLEAR UNIT ALTERNATE 側で GUI を消さないようにしたときと同じ理屈を逆向きに適用している
   * ——各コマンドが実機で実際にどう使われているかで判断するしかない。
   *
   * **罫線（GRDATR/GRDLIN）は `closeWindowsAndSelections()` の説明のとおり対象外**——
   * ここまで一括に `clearGui()` を呼んでいたのは検証していない拡大適用だった。
   */
  clearUnit(): void {
    this.resize(24, 80);
    this.closeWindowsAndSelections();
    // **画面を消したら AID の申告も捨てる**（次の画面の SOH が来るまで「申告なし」＝送る側）。
    // 残すと、申告の無い画面で F12 の欄データを黙って落とすことになる。
    // **CLEAR UNIT ALTERNATE（0x20）では捨てない**——あちらは SFLCTL の再描画のたびに
    // 何度も来る（罫線が消えた不具合と同じ経路）。申告を消すと、その画面の残りの操作で
    // CA キーが CF キーに戻ってしまう。
    this.aidNoDataMask = 0;
    this.noteClear();
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
      retainedEnds: new Set(this.retainedEnds),
      guiSelections: this.guiSelections.map((s) => ({ ...s, choices: s.choices.map((c) => ({ ...c })) })),
      guiWindows: this.guiWindows.map((w) => ({ ...w })),
      guiScrollBars: this.guiScrollBars.map((b) => ({ ...b })),
      guiGridLines: this.guiGridLines.map((g) => ({ ...g }))
    });
  }

  /**
   * ROLL（ESC 0x23）: `top` 行から `bottom` 行までを `lines` 行ぶん送る。
   *
   * `lines > 0` で**上へ**（画面が上にスクロールし、下端に空行ができる）、
   * 負なら下へ。行番号は 1 起点で、範囲外・0 行の指定は何もしない。
   *
   * **フィールド定義は動かさない**——ROLL は表示イメージの移動で、
   * ホストは送った後に必要なら書き直してくる（動かすと入力欄の位置が実機とずれる）。
   */
  roll(top: number, bottom: number, lines: number): void {
    if (lines === 0) return;
    const from = Math.max(1, Math.min(top, this.rows));
    const to = Math.max(1, Math.min(bottom, this.rows));
    if (to <= from) return;
    const count = Math.abs(lines);
    if (count >= to - from + 1) {
      // 範囲を丸ごと超える送りは全消し（残す行が無い）
      for (let row = from; row <= to; row++) this.clearRow(row);
      this.noteWriteRange((from - 1) * this.cols, to * this.cols - 1);
      return;
    }
    const rowsInRange: InternalCell[][] = [];
    for (let row = from; row <= to; row++) {
      rowsInRange.push(this.cells.slice((row - 1) * this.cols, row * this.cols));
    }
    const moved = lines > 0 ? rowsInRange.slice(count) : rowsInRange.slice(0, rowsInRange.length - count);
    const blanks = Array.from({ length: count }, () => new Array<InternalCell>(this.cols).fill(null));
    const next = lines > 0 ? [...moved, ...blanks] : [...blanks, ...moved];
    for (let i = 0; i < next.length; i++) {
      const target = (from - 1 + i) * this.cols;
      for (let c = 0; c < this.cols; c++) this.cells[target + c] = next[i]![c] ?? null;
    }
    this.noteWriteRange((from - 1) * this.cols, to * this.cols - 1);
  }

  private clearRow(row: number): void {
    const base = (row - 1) * this.cols;
    for (let c = 0; c < this.cols; c++) this.cells[base + c] = null;
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
    this.retainedEnds = saved.retainedEnds;
    this.guiSelections = saved.guiSelections;
    this.guiWindows = saved.guiWindows;
    this.guiScrollBars = saved.guiScrollBars;
    this.guiGridLines = saved.guiGridLines;
    // **画面を丸ごと戻したので全画面書き込みとして扱う。** 窓を閉じるときに来る命令なので、
    // これで「窓ではない」と自然に判定される。退避が空（上で false 復帰）なら画面は変わらず、
    // 記録もしない
    this.pending.restored = true;
    this.noteWriteRange(0, this.rows * this.cols - 1);
    return true;
  }

  /**
   * **SOH（0x01）が申告する「欄データを送らない AID キー」の 24 ビット。**
   *
   * ホストは DDS の `CAnn`（コマンド・アテンション）で定義したキーをここへ立てて送る。
   * 立っているキーでは**打鍵した値を 1 バイトも返さない**——`CFnn`（コマンド・ファンクション）
   * との違いはこれだけで、FFW にも SF にも出てこない。
   *
   * ビットの並び（GNU tn5250 `send_data_for_aid_key`、tn5250j `dataIncluded[]` が一致）:
   * ヘッダ本体の 5〜7 バイト目が **F24〜F17 / F16〜F9 / F8〜F1**、各バイトは LSB が小さい番号。
   *
   * 実機（IBM i 7.3・`ASAOLIB/KEYDSPF` の `CA03`/`CA12`/`CF06`）で採った値:
   * `SOH len=7 本体=[00 00 00 18 00 08 04]` → **F3 と F12 だけが立つ**（CF06 は立たない）。
   */
  private aidNoDataMask = 0;

  /**
   * SOH のヘッダ本体を受け取ってマスクを更新する。**7 バイト未満なら申告なし**（0）。
   * 本体は `[フラグ, 予約, 再順序付け, エラー行, マスク×3]`。
   */
  setHeaderData(body: readonly number[] | Uint8Array): void {
    const b = Array.from(body);
    this.aidNoDataMask =
      b.length >= 7 ? ((b[4]! << 16) | (b[5]! << 8) | b[6]!) : 0;
  }

  /**
   * その AID キーで**欄データを送るか**。ホストが申告していないキー（Enter・Help・
   * ロール等）と AID 0（ホスト主導の READ）は常に送る。
   *
   * `keyNumber` は F1〜F24 の番号（それ以外は `undefined`）。
   */
  sendsDataForAid(keyNumber: number | undefined): boolean {
    if (keyNumber === undefined || keyNumber < 1 || keyNumber > 24) return true;
    const group = Math.floor((keyNumber - 1) / 8); // 0=F1〜F8 / 1=F9〜F16 / 2=F17〜F24
    const byte = (this.aidNoDataMask >> (8 * group)) & 0xff;
    return ((byte >> ((keyNumber - 1) % 8)) & 1) === 0;
  }

  /**
   * CLEAR FORMAT TABLE / SOH: 入力の受け皿を消す。
   * **表示属性の打ち切り位置は `retainedEnds` へ引き継ぐ**——画面の中身は変わっていないのに
   * 下線が伸びてしまうため（`retainedEnds` のコメント参照）。
   */
  clearFormatTable(): void {
    for (const f of this.fields) this.retainedEnds.add(f.startAddr + f.length);
    this.fields = [];
  }

  /**
   * その桁を含む行の引き継ぎ境界を捨てる（セル書き込みのたびに呼ぶ）。
   * ホストがその行を書き直したなら、前の画面の欄の終端はもう当てにならない。
   */
  private dropRetainedInRow(addr: number): void {
    if (this.retainedEnds.size === 0) return; // 通常はここで抜ける（走査しない）
    const row = Math.floor(addr / this.cols);
    for (const e of this.retainedEnds) {
      if (Math.floor(e / this.cols) === row) this.retainedEnds.delete(e);
    }
  }

  setChar(addr: number, char: string, rawByte?: number): void {
    this.checkAddr(addr);
    this.noteWrite(addr);
    this.dropRetainedInRow(addr);
    this.cells[addr] = { type: "char", char, charKind: "sbcs", ...(rawByte !== undefined ? { rawByte } : {}) };
  }

  /**
   * 「このコードページでは表せない」とホストが言ってきた桁を置く。
   *
   * **文字は空白**（1 桁を占める）。描き分けは種類（`kind`）でするので、
   * 幅の広い記号を入れて桁をずらす心配が無い——画面は `ch` 単位で桁を置いており、
   * 全角になりうる字（█ 等）を入れると以降の桁が右へずれる（実測で 1.5〜2 倍）。
   *
   * **rawByte は渡さない**（`ORDER.UNKNOWN_1C` と同じ理由）。受信した文字バイトでは
   * ないので、カタカナ表示モードが半角カナへ読み替えてしまう。
   */
  setUnmappable(addr: number): void {
    this.checkAddr(addr);
    this.noteWrite(addr);
    this.dropRetainedInRow(addr);
    this.cells[addr] = { type: "char", char: " ", charKind: "unmappable" };
  }

  /** SO/SI 制御桁を配置（見た目は空白・1 桁占有。DBCS 桁位置維持の要） */
  setShift(addr: number, kind: "so" | "si"): void {
    this.checkAddr(addr);
    this.noteWrite(addr);
    this.dropRetainedInRow(addr);
    this.cells[addr] = { type: "char", char: " ", charKind: kind };
  }

  /** DBCS 1 文字を lead/tail の 2 桁に配置する。
   *  lead/tail の生バイトを保持しておくと、未編集欄の送信でホスト原本の 2 バイトをそのまま戻せる
   *  （SO/SI の空/不整合を含め忠実に送るため。fieldValue の忠実パスが使う）。 */
  setDbcs(addr: number, char: string, lead?: number, tail?: number): void {
    this.checkAddr(addr);
    this.dropRetainedInRow(addr);
    this.checkAddr(addr + 1);
    // 記録は境界チェックの**後**（書けなかったセルを書いたことにしない）
    this.noteWrite(addr);
    this.noteWrite(addr + 1);
    this.cells[addr] = { type: "char", char, charKind: "dbcs-lead", ...(lead !== undefined ? { rawByte: lead } : {}) };
    this.cells[addr + 1] = { type: "char", char: "", charKind: "dbcs-tail", ...(tail !== undefined ? { rawByte: tail } : {}) };
  }

  setAttr(addr: number, byte: number): void {
    this.checkAddr(addr);
    this.noteWrite(addr);
    this.dropRetainedInRow(addr);
    this.cells[addr] = { type: "attr", byte };
  }

  /** from から to まで（両端含む・線形）を null（既定空白）にする */
  eraseRange(from: number, to: number): void {
    this.checkAddr(from);
    this.checkAddr(to);
    this.noteWriteRange(from, to);
    this.dropRetainedInRow(from);
    this.dropRetainedInRow(to);
    for (let i = from; i <= to; i++) this.cells[i] = null;
  }

  /** SF オーダー: フィールド定義（attrByte は startAddr-1 に書かれた属性バイト） */
  addField(
    startAddr: number,
    length: number,
    ffw: number,
    attrByte: number,
    dbcsType?: "pure" | "open" | "either",
    continued?: ContinuedPart,
    cursorProgression?: number
  ): void {
    this.checkAddr(startAddr);
    if (length < 1 || startAddr + length > this.size) {
      throw new As400Error("PROTOCOL_ERROR", `field out of range: start=${startAddr}, len=${length}`);
    }
    // 同一開始アドレスの再定義は置換（画面再送で二重登録しない）
    this.fields = this.fields.filter((f) => f.startAddr !== startAddr);
    // 新しい欄が占める範囲に掛かる引き継ぎ境界は捨てる（その場所はもう別レイアウト）
    for (const e of this.retainedEnds) {
      if (e > startAddr && e <= startAddr + length) this.retainedEnds.delete(e);
    }
    this.fields.push({
      startAddr,
      length,
      ffw,
      attrByte,
      mdt: (ffw & FFW.MDT) !== 0,
      ...(dbcsType !== undefined ? { dbcsType } : {}),
      ...(continued !== undefined ? { continued } : {}),
      ...(cursorProgression !== undefined ? { cursorProgression } : {})
    });
  }

  /** 画面順のフィールド一覧（1 始まり index はこの順） */
  orderedFields(): readonly InternalField[] {
    return [...this.fields].sort((a, b) => a.startAddr - b.startAddr);
  }

  /**
   * **継続入力フィールドの区間の並び**（先頭 → 最終）を、その並びに属する任意の区間から得る。
   * 単独欄（`continued === undefined`）を渡したら自分 1 つだけを返す。
   *
   * ホストは区間を**画面順に連続して**送ってくる（5494 Functions Reference が「そう並ぶ」と
   * 決めている。GNU tn5250 `session.c` も「連続していて他の欄が混ざらない」前提で歩く）ので、
   * 画面順の前後をたどるだけで並びが決まる。
   *
   * MDT の集約（`setFieldValue`）と送信の連結（`read-response.ts`）が共通で使う。
   */
  continuedRun(field: InternalField): readonly InternalField[] {
    if (field.continued === undefined) return [field];
    const ordered = this.orderedFields();
    let i = ordered.indexOf(field);
    if (i < 0) return [field];
    // 先頭区間まで戻る（tn5250 `field.c` tn5250_field_set_mdt / tn5250j `ScreenField.setMDT` と同じ歩き方）。
    // ホストが先頭を送り損ねた壊れた並びでも、継続でない欄に当たったら止めて無限に戻らない。
    while (i > 0 && ordered[i]?.continued !== "first" && ordered[i - 1]?.continued !== undefined) i--;
    const run: InternalField[] = [];
    for (let j = i; j < ordered.length; j++) {
      const f = ordered[j];
      if (f === undefined || f.continued === undefined) break;
      if (j > i && f.continued === "first") break; // 次の継続欄の始まり＝この並びは終わり
      run.push(f);
      if (f.continued === "last") break;
    }
    return run.length > 0 ? run : [field];
  }

  /**
   * カーソルを最初の入力可能（非 bypass）フィールドの先頭へ置く。
   *
   * 5250 では WTD に IC/MC が無い場合、カーソルは最初の入力フィールドに着く。
   * これを行わないとカーソルが原点（1,1）に残り、**AID レコードで報告する
   * カーソル位置が実機とずれる**。IBM i のヘルプ（F1）はカーソル位置依存で、
   * フィールド上でなければ「拡張ヘルプ」経路になり、ホストがウィンドウではなく
   * 別サイズのヘルプ画面を出そうとする（日本語実機の PDM F1 で確認）。
   */
  cursorToFirstInputField(): void {
    const first = this.orderedFields().find((f) => (f.ffw & FFW.BYPASS) === 0);
    if (first !== undefined) this.cursorAddr = first.startAddr;
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
      // **センチネル文字は埋め込み属性セルとして書く**——値の中で属性が編集に追従して動いた
      // 位置に、その属性バイトのセルを置き直す（桁ずれ・色ずれ・送信での破壊を防ぐ）。
      if (ch !== undefined && isAttrSentinel(ch)) {
        this.cells[field.startAddr + i] = { type: "attr", byte: sentinelByte(ch) };
      } else if (ch !== undefined && isRawSentinel(ch)) {
        // 表示できない SBCS バイト。生バイトを保ったまま置き直す（送信で元に戻る）
        this.cells[field.startAddr + i] = {
          type: "char",
          char: UNDISPLAYABLE,
          charKind: "sbcs",
          rawByte: sentinelByte(ch)
        };
      } else {
        this.cells[field.startAddr + i] = ch !== undefined ? { type: "char", char: ch, charKind: "sbcs" } : null;
      }
    }
    // **継続入力フィールドの MDT は先頭区間だけに立てる。**
    // 送信は「先頭区間の位置に全区間の連結値を 1 つ」なので（GNU tn5250 `session.c`
    // tn5250_session_send_field）、中間・最終にも立てると同じ塊を何度も送ることになる。
    // 逆に中間だけ編集したときは先頭に立て直さないと**その編集が 1 バイトも送られない**
    // （実機で確認: 中間区間だけ 07 に変えると `000/00/07` になり月がホストへ届かなかった）。
    // tn5250 `field.c` tn5250_field_set_mdt と tn5250j `ScreenField.setMDT` も同じ畳み方をする。
    const first = this.continuedRun(field)[0] ?? field;
    first.mdt = true;
  }

  /**
   * 欄の現在値。**末尾の空白は落とす**（5250 の送信仕様）。
   *
   * `keepTrailingBlanks` は**符号付き数値欄の符号桁を見るため**にある。符号桁（最終桁）は
   * 空白か `-` で、落としてしまうと「正なのか、そもそも短いのか」が区別できない。
   * 送信変換（`read-response.ts`）だけがこれを使う。
   *
   * **未編集 DBCS 欄の経路（`dbcsRawFieldValue`）には効かない。** 符号付き数値欄が DBCS に
   * なることは無いので実害は無いが、他の用途で使うときはここを見ること。
   */
  fieldValue(field: InternalField, keepTrailingBlanks = false): string {
    // **未編集の DBCS 欄はホスト原本のバイト列をセンチネルでそのまま返す**。SO/SI の空（{}）や
    // 不整合（{ だけ・} だけ）も、全角ランからの再構成では表せず落ちてしまうため、生バイトを
    // 保持して送信時にそのまま戻す。編集された欄（setFieldValue が SBCS セルに書き換える＝
    // 構造セルが無い）は従来どおり論理値を返し、codec.encode が SO/SI を付け直す。
    if (field.dbcsType !== undefined && this.hasDbcsStructure(field)) {
      return this.dbcsRawFieldValue(field);
    }
    // **SBCS 欄の埋め込み属性はセンチネル文字で返す**（値の中で識別・移動できるように）。
    // DBCS 欄は SO/SI・2 バイトの都合でセンチネルを混ぜると送信エンコードが壊れるため空白のまま。
    // **DBCS 欄かどうかでの分岐はもう無い。** 属性も生バイトもセンチネルで返し、
    // 送信側（read-response）が生バイト 1 つとして書き戻す——これが round-trip の要。
    let s = "";
    for (let i = 0; i < field.length; i++) {
      const c = this.cells[field.startAddr + i];
      if (c?.type === "char") {
        // **表示できないバイトもセンチネルで返す（DBCS 欄も同じ）**。U+FFFD のまま返すと、
        // その欄を編集して送信した時点でエンコード不能となり SUB（0x3F）に化けて元のデータを壊す。
        //
        // **DBCS 欄を除外してはいけない。** 編集後の DBCS 欄は `setFieldValue` によって
        // 全セルが「生バイトを持つ SBCS セル」になっており（構造セルが無いのでここへ来る）、
        // 除外すると SO/SI・全角のバイトがそろって U+FFFD → SUB に化ける。
        // 実機の SEU（TESTLIB/QJPNTEST）で確認: `AB<attr>SO 設通 SI CD` を 1 文字編集して
        // 保存すると `3F E7 28 3F 3F …` になり、**日本語が全部潰れた**。
        s += c.char === UNDISPLAYABLE && c.rawByte !== undefined
          ? rawSentinel(c.rawByte)
          : c.char;
      // **埋め込み属性はセンチネルで返す（DBCS 欄も同じ）。**
      // 空白で返すと `setFieldValue` の書き戻しでただの文字セルに潰され、
      // 送信データからも制御コードが落ちる＝**利用者のソースが書き換わる**。
      // 送信側（read-response）はセンチネルを生バイト 1 つとして書き、前後を別 run で
      // encode するので、DBCS 欄でも SO/SI の整合は保たれる（属性は SBCS モードの 1 バイト）。
      } else if (c?.type === "attr") s += attrSentinel(c.byte);
      else s += " ";
    }
    return keepTrailingBlanks ? s : s.replace(/ +$/, "");
  }

  /** 欄が SO/SI・DBCS の構造セルを持つ（＝ホストが描いた原本のまま。setFieldValue 後は全 SBCS）。 */
  private hasDbcsStructure(field: InternalField): boolean {
    for (let i = 0; i < field.length; i++) {
      const c = this.cells[field.startAddr + i];
      if (
        c?.type === "char" &&
        (c.charKind === "so" || c.charKind === "si" || c.charKind === "dbcs-lead" || c.charKind === "dbcs-tail")
      ) {
        return true;
      }
    }
    return false;
  }

  /** 未編集 DBCS 欄をセルの生バイトから忠実に復元する（SO/SI の実位置・空・不整合をそのまま保持）。
   *  戻り値のセンチネルは read-response が生バイトで書き出す。末尾ブランクは現行同様に落とす。 */
  private dbcsRawFieldValue(field: InternalField): string {
    const SO_BYTE = 0x0e;
    const SI_BYTE = 0x0f;
    // 末尾のブランク桁（空セル・EBCDIC 空白）を落とす。SO/SI・DBCS の構造桁は残す（末尾の { なども保つ）。
    let end = field.length;
    while (end > 0 && this.isTrailingBlankCell(this.cells[field.startAddr + end - 1])) end--;
    let s = "";
    for (let i = 0; i < end; i++) {
      const c = this.cells[field.startAddr + i];
      if (c?.type === "char") {
        switch (c.charKind) {
          case "so":
            s += rawSentinel(SO_BYTE);
            break;
          case "si":
            s += rawSentinel(SI_BYTE);
            break;
          case "dbcs-tail":
            s += c.rawByte !== undefined ? rawSentinel(c.rawByte) : "";
            break;
          // dbcs-lead / sbcs: 生バイトがあればそのまま、無ければ文字（フィル空白等）を codec に委ねる
          default:
            s += c.rawByte !== undefined ? rawSentinel(c.rawByte) : c.char;
            break;
        }
      } else if (c?.type === "attr") {
        s += attrSentinel(c.byte);
      } else {
        s += " ";
      }
    }
    return s;
  }

  /** 末尾トリム対象の空白桁か（空セル・生バイト無しの空白・EBCDIC 空白 0x40）。構造桁は対象外。 */
  private isTrailingBlankCell(c: InternalCell | undefined): boolean {
    if (c == null) return true;
    if (c.type !== "char") return false; // 属性桁は残す
    if (c.charKind === "so" || c.charKind === "si" || c.charKind === "dbcs-lead" || c.charKind === "dbcs-tail") {
      return false;
    }
    return (c.char === " " || c.char === "") && (c.rawByte === undefined || c.rawByte === 0x40);
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

  /**
   * CC1: 非 bypass フィールドの内容を null 化する（onlyMdt=true なら MDT の立つものだけ）。
   *
   * **ここは書き込み範囲（`WriteExtent`）に数えない。** 入力欄は画面中に散っているので、
   * 数えると矩形が全画面へ膨らみ、窓を描く WTD が CC1 を伴った場合に**本物の窓を弾いてしまう**。
   * 「数えるべき」と言える実データが無い以上、安全側（数えない）に倒す。
   * これは欄の状態リセットであって、ホストが「そこへ描いた」わけではない、という整理でもある。
   */
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
    // 打ち切り位置＝現在の欄の終端 ＋ SOH で消される前から引き継いだ終端
    const fieldEnds = new Set<number>(this.retainedEnds);
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
            // **属性バイトを載せる。** これが無いと web-ui が編集の種値を作るときに
            // 属性をセンチネルへ戻せず、桁を空白で潰してしまう（logicalFromCells）。
            rawByte: cell.byte,
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
      const adjust = adjustOf(f.ffw);
      if (adjust !== undefined) field.adjust = adjust;
      if (shift === FFW.SHIFT_SIGNED_NUMERIC) field.signedNumeric = true;
      if (shift === FFW.SHIFT_DIGITS_ONLY) field.digitsOnly = true;
      if (shift === FFW.SHIFT_ALPHA_ONLY) field.alphaOnly = true;
      if (shift === FFW.SHIFT_IO) field.keyboardInhibited = true;
      // **SHIFT_KATAKANA（0x0400）は入力制限ではない**（キーボードのシフト状態）。
      // GNU tn5250 は "KATAKANA not implemented" として素通しし、tn5250j も alpha/num-shift と
      // 同じ枝で無条件に許可する。制限だと誤解して弾かないこと。
      if ((f.ffw & FFW.MONOCASE) !== 0) field.monocase = true;
      if ((f.ffw & FFW.FIELD_EXIT_REQUIRED) !== 0) field.fieldExitRequired = true;
      if ((f.ffw & FFW.AUTO_ENTER) !== 0) field.autoEnter = true;
      if ((f.ffw & FFW.MANDATORY_ENTER) !== 0) field.mandatoryEnter = true;
      if ((f.ffw & FFW.DUP_ENABLE) !== 0) field.dupEnable = true;
      if (f.dbcsType !== undefined) field.dbcsType = f.dbcsType;
      // 区間をまたぐカーソル移動・Field Exit を web-ui / MCP が組み立てるために出す
      if (f.continued !== undefined) field.continued = f.continued;
      // カーソル送り（FLDCSRPRG）。移動を組み立てるのは UI 側
      if (f.cursorProgression !== undefined) field.cursorProgression = f.cursorProgression;
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
    snap.lastWrite = { ...this.lastWrite };
    if (snap.lastWrite.rect) snap.lastWrite.rect = { ...snap.lastWrite.rect };
    return snap;
  }

  /** GUI 構造体を snapshot 用に複製（存在しなければ undefined） */
  private guiSnapshot(): GuiConstructs | undefined {
    if (
      this.guiSelections.length === 0 &&
      this.guiWindows.length === 0 &&
      this.guiScrollBars.length === 0 &&
      this.guiGridLines.length === 0
    ) {
      return undefined;
    }
    return {
      selectionFields: this.guiSelections.map((s) => ({
        ...s,
        choices: s.choices.map((c) => ({ ...c }))
      })),
      windows: this.guiWindows.map((w) => ({ ...w })),
      scrollBars: this.guiScrollBars.map((b) => ({ ...b })),
      gridLines: this.guiGridLines.map((g) => ({ ...g }))
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
