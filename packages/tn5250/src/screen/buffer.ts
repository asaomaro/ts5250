import { As400Error, isFullWidth } from "@ts5250/base";
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
  isSplitLead,
  isSplitTail,
  splitLeadChar,
  keepIndex,
  isRawSentinel,
  sentinelByte
} from "./attr-sentinel.js";
import type {
  Cell,
  CellKind,
  ContinuedPart,
  DbcsFieldType,
  SelfCheckKind,
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
/** 空きの桁（NUL）を運ぶセンチネル（語送りの欄の値。`fieldValue`・`setFieldValue`） */
const NUL_SENTINEL = rawSentinel(0x00);

/**
 * 内部セル: 属性バイト or 文字（Unicode）。null = 未設定（既定属性の空白）。
 * charKind は so/si/dbcs-lead/dbcs-tail を保持（既定 sbcs。DBCS の桁位置維持に使う）。
 */
type CharKind = "sbcs" | "so" | "si" | "dbcs-lead" | "dbcs-tail" | "unmappable";
export type InternalCell =
  | { type: "attr"; byte: number }
  | {
      type: "char";
      char: string;
      charKind: CharKind;
      rawByte?: number;
      /**
       * **ワイヤへ書き戻すときの元バイト。表示には使わない。**
       *
       * `rawByte` は表示（カタカナ表示モードの再解釈）にも使われるので、そこへ載せると
       * 化ける値がある——オーダー 0x1C / 0x1E はその例で、受信した文字バイトではなく
       * オーダー自身の識別バイトなのに半角カナとして読み直されてしまう
       * （`wtd-applier.ts` の `ORDER.UNKNOWN_1C` の注記）。
       *
       * 一方 ACS は `PS5250.addChar()` が 0x1C をそのまま `HostPlane` に入れ、
       * READ SCREEN 応答（`DS5250.processReadScreen` が `getBuffer()`＝`HostPlane` を返す）で
       * **0x1C のまま送る**（`20260920-restore-screen-parity` research F3・F4）。
       * 表示と送信で要る値が違うので、送信用だけをここに分けて持つ。
       */
      hostByte?: number;
      /**
       * **死んだ桁**（ACS の DBCSPlane 8。継続した O 欄の編集が区間の終わりに残す、字を置けない桁）。バイトとしては NUL（`cellAt` は null を返す）だが、
       * 次の詰め直しで**捨てられる**（空きと違って中身にならない）。ホストが画面を書き直さない限り AID のあとも残る（実機の ACS のコア
       * `scripts/acs-probe/cont-o-dead-kept.txt`）。書き込み・消去でセルごと置き換わって消える
       */
      dead?: true;
    }
  | null;

/**
 * `restoreScreen()` の結果。
 *
 * `payload` は **SAVE 応答としてこちらが送った本体**（`ESC 0x12` の後ろ）。ホストは RESTORE で
 * それをそのまま返してくるので、呼び出し側（`wtd-applier`）は**同じバイト列が続いていれば
 * その長さぶん読み飛ばす**——読み飛ばさないと、自分が送った WTD を「次のコマンド」として
 * 適用し、打鍵と MDT を潰す（`20260920-restore-screen-parity` decisions D2・research F10）。
 */
export interface RestoreResult {
  restored: boolean;
  payload?: Uint8Array;
  /** 退避した画面が待っていた READ のコマンドバイト（ACS `Save5250Net.SavePendingRead`） */
  readCommand?: number;
  /** 退避の時点で READ が出ていたか（ACS の `pending_read` が 0 でないか。RESTORE で戻す。`20260927-sysreq-line-hold`） */
  readOutstanding?: boolean;
}

/**
 * **E 欄に書いた値から、全角・半角のどちらの状態になったかを記録する**（`InternalField.eitherDbcsOn`）。
 * 決めるのは空白でない最初の字（未編集の DBCS 欄の値は SO のセンチネルで始まる）。空白だけなら状態を変えない
 * ——ACS は欄を空にしても状態を保つので、空の値は「切り替えた」ことを表さない
 */
function noteEitherMode(field: InternalField, chars: readonly string[]): void {
  for (const ch of chars) {
    if (ch === " ") continue;
    if (isRawSentinel(ch)) {
      field.eitherDbcsOn = sentinelByte(ch) === 0x0e;
      return;
    }
    field.eitherDbcsOn = isFullWidth(ch);
    return;
  }
}

export interface InternalField {
  startAddr: number;
  length: number;
  ffw: number;
  /** フィールド直前の属性バイト（hidden 判定に使う） */
  attrByte: number;
  mdt: boolean;
  /** DBCS フィールド種別（FCW 由来。undefined = SBCS） */
  dbcsType?: DbcsFieldType;
  /** 自己点検欄の検査方式（FCW 0xB140/0xB1A0 由来。undefined = 検査なし） */
  selfCheck?: SelfCheckKind;
  /** 継続入力フィールドの区間の役割（FCW 0x8601/0x8603/0x8602 由来。undefined = 単独欄） */
  continued?: ContinuedPart;
  /** カーソル送り先の欄番号（FCW 0x88nn 由来。undefined = 画面順どおり） */
  cursorProgression?: number;
  /** **再順序付けの次の欄の番号**（FCW 0x80nn の nn。0xFF で鎖の終わり。ACS `Field5250.nextResequence`）。立つときだけ付与 */
  nextResequence?: number;
  /** **透過の欄**（FCW 0x84xx 由来。ACS `Field5250.transparentField`）。送るときにヌルも符号も加工せず生のバイトで送る。立つときだけ付与 */
  transparent?: boolean;
  /**
   * **語送りの欄**（FCW 0x8680 由来。DDS の `WRDWRAP`）。打鍵・削除のあと、行末で語を次の行へ送る（ACS `PS5250.processWordWrap`。web-ui の `wordWrap.ts`）。
   * 欄が 1 行に収まるとき・継続欄は立てない（ACS `Field5250` は行に収まる欄では `WrapField` を下ろす）。立つときだけ付与。
   * 語送りは空きの桁（NUL）を語の間の詰め物に使うので、この欄の値は**途中の NUL と実空白を区別して**返す（`fieldValue`）
   */
  wordWrap?: boolean;
  /**
   * **E（either）欄がいま全角（DBCS）の状態か**（ACS `Field5250.EitherFieldDBCSOn`。`20260927-either-field-mode`）。
   * 欄の中身から毎回求める値ではなく**欄ごとに持ち続ける状態**——ACS は欄を消しても SO/SI を残して DBCS のままにする。
   * 立つのはホストが欄の先頭に SO/SI を書いたとき（`setShift`）と、全角で始まる値を書いたとき（`setFieldValue`）。
   * 下りるのは半角で始まる値を書いたときだけ。同じ位置の欄の定義し直し（SF）では残り、CLEAR UNIT で欄の表ごと捨てたときに消える
   */
  eitherDbcsOn?: boolean;
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

/**
 * **位置の一致する最初の 1 つだけを外す**（ACS `removeGUISelectionField` / `removeGUIScrollBarField` / `removeGUIWindow` は番地の一致する最初の構造体だけ。
 * 一致が無ければ何もしない。`20260928-wdsf-behaviour`）。~~一致が無ければ全除去（ホストが位置無指定で再構築する場合に対応）~~——ACS に無い推測だった
 */
function removeByPos<T extends { row: number; col: number }>(list: T[], row: number, col: number, match: (g: T) => boolean = () => true): T[] {
  const i = list.findIndex((g) => g.row === row && g.col === col && match(g));
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
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
  /**
   * **WRITE ERROR CODE が届くたびに増える通し番号**（`systemMessage` と対）。同じ文言のエラーが
   * もう一度来たことを UI が見分けるため——ACS はホストのエラーのたびにエラー状態に入る
   * （`DS5250.processWriteErrorCode` → `setErrorMode(true)`。`20260921-host-error-mode`）。
   * 画面バッファを作り直しても重ならないよう、番号はプロセスで通しにする（`nextSystemMessageSeq`）。
   */
  systemMessageSeq: number | undefined;
  /** WRITE ERROR CODE のメッセージを重ねる位置（`ScreenSnapshot.systemMessageArea`）。届くたびに上書きする（0x21 はメッセージ行の 1 行全体） */
  systemMessageArea: { row: number; col: number; width: number } | undefined;
  /**
   * SOH が申告したメッセージ行の行番号（1 基点）。申告が無ければ最下行（ACS `DS5250` は初期値・`processClearFMT` で画面の行数にする。`resetMsgLineRow`）。
   * `systemMessage` をいつ捨てるかの判定（`clearSystemMessageIfTouched`）と WRITE ERROR CODE の位置（`systemMessageArea`）に使う
   */
  private msgLineRow = 24;
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

  /**
   * **いま適用中のレコードが、画面を書いた（クリア・復元を含む）か。**`lastWrite` と違い、何も書かなかったレコードでは前回の確定値ではなく
   * `false` を返す（応答だけのレコード——WSF・READ SCREEN 系——が画面イベントを出すかの判定用。
   * `20260921-negative-responses` の節目 10 の独立点検 A-S1 の関連）。純粋な読み取り
   */
  get wroteInThisRecord(): boolean {
    return pendingHasContent(this.pending);
  }

  /** 線形アドレス 1 セルを書き込み範囲へ含める */
  private noteWrite(addr: number): void {
    const p = this.pending;
    const r = Math.floor(addr / this.cols);
    const c = addr % this.cols;
    this.clearSystemMessageIfTouched(r, r);
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
    this.clearSystemMessageIfTouched(r1, r2);
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
   * ~~罫線ごと消すのは `clearGui()`（REM_ALL_GUI_CONSTRUCTS 専用）だけ~~——ACS は 0x5F でも罫線を残す（`removeAllGuiConstructs`）。罫線を消すのは 0x60 の消去の指定・0x61 の矩形・窓
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
    this.dropCursorOrders();
  }

  /**
   * **最後に作った窓**の番号（ACS `ENPTUI5250.enpwindow`）。作るたびに替わり、その窓を消す・窓を全部閉じると無くなる（前の窓には戻らない）。
   * 退避と復元で持ち回る（ACS の退避を挟んだ後の `enpwindow` は未確認）
   */
  private currentWindowId: number | undefined;

  /**
   * **直近の窓のカーソル制限を外す**（WDSF 0x52。ACS `ENPTUI5250.unrestrictWindowCursor` は `enpwindow`＝最後に作った窓に掛ける）。その窓が無ければ何もしない
   */
  unrestrictWindowCursor(): void {
    const w = this.guiWindows.find((x) => x.id === this.currentWindowId);
    if (w) w.restrictCursor = false;
  }

  /**
   * **REMOVE ALL GUI CONSTRUCTS（0x5F）**: 窓・選択欄・スクロール・バーを外す。**罫線は残す**（ACS `ENPTUI5250.removeAllGUIConstructs` は罫線の置き場に触らない。
   * 実機の ACS のコア・DSM の GRIDLIFE の G5。`20260928-grid-window-hole`）。~~罫線ごと消す（`clearGui`）~~
   */
  removeAllGuiConstructs(): void {
    this.closeWindowsAndSelections();
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
    this.currentWindowId = undefined;
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
    this.currentWindowId = win.id;
    this.blankWindowArea(win);
    // **窓の範囲の罫線を消す**（ACS `ENPTUIWindow.draw` の `clearGridBuf`: 窓の位置から幅＋6 桁・深さ＋2 行。実機の ACS のコアで、罫線の箱の上辺のうち
    // 窓の範囲の 26 桁が罫線の面から消えた——DSM の GRIDLIFE の G4・`scripts/acs-probe/grid-lifetime.txt`）。当 PJ の罫線は線の単位なので、範囲を穴として持たせる
    const hole = { row, col, width: parsed.width + 6, height: parsed.height + 2 };
    for (const g of this.guiGridLines) g.holes = [...(g.holes ?? []), hole];
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
      // （同じ場所への再描画は新しい線として置き換わるので、前の線の穴は引き継がない——ACS も置き場へ書き直す）
    }
  }

  /**
   * **CLEAR GRID LINES（0x61）の矩形**（1 始まり）を、それまでの罫線の穴にする（ACS `processClearGrid` は置き場の矩形だけを 0 にする。窓の穴と同じ扱い——`GuiGridLine.holes`）
   */
  clearGridRect(rect: { row: number; col: number; width: number; height: number }): void {
    for (const g of this.guiGridLines) g.holes = [...(g.holes ?? []), rect];
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

  /**
   * **REMOVE GUI WINDOW（0x59）**（ACS `ENPTUI5250.removeGUIWindow`）: フラグ 0x40 は引き下げの窓、0x00 は普通の窓だけを外す（ほかの値・種類の違う窓は何もしない）。
   * 外した窓の範囲（位置から幅＋6 桁・深さ＋2 行）にすっかり入っている選択欄・スクロール・バーも外す。実機の ACS のコア（DSM の WDSFBEH の W3・W4）:
   * 普通の窓に 0x40 ではカーソルの制限が残り、0x00 では外れた。~~フラグを見ずに外す~~
   */
  removeWindow(row: number, col: number, flag = 0x00): void {
    if (flag !== 0x00 && flag !== 0x40) return;
    const win = this.guiWindows.find((w) => w.row === row && w.col === col && w.pulldown === (flag === 0x40));
    if (!win) return;
    // 最後に作った窓を消したら「直近の窓」は無くなる（ACS `removeWindow` は `enpwindow` を null にし、前の窓には戻さない）——
    // 番号で引くので、消えた窓の番号が残っていても何にも当たらない（番号は使い回さない）
    this.guiWindows = this.guiWindows.filter((w) => w !== win);
    const top = win.row, left = win.col, bottom = win.row + win.height + 1, right = win.col + win.width + 5;
    const inside = (r0: number, c0: number, r1: number, c1: number): boolean => r0 >= top && c0 >= left && r1 <= bottom && c1 <= right;
    this.guiSelections = this.guiSelections.filter((g) => !inside(g.row, g.col, g.row, g.col));
    this.guiScrollBars = this.guiScrollBars.filter((g) => !inside(g.row, g.col, g.row, g.col));
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
    // SOH の CA キーの申告も捨てる（ACS `processClearFMT`。`clearUnit` の注記）
    this.aidNoDataMask = 0;
    this.cursorInputOnly = false;
    this.resequenceFirst = 0;
    this.dropCursorOrders();
    if (!this.alternate) {
      this.resize(24, 80);
      this.resetMsgLineRow();
      this.noteClear();
      return false;
    }
    this.resize(this.alternate.rows, this.alternate.cols);
    this.resetMsgLineRow();
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
    currentWindowId: number | undefined;
    guiScrollBars: GuiScrollBar[];
    guiGridLines: GuiGridLine[];
    /**
     * **SOH の CA マスクも退避する**（ACS `Save5250Net.SaveSOH_Byte5/6/7`）。
     * 戻さないと、窓・ヘルプから戻った画面で `CAnn` の申告が消え、**F12 が欄データを送ってしまう**
     * （`sendsDataForAid()` が「申告なし＝送る」に倒れるため）。
     */
    aidNoDataMask: number;
    cursorInputOnly: boolean;
    resequenceFirst: number;
    /** メッセージ行の行番号（ACS `Save5250Net.SaveSOH_msgline_num`）。 */
    msgLineRow: number;
    /**
     * **IC で指された番地**（ACS `Save5250Net.SaveWTD_IC_addr`。ホーム位置 `SaveHomePos` も同じ値から出る）。
     * 戻さないと、窓を開いて F12 で戻った画面に**窓の IC が残り**、ホーム位置が窓を指し、後続の IC 無しの WTD で
     * カーソルが窓の位置へ飛ぶ（節目の独立点検の指摘。`icAddr` をレコードをまたいで持ち越すようにした
     * `20260921-cursor-per-wtd-acs` との組み合わせで出た）。MC は ACS も退避しない
     */
    icAddr: number | undefined;
    /**
     * **退避の時点でセッション層が持っていたもの**（応答を組んだ直後に `attachSaveContext()` が入れる）。
     *
     * - `payload`: SAVE 応答として送った本体（`ESC 0x12` の後ろ＝WTD ストリーム）。
     *   ホストはこれを不透明な保管物として預かり、RESTORE でそのまま返してくる。
     *   **こちらは積荷を読まずローカルのスタックから戻す**ので、返ってきた積荷を
     *   「次のコマンド」として解釈しないよう読み飛ばす。その長さがここ（decisions D2・D10）。
     * - `readCommand`: 退避した画面が待っていた READ のコマンドバイト
     *   （ACS `Save5250Net.SavePendingRead`）。
     *
     * **セッション層の値もこの 1 本のスタックに入れる。** 別に持つとスタックの段数が
     * 2 か所で管理され、早期 return や例外でずれる
     * （`20260920-restore-screen-parity` の cross 点検で実測）。
     * ACS も `Save5250Net` 1 つに画面と入力状態をまとめて入れている（research F1）。
     */
    saved: { payload: Uint8Array; readCommand: number; readOutstanding: boolean } | undefined;
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
    this.row1col0Attr = undefined;
    this.closeWindowsAndSelections();
    // **画面を消したら AID の申告も捨てる**（次の画面の SOH が来るまで「申告なし」＝送る側）。
    // 残すと、申告の無い画面で F12 の欄データを黙って落とすことになる。
    // ~~**CLEAR UNIT ALTERNATE（0x20）では捨てない**——あちらは SFLCTL の再描画のたびに
    // 何度も来る（罫線が消えた不具合と同じ経路）。申告を消すと、その画面の残りの操作で
    // CA キーが CF キーに戻ってしまう。~~ → 実測の裏の無い判断だった。ACS は CU・CUA・CFT のどれでも捨てる
    // （`processClearFMT` → `clearSOHPFKeyTable`）。実機の ACS のコアで、SOH（F3 を CA）の後に CUA か CFT が来ると F3 が欄を送った
    // （`scripts/acs-probe/clear-ca-mask.txt`。`20260927-clear-ca-mask`）。ホストが画面を作り直すときに SOH を送り直すかは未確認
    this.aidNoDataMask = 0;
    this.cursorInputOnly = false;
    this.resequenceFirst = 0;
    this.resetMsgLineRow();
    this.noteClear();
  }

  /** 指定アドレスのセル（未書き込みは null）。SAVE SCREEN 応答の直列化で使う */
  cellAt(addr: number): InternalCell {
    this.checkAddr(addr);
    const c = this.cells[addr] ?? null;
    return c !== null && c.type === "char" && c.dead === true ? null : c; // 死んだ桁はバイトとしては NUL
  }

  /**
   * 退避して**その段の深さ**（1 起点）を返す。
   *
   * 深さを返すのは、退避の文脈を後から添える `attachSaveContext()` が
   * **どの段に添えるかを取り違えないため**。退避はコマンドごと（`wtd-applier`）に起こるのに、
   * 応答を組み立てるのはレコードを流し終えた後（`Session5250.handleRecord`）なので、
   * 1 レコードに SAVE が 2 回入ると「スタックの頂点」では先の段に添えられない
   * （`20260920-restore-screen-parity` の T4 独立点検で実測。2 段目の RESTORE で積荷が
   * 適用され、欠陥が無警告で再発した）。
   */
  saveScreen(): number {
    this.savedStack.push({
      rows: this.rows,
      cols: this.cols,
      cells: this.cells.map((c) => (c === null ? null : { ...c })),
      fields: this.fields.map((f) => ({ ...f })),
      cursorAddr: this.cursorAddr,
      retainedEnds: new Set(this.retainedEnds),
      guiSelections: this.guiSelections.map((s) => ({ ...s, choices: s.choices.map((c) => ({ ...c })) })),
      guiWindows: this.guiWindows.map((w) => ({ ...w })),
      currentWindowId: this.currentWindowId,
      guiScrollBars: this.guiScrollBars.map((b) => ({ ...b })),
      guiGridLines: this.guiGridLines.map((g) => ({ ...g })),
      // ACS は `Save5250Net.saveInformation()` で CA マスク（SOH 5〜7 バイト目）と
      // メッセージ行番号も退避する。同じものを積む（`20260920-restore-screen-parity` research F1）
      aidNoDataMask: this.aidNoDataMask,
      cursorInputOnly: this.cursorInputOnly,
      resequenceFirst: this.resequenceFirst,
      msgLineRow: this.msgLineRow,
      icAddr: this.icAddr,
      // 応答を組み立てた直後に `attachSaveContext()` が埋める（まだ作られていない）
      saved: undefined
    });
    return this.savedStack.length;
  }

  /**
   * **`saveScreen()` が返した段に、退避の時点のセッション層の値を添える。**
   *
   * 応答を組み立てるのはセッション層（`buildSaveScreenResponse`）なので、`saveScreen()` の時点では
   * まだ本体が無い。組み立てた直後にここへ渡し、RESTORE でホストが返してきた積荷を
   * **長さで読み飛ばす**ために使う（`20260920-restore-screen-parity` decisions D2）。
   *
   * **段は「頂点」ではなく番号で指す。** 1 レコードに SAVE が 2 回入ると、応答を組むのは
   * レコードを流し終えた後なので、頂点に添えると先の段が空のまま残る（同 work の T4 独立点検で実測）。
   * その段が既に復元されて消えていれば何もしない（呼び順に依存させない）。
   *
   * ⚠ **`depth` は位置であって同一性ではない。** 1 レコードに SAVE → RESTORE → SAVE が入ると
   * 同じ深さが別の段を指す。いまは「同じ深さへの最後の attach が勝つ」ので結果は合うが、
   * 順序に依らない形にするなら単調増加のトークンにする（`20260920-restore-screen-parity` review ラウンド 1）。
   */
  attachSaveContext(depth: number, ctx: { payload: Uint8Array; readCommand: number; readOutstanding: boolean }): void {
    const entry = this.savedStack[depth - 1];
    if (entry === undefined) return;
    entry.saved = ctx;
  }

  /**
   * ROLL（ESC 0x23）: `top` 行から `bottom` 行までを `lines` 行ぶん送る。
   *
   * `lines > 0` で**上へ**（画面が上にスクロールする）、負なら下へ。行番号は 1 起点。
   *
   * **空いた行は消さない——旧い内容が残る**（ACS `PS5250.processRoll` は行を写すだけ。`20260921-roll-vacated-rows`）。
   * 実機（DSM の `QsnRollUp(3,2,20)`）で、ACS のコアは空いた 18〜20 行に元の 18〜20 行を残した（下ロールでも 2〜4 行が残る）。
   * ~~下端に空行ができる~~——当 PJ は以前ここを空白にしていた。
   *
   * **不正な指定は何もしない**（ACS と同じ条件: 上端が 0・下端が画面の外・下端 ≦ 上端・行数 ＞ 下端−上端）。ACS はここで
   * センス・コードを立ててレコードの処理を打ち切り、負応答を返す——~~当 PJ は負応答をまだ返さない（台帳「DS5250 のその他の差」）ので、
   * 画面を変えないところまで合わせた~~ → 否定応答 0x1005012C と打ち切りは `wtd-applier.ts` が行う（`20260921-negative-responses`）。
   * ~~範囲を丸ごと超える送りは全消し~~。
   *
   * **フィールド定義は動かさない**——ROLL は表示イメージの移動で、
   * ホストは送った後に必要なら書き直してくる（動かすと入力欄の位置が実機とずれる）。
   * @returns 指定が正しく、処理したか
   */
  roll(top: number, bottom: number, lines: number): boolean {
    const count = Math.abs(lines);
    if (top === 0 || bottom > this.rows || bottom <= top || count > bottom - top) return false;
    if (count === 0) return true;
    const src: InternalCell[][] = [];
    for (let row = top; row <= bottom; row++) src.push(this.cells.slice((row - 1) * this.cols, row * this.cols));
    const span = bottom - top + 1 - count; // 写す行の数
    for (let i = 0; i < span; i++) {
      // 上へ: 上端から順に count 行下の内容を写す / 下へ: count 行下へ、上端からの内容を写す
      const dst = lines > 0 ? i : i + count;
      const from = lines > 0 ? i + count : i;
      const base = (top - 1 + dst) * this.cols;
      for (let c = 0; c < this.cols; c++) this.cells[base + c] = src[from]![c] ?? null;
    }
    this.noteWriteRange((top - 1) * this.cols, bottom * this.cols - 1);
    return true;
  }

  /** RESTORE SCREEN（ESC 0x12）: 直近の退避を復元 */
  restoreScreen(): RestoreResult {
    const saved = this.savedStack.pop();
    if (!saved) return { restored: false };
    this.rows = saved.rows;
    this.cols = saved.cols;
    this.cells = saved.cells;
    this.fields = saved.fields;
    this.cursorAddr = saved.cursorAddr;
    this.retainedEnds = saved.retainedEnds;
    this.guiSelections = saved.guiSelections;
    this.guiWindows = saved.guiWindows;
    this.currentWindowId = saved.currentWindowId;
    this.guiScrollBars = saved.guiScrollBars;
    this.guiGridLines = saved.guiGridLines;
    // CA マスクとメッセージ行番号も戻す（ACS `Save5250Net.restoreNetNulls`）。
    // 戻さないと窓・ヘルプから戻った画面で `CAnn` の申告が消える
    this.aidNoDataMask = saved.aidNoDataMask;
    this.cursorInputOnly = saved.cursorInputOnly;
    this.resequenceFirst = saved.resequenceFirst;
    this.msgLineRow = saved.msgLineRow;
    this.icAddr = saved.icAddr; // ACS `restoreNetNulls` の `WTD_IC_addr`・`homePos`
    // **画面を丸ごと戻したので全画面書き込みとして扱う。** 窓を閉じるときに来る命令なので、
    // これで「窓ではない」と自然に判定される。退避が空（上で false 復帰）なら画面は変わらず、
    // 記録もしない
    this.pending.restored = true;
    this.noteWriteRange(0, this.rows * this.cols - 1);
    return {
      restored: true,
      ...(saved.saved !== undefined
        ? { payload: saved.saved.payload, readCommand: saved.saved.readCommand, readOutstanding: saved.saved.readOutstanding }
        : {})
    };
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
   * 実機（IBM i 7.3・`TESTLIB/KEYDSPF` の `CA03`/`CA12`/`CF06`）で採った値:
   * `SOH len=7 本体=[00 00 00 18 00 08 04]` → **F3 と F12 だけが立つ**（CF06 は立たない）。
   */
  private aidNoDataMask = 0;
  /**
   * **SOH のフラグ 0x10（DDS の `CSRINPONLY`）: 矢印のカーソルを入力欄だけに動かす**（ACS `FFT5250.setCursorMoveToInput`・`moveCursorToInput`。`20260927-key-edit-rest`）。
   * 動かすのは画面の側（矢印の行き先を入力欄へ寄せる）。CLEAR 系・CFT・SOH で下ろし（`clearFormatTable`・`clearUnit`・`clearUnitAlternate`）、SOH で読み直す。SAVE / RESTORE で退避・復元する
   */
  private cursorInputOnly = false;

  /**
   * **再順序付けの先頭の欄の番号**（SOH の本体 3 バイト目。0 = 再順序付けなし。ACS `FFT5250.firstResequence`。`20260928-resequence`）。
   * READ の応答の欄の並びを、この欄から FCW 0x80nn の番号を辿る鎖にする（`readMdtFields`・`readInputFields`）。CLEAR 系・CFT・SOH で 0 に戻す（ACS `processClearFMT`）
   */
  resequenceFirst = 0;

  /**
   * SOH のヘッダ本体を受け取ってマスクを更新する。**7 バイト未満なら申告なし**（0）。
   * 本体は `[フラグ, 予約, 再順序付け, エラー行, マスク×3]`。
   */
  setHeaderData(body: readonly number[] | Uint8Array): void {
    const b = Array.from(body);
    this.aidNoDataMask =
      b.length >= 7 ? ((b[4]! << 16) | (b[5]! << 8) | b[6]!) : 0;
    // 本体 1 バイト目のフラグ 0x10＝カーソルを入力欄だけに動かす（ACS の SOH 分岐は長さ 1 以上ならこのバイトを見る）
    this.cursorInputOnly = b.length >= 1 && (b[0]! & 0x10) !== 0;
    // **CSRINPONLY は直近の窓の制限を外す**（ACS `FFT5250.setCursorMoveToInput(true)` が `unrestrictWindowCursor()` を呼ぶ——一時的な回避ではなく窓の印を下ろす）
    if (this.cursorInputOnly) this.unrestrictWindowCursor();
    // 本体 3 バイト目は再順序付けの先頭の欄の番号（ACS の SOH 分岐は長さ 3 以上ならこのバイトを採る）
    this.resequenceFirst = b.length >= 3 ? b[2]! : 0;
    // **本体 4 バイト目はメッセージ行の行番号**（ACS `DS5250` の SOH 分岐が
    // `data[i+5]`＝本体 4 バイト目を、1〜画面行数 の範囲でだけ `SOH_msgline_num` に採るのと同じ）。
    // `systemMessage` の寿命判定（`clearSystemMessageIfTouched`）と WRITE ERROR CODE の位置（`systemMessageArea`）に使う。
    // 申告が無い・範囲外なら、SOH が直前に呼ぶ `clearFormatTable` で最下行に戻っている（呼ぶ順に依存する。`20260926-wec-msgline-row` decisions D5）
    const msgRow = b[3];
    if (msgRow !== undefined && msgRow > 0 && msgRow <= this.rows) this.msgLineRow = msgRow;
  }

  /**
   * **メッセージ行へ書き込んだらシステム・メッセージは消える。**
   *
   * ACS は WRITE ERROR CODE の本文を**メッセージ行のセルそのもの**へ書く
   * （`DS5250.processWriteErrorCode` が `SOH_msgline_num` の行を書く）ので、後続の画面が
   * その行を書き替えれば自然に消える。こちらは本文を画面に描かず `systemMessage` として
   * 別に持つ設計なので、同じ寿命になるようここで明示的に捨てる。
   *
   * これが無いと、PA0100R で PageUp が「前ページはありません。」を出したあと F12 で前画面へ
   * 戻っても、ホストがメッセージ行を消去（`EA`）しているのにメッセージが残り続ける
   * （利用者報告。ACS では残らない）。
   */
  private clearSystemMessageIfTouched(rowFrom: number, rowTo: number): void {
    if (this.systemMessage === undefined) return;
    // **メッセージを出した行で判定する**（ACS は本文をその行のセルへ書くので、消えるのは書いた行）。
    // いまの `msgLineRow` で見ると、出した後の SOH・CLEAR FORMAT TABLE で最下行へ戻ったとき、表示している行とずれる
    // （`20260926-wec-msgline-row` の cross 点検。decisions D6。最下行へ戻すのは D5）
    const row = (this.systemMessageArea?.row ?? this.msgLineRow) - 1; // 0 基点
    if (rowFrom <= row && row <= rowTo) this.systemMessage = undefined;
  }

  /**
   * **メッセージ行の行番号**（1 起点。SOH のヘッダ本体 4 バイト目。ACS `DS5250.SOH_msgline_num`）。
   *
   * 読み取り専用で公開しているのは、**退避・復元の往復を副作用なく検査できるようにするため**。
   * 以前は「システム・メッセージがどの行で消えるか」を試すプローブで間接的に測っていたが、
   * 画面を書き換えるうえ呼ぶ順に依存し、**検査が空振りしていた**
   * （`20260920-restore-screen-parity` review ラウンド 4 の must）。
   */
  get messageLineRow(): number {
    return this.msgLineRow;
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
  clearFormatTable(kind: "cft" | "soh" = "cft"): void {
    for (const f of this.fields) this.retainedEnds.add(f.startAddr + f.length);
    this.fields = [];
    // **ENPTUI の構造体も捨てる**（ACS `processClearFMT` → `FFT5250.clearFFT` → `ENPTUI5250.clearENPTUIConstructs`。`20260927-ds5250-clear`）:
    // CLEAR FORMAT TABLE は窓・選択欄・スクロール・バーのすべて、SOH は**窓だけ残して**選択欄・スクロール・バーを捨てる（`clearFFT(false)`）。
    // 以前はどちらも残し、CFT の後も窓が残り、SOH の後にホストが同じ選択欄を定義し直すと二重になっていた（台帳の実測）。罫線は触らない（`closeWindowsAndSelections`）
    if (kind === "cft") this.closeWindowsAndSelections();
    else {
      this.guiSelections = [];
      this.guiScrollBars = [];
    }
    // SOH の CA キーの申告も捨てる（ACS `processClearFMT` → `clearSOHPFKeyTable`。CFT でも。SOH はこの後で申告し直す）
    this.aidNoDataMask = 0;
    this.cursorInputOnly = false;
    this.resequenceFirst = 0;
    this.dropCursorOrders();
    this.resetMsgLineRow();
  }

  /**
   * **メッセージ行を最下行に戻す**（ACS `DS5250.processClearFMT` が `SOH_msgline_num` を画面の行数に戻すのと同じ。
   * CLEAR UNIT / CLEAR UNIT ALTERNATE / CLEAR FORMAT TABLE / SOH の入口で通る。`20260926-wec-msgline-row` decisions D5）。
   * 以前は 24 で固定し、戻しもしなかった——27×132 では最下行（27）ではなく 24 行に出し、前の画面の SOH の申告も残り続けた
   */
  private resetMsgLineRow(): void {
    this.msgLineRow = this.rows;
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

  /**
   * 1 桁に SBCS 文字を置く。
   *
   * **任意の 2 つは役割が違う。取り違えても型は通るので注意すること**:
   * - `rawByte` — **ホストが送ってきた文字バイト**。表示（カタカナ表示モードの読み替え）と
   *   送信（画面イメージ応答・SAVE 応答）の両方で使う。ホスト発の SBCS にだけ渡す。
   * - `hostByte` — **送信にだけ使う元バイト**。受信した文字バイトではないもの
   *   （オーダー 0x1C / 0x1E の識別バイト・`UNMAPPABLE`）に渡す。`InternalCell.hostByte` の注記を参照。
   */
  setChar(addr: number, char: string, rawByte?: number, hostByte?: number): void {
    this.checkAddr(addr);
    this.noteWrite(addr);
    this.dropRetainedInRow(addr);
    this.cells[addr] = {
      type: "char",
      char,
      charKind: "sbcs",
      ...(rawByte !== undefined ? { rawByte } : {}),
      ...(hostByte !== undefined ? { hostByte } : {})
    };
  }

  /**
   * 「このコードページでは表せない」とホストが言ってきた桁を置く。
   * `hostByte` は**送信にだけ使う元バイト**（表示には使わない。`setChar` の注記を参照）。
   *
   * **文字は空白**（1 桁を占める）。描き分けは種類（`kind`）でするので、
   * 幅の広い記号を入れて桁をずらす心配が無い——画面は `ch` 単位で桁を置いており、
   * 全角になりうる字（█ 等）を入れると以降の桁が右へずれる（実測で 1.5〜2 倍）。
   *
   * **rawByte は渡さない**（`ORDER.UNKNOWN_1C` と同じ理由）。受信した文字バイトでは
   * ないので、カタカナ表示モードが半角カナへ読み替えてしまう。
   */
  setUnmappable(addr: number, hostByte?: number): void {
    this.checkAddr(addr);
    this.noteWrite(addr);
    this.dropRetainedInRow(addr);
    // **`hostByte` はワイヤへ書き戻すときだけ使う**（表示には使わない＝カタカナ表示モードが
    // 半角カナへ読み替えるのを避ける。`rawByte` を渡さない理由と同じ）。
    // ACS は `PS5250.addChar()` が受信したバイトをそのまま `HostPlane` に入れ、
    // READ SCREEN 応答で返す（`20260920-restore-screen-parity` research F3・F4）ので、
    // 渡さないと**ヘルプ本文の桁が 3 経路すべてで空白に化ける**（同 work の cross 点検）
    this.cells[addr] = {
      type: "char",
      char: " ",
      charKind: "unmappable",
      ...(hostByte !== undefined ? { hostByte } : {})
    };
  }

  /** SO/SI 制御桁を配置（見た目は空白・1 桁占有。DBCS 桁位置維持の要） */
  setShift(addr: number, kind: "so" | "si"): void {
    this.checkAddr(addr);
    this.noteWrite(addr);
    this.dropRetainedInRow(addr);
    this.cells[addr] = { type: "char", char: " ", charKind: kind };
    // ホストが E 欄の先頭に SO/SI を書いたら、その欄は全角の状態になる（ACS `PS5250` の表示データの書き込み）
    const f = this.fields.find((x) => x.startAddr === addr && x.dbcsType === "either");
    if (f) f.eitherDbcsOn = true;
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

  /**
   * **欄を空にする（MDT はそのまま）**（ACS `PS5250.eraseField_Work` の MDT を立てない形。WDSF 0x54 の書き込みの前）。継続欄は鎖の全区間。
   * J 欄・全角の状態の E 欄は両端の 1 桁（SO・SI）を残す（ACS の 1 桁の内側）
   */
  eraseFieldCells(field: InternalField): void {
    const inset = field.dbcsType === "only" || (field.dbcsType === "either" && field.eitherDbcsOn === true) ? 1 : 0;
    const run = field.continued === undefined ? [field] : this.continuedRun(field);
    for (const f of run) {
      const from = f.startAddr + inset;
      const to = f.startAddr + f.length - 1 - inset;
      if (to >= from) this.eraseRange(from, to);
    }
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

  /**
   * **継続欄の区間の順**（ACS `FFT5250.contFieldSegment`）。先頭・中間を受けた後は最終まで持ち、最終で `undefined` に戻る。
   * 欄の表を消しても戻さない（ACS も `clearFFT` で触らない）。`wtd-applier.ts` の `fieldAddFailure` が読む
   */
  continuedSegment: ContinuedPart | undefined;

  /**
   * **同じ位置の欄の FFW だけを書き換える**（ACS `FFT5250.checkNewField` の `setFFW`。長さ・FCW・E 欄の全角の状態は前のまま）。`20260927-wtd-sense-rest`
   */
  updateFieldFfw(f: InternalField, ffw: number, attrByte: number): void {
    f.ffw = ffw;
    f.attrByte = attrByte;
    f.mdt = (ffw & FFW.MDT) !== 0;
  }

  /**
   * **ACS `FFT5250.checkNewField`**: 欄の表を入れた順に見て、`start` に始まる欄か、`start` より後ろに始まる欄（継続欄の中間・最終を除く）の
   * 最初の 1 つを返す。見つかれば ACS は新しい欄を作らない（同じ位置なら FFW だけ書き換える）
   */
  checkNewField(start: number): InternalField | undefined {
    for (const f of this.fields) {
      if (f.startAddr === start) return f;
      if (f.startAddr <= start || f.continued === "middle" || f.continued === "last") continue;
      return f;
    }
    return undefined;
  }

  /**
   * **1 行 1 桁の前（番地 -1）に置かれた属性**（SBA 1,0 の後の SF。ACS `PS5250.setAttributeToPlanes` の `row1col0ext` ほか）。
   * 桁を占めず、画面の先頭から効く（`snapshot` が最初の属性にする）。CLEAR UNIT で捨てる。`20260927-wtd-sense-rest`
   */
  row1col0Attr: number | undefined;

  /** 表にある欄の数（ACS は 600 欄で打ち止め） */
  fieldCount(): number {
    return this.fields.length;
  }

  /** SF オーダー: フィールド定義（attrByte は startAddr-1 に書かれた属性バイト）。同じ位置・後ろの欄の扱いは呼び出し側が `checkNewField` で決める */
  addField(
    startAddr: number,
    length: number,
    ffw: number,
    attrByte: number,
    dbcsType?: DbcsFieldType,
    continued?: ContinuedPart,
    cursorProgression?: number,
    selfCheck?: SelfCheckKind,
    transparent = false,
    nextResequence?: number,
    wordWrap = false
  ): void {
    this.checkAddr(startAddr);
    if (length < 1 || startAddr + length > this.size) {
      throw new As400Error("PROTOCOL_ERROR", `field out of range: start=${startAddr}, len=${length}`);
    }
    // 同じ位置の再定義はここへ来ない——`wtd-applier.ts` の `applySf` が `checkNewField` で見て FFW だけ書き換える（ACS `setFFW`）。
    // E 欄の全角の状態もそれで残る（以前はここで置き換えて `keepEither` で引き継いでいた。`20260927-wtd-sense-rest` decisions D3）。念のため重複は除く
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
      ...(cursorProgression !== undefined ? { cursorProgression } : {}),
      ...(selfCheck !== undefined ? { selfCheck } : {}),
      ...(transparent ? { transparent } : {}),
      ...(nextResequence !== undefined ? { nextResequence } : {}),
      ...(wordWrap ? { wordWrap } : {})
    });
  }

  /**
   * その番地が**純 DBCS の欄（G。FCW 0x8220）の中**か。G の欄のデータは **SO/SI 無しの 2 バイト組**で届く（実機の DDS の G 型で確かめた。
   * ホストは欄の前後を WEA 0x12 0x05 0x81／0x80 で挟む。ACS は SF の受理で欄の全桁を DBCS の対として印付ける〔`addFieldToFFT`〕ので、
   * 欄の中に置かれたバイトは組で読まれる）。`20260921-g-field-sosi`
   */
  isPureDbcsAt(addr: number): boolean {
    return this.fields.some((f) => f.dbcsType === "pure" && addr >= f.startAddr && addr < f.startAddr + f.length);
  }

  /** 画面順のフィールド一覧（1 始まり index はこの順） */
  orderedFields(): readonly InternalField[] {
    return [...this.fields].sort((a, b) => a.startAddr - b.startAddr);
  }

  /**
   * SOH 等でフォーマットテーブルが消える前から引き継いだフィールド終端（read-only）。
   *
   * `snapshot()` の属性打ち切りが使うのと同じ集合を、READ SCREEN / READ SCREEN EXTENDED
   * の応答（`save-screen.ts` の `fieldEndAttrAddrs`）にも渡すためのアクセサ。**生きている
   * `fields` だけを見ていると、窓を重ねる過程で SOH がフィールドを消した直後にホストが
   * READ SCREEN を要求してきたとき、消えたフィールドの終端に閉じ属性を含められない**
   * ——応答を受け取ったホストがそれをそのまま「現在の画面」として描き直すため、下線・色が
   * 本来の欄を越えて伸びたまま**ホスト側のデータとして焼き込まれてしまう**（利用者報告:
   * SEU で F4 窓を開いた状態で F1 ヘルプ窓を開くと、窓の外の背面に下線が漏れる）。
   */
  retainedFieldEnds(): ReadonlySet<number> {
    return this.retainedEnds;
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

  // **`cursorToFirstInputField()` はここにあった**が撤去した（src から呼ばれなくなった）。READ のときに先頭の入力欄へ
  // 寄せる役は、WTD の終わりに既定の位置（ホーム）へ置く `placeCursorAfterWtd` に移った（`20260921-cursor-per-wtd-acs`）。
  // 既定の位置は下の `homeAddr()`。

  /**
   * **既定の位置（ホーム）**: 最初の非 bypass 欄の先頭。**欄が無ければ 0（1 行 1 桁）**
   * （ACS `PS5250.setDefaultInsertCursor` → `homePos`。`20260921-cursor-per-wtd-acs`）。
   */
  homeAddr(): number {
    return this.orderedFields().find((f) => (f.ffw & FFW.BYPASS) === 0)?.startAddr ?? 0;
  }

  /**
   * **WTD の IC / MC で指された番地**（ACS `DS5250.WTD_IC_addr` / `WTD_MC_addr`。`20260921-cursor-per-wtd-acs`）。
   * **レコードをまたいで持ち越し、書式を消すときだけ捨てる**（CLEAR UNIT・CLEAR UNIT ALTERNATE・CLEAR FORMAT TABLE・
   * SOH＝ACS `processClearFMT`）。IC は MC を捨てる。どこへ置くかは WTD の終わりに決める（`wtd-applier.ts` の
   * `placeCursorAfterWtd`）。
   */
  icAddr: number | undefined;
  mcAddr: number | undefined;
  /** 書式を消したので IC / MC も捨てる（ACS `processClearFMT` の `WTD_IC_addr = -1; WTD_MC_addr = -1`） */
  private dropCursorOrders(): void {
    this.icAddr = undefined;
    this.mcAddr = undefined;
  }

  // **`cursorIsUnenterable()`／`isEnterableAt()` はここにあった**が撤去した
  // （`.aidev/works/20260915-pr387-acs-premise-unverified`）。どちらも
  // `session.ts` の旧 `PR#387` 分岐（「動いていない・いま保護化された」を検知
  // して先頭入力欄へ上書きする判定）専用のヘルパーで、その分岐自体を撤去した
  // ため呼び出し元が無くなった。撤去の理由は `decisions.md` D2 参照
  // ——ACS のデコンパイル済みコアにこの上書きに相当するロジックが見当たらず、
  // かつ「ACS がそう動く」という前提自体、実際に ACS を動かして検証された
  // 記録が無かったため。

  fieldByIndex(index1: number): InternalField {
    const f = this.orderedFields()[index1 - 1];
    if (!f) throw new As400Error("FIELD_NOT_FOUND", `field #${index1} not found`);
    return f;
  }

  /**
   * **明示の並びの値を構造どおりのセルへ置く**（`setFieldValue` から）。桁が欄を越えれば FIELD_OVERFLOW（値の長さは出さない）。
   * MDT は `setFieldValue` と同じく並びの先頭の区間に立てる
   */
  private setFieldCells(field: InternalField, value: string): void {
    const cells: (InternalCell | null)[] = [];
    // O 欄（継続の鎖も継続でないものも）は空き（NUL）と空白が別: 空白は中身（生バイト 0x40。末尾も落とさない）、空きは U+0000
    const chain = field.dbcsType === "open" || field.dbcsType === "either"; // E も（半角の状態の空白は中身。`20260930-either-half-space`）
    let inShift = false;
    let lead: number | undefined; // 並びの中の生バイトは 2 つで全角 1 字（未編集の原本の書き戻し）
    for (const ch of value) {
      if (isRawSentinel(ch)) {
        const b = sentinelByte(ch);
        if (b === 0x0e || b === 0x0f) {
          // 組にならなかった前半の生バイトは捨てずに 1 セルで置く（ACS のセルも割れたバイトをそのまま持つ）
          if (lead !== undefined) cells.push({ type: "char", char: UNDISPLAYABLE, charKind: "sbcs", rawByte: lead });
          cells.push({ type: "char", char: " ", charKind: b === 0x0e ? "so" : "si" });
          inShift = b === 0x0e;
          lead = undefined;
        } else if (b === 0x00 && lead === undefined) {
          // 死んだ桁（ACS の DBCSPlane 8）・J と全角の E の欄の空の組（ACS は SO と SI の間を NUL の組で持つ——`20260928-je-field-shape`）は、バイトとしては NUL——
          // 空のセルに置く（送信で途中の NUL は空白、ALT では NUL のまま）。継続した O 欄の鎖の死んだ桁は、詰め直しで捨てる印を保つ
          cells.push(field.dbcsType === "open" && field.continued !== undefined ? { type: "char", char: " ", charKind: "sbcs", dead: true } : null);
        } else if (inShift && lead === undefined) lead = b;
        else if (inShift) {
          cells.push({ type: "char", char: UNDISPLAYABLE, charKind: "dbcs-lead", rawByte: lead! }, { type: "char", char: "", charKind: "dbcs-tail", rawByte: b });
          lead = undefined;
        } else cells.push({ type: "char", char: UNDISPLAYABLE, charKind: "sbcs", rawByte: b });
      } else if (isAttrSentinel(ch)) cells.push({ type: "attr", byte: sentinelByte(ch) });
      // 区間の間で割れた全角の半分（継続した O 欄。前半は区間の最後の桁の前半セル・後半は次の区間の頭の後半セル。送信は前半の字を 2 バイトに符号化し、後半は空）
      else if (isSplitLead(ch)) cells.push({ type: "char", char: splitLeadChar(ch), charKind: "dbcs-lead" });
      else if (isSplitTail(ch)) {
        cells.push({ type: "char", char: "", charKind: "dbcs-tail" });
        inShift = true; // 前の区間から続く並びの中（この区間に SO は無い）。続く全角は 2 セル
      }
      // **U+0000 は空きの桁（NUL）**。O 欄の値が運ぶ（web-ui の `OCell.nul`）。空のセルに置く
      else if (ch === "\u0000") cells.push(null);
      // 並びの中でも全角だけを 2 セルにする。半角（NUL を空白にした桁など）は 1 セル——2 セルにすると桁が倍になる（独立レビューの指摘）
      else if (inShift && isFullWidth(ch)) {
        cells.push({ type: "char", char: ch, charKind: "dbcs-lead" }, { type: "char", char: "", charKind: "dbcs-tail" });
      } else {
        // **継続した O 欄の鎖の空白は中身**（0x40。生バイトを持たせて、空きの桁〔NUL〕と見分けられるようにする——web-ui の `logicalFromCells`）
        cells.push({ type: "char", char: ch, charKind: "sbcs", ...(chain && ch === " " ? { rawByte: 0x40 } : {}) });
      }
    }
    // 末尾の半角空白（編集の詰め物）は空のセルにする（ACS は空きを NUL のまま持ち、送るときに末尾の NUL を落とす）。
    // **O 欄は除く**——空きは NUL（U+0000）で運ぶので、末尾の空白は打った・ホストが書いた中身（ACS は末尾の 0x40 を送る。C09・C10、`space-typed.txt`）
    while (!chain && cells.length > 0) {
      const last = cells[cells.length - 1]!;
      if (last !== null && last.type === "char" && last.charKind === "sbcs" && last.char === " ") cells.pop();
      else break;
    }
    if (cells.length > field.length) {
      const { row, col } = this.rowColOf(field.startAddr);
      throw new As400Error("FIELD_OVERFLOW", `field at (${row},${col}) accepts at most ${field.length} bytes`);
    }
    for (let i = 0; i < field.length; i++) this.cells[field.startAddr + i] = cells[i] ?? null;
    (this.continuedRun(field)[0] ?? field).mdt = true;
  }

  /**
   * **非表示の DBCS 欄の、触らない桁の目印を元の中身へ戻す**（`keepNarrow`・`keepWide`。中身をブラウザへ出さないので、編集した値には目印が載って届く）。
   * 目印が指す桁が欄の外・空きなら空白にする。非表示でない欄の値はそのまま（目印は通常の字ではないので、あとの検証が弾く）
   */
  mergeKeep(field: InternalField, value: string): string {
    if (![...value].some((c) => keepIndex(c) !== undefined) || !this.isFieldHidden(field)) return value;
    let out = "";
    for (const ch of value) {
      const k = keepIndex(ch);
      if (k === undefined) {
        out += ch;
        continue;
      }
      const c = k.idx < field.length ? this.cells[field.startAddr + k.idx] : undefined;
      if (c == null || c.type !== "char") {
        out += k.wide ? "\u3000" : " ";
        continue;
      }
      if (k.wide) {
        const tail = this.cells[field.startAddr + k.idx + 1];
        out += c.char === UNDISPLAYABLE && c.rawByte !== undefined ? rawSentinel(c.rawByte) + rawSentinel(tail?.type === "char" ? (tail.rawByte ?? 0x40) : 0x40) : c.char;
      } else out += c.char === UNDISPLAYABLE && c.rawByte !== undefined ? rawSentinel(c.rawByte) : c.char;
    }
    return out;
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
  setFieldValue(field: InternalField, value: string, skipCharLengthCheck = false, opts?: { eitherDbcsOn?: boolean }): void {
    if ((field.ffw & FFW.BYPASS) !== 0) {
      const { row, col } = this.rowColOf(field.startAddr);
      throw new As400Error("FIELD_PROTECTED", `field at (${row},${col}) is protected`);
    }
    // **明示の並び（SO/SI の印を含む値。O 欄の編集——`20260928-o-field-cells`）はセルを構造どおりに置く**:
    // 印は SO/SI のセル、全角は前半・後半の 2 セル、ほかは 1 セル、残りは空（NUL）。ホストが書いた DBCS の欄と同じ形になり、
    // 送信は未編集の DBCS の欄と同じ道（`dbcsRawFieldValue`・`rawDbcsSendValue`。ACS で実測済みの規則）を通る
    // （欄の種類は問わない——ホストが A 型の欄に置いた SO/SI 入りの原本〔snapshot の `dbcsContent`〕も同じ形で戻る）
    // 継続した O 欄の**死んだ桁の印**（0x00。`20260928-cont-o-cells`）も明示の並び——半角だけの区間の後ろにも残る（継続していない欄には出ない）
    const marks = (c: string): boolean =>
      isSplitLead(c) || isSplitTail(c) || isRawSentinel(c) && (sentinelByte(c) === 0x0e || sentinelByte(c) === 0x0f || (sentinelByte(c) === 0x00 && field.dbcsType === "open" && field.continued !== undefined));
    if ([...value].some(marks)) {
      this.setFieldCells(field, value);
      if (field.dbcsType === "either") {
        if (opts?.eitherDbcsOn !== undefined) field.eitherDbcsOn = opts.eitherDbcsOn;
        else noteEitherMode(field, [...value]);
      }
      return;
    }
    // **符号位置で数える。** センチネルは第 15 面（サロゲート対＝2 コード単位）なので、
    // `value.length` で数えると桁数を過大に見積もって FIELD_OVERFLOW になる。
    const chars = [...value];
    if (!skipCharLengthCheck && chars.length > field.length) {
      // **打鍵した値の長さを出さない**（`20260920-field-error-no-value` FR1「値・その一部・
      // **その長さ**を含めない」）。この文言は `ws-handler` の catch からブラウザへ返り、
      // 値はマクロ由来の**復号済みの秘密**でもありうる——長さは秘密そのものではないが、
      // 秘密について外へ出る情報を増やす理由が無い。
      // **欄の桁数（`field.length`）はホストが宣言した値**なので出してよい。
      const { row, col } = this.rowColOf(field.startAddr);
      throw new As400Error(
        "FIELD_OVERFLOW",
        `field at (${row},${col}) accepts at most ${field.length} characters`
      );
    }
    for (let i = 0; i < field.length; i++) {
      const ch = chars[i];
      // **センチネル文字は埋め込み属性セルとして書く**——値の中で属性が編集に追従して動いた
      // 位置に、その属性バイトのセルを置き直す（桁ずれ・色ずれ・送信での破壊を防ぐ）。
      if (ch !== undefined && isAttrSentinel(ch)) {
        this.cells[field.startAddr + i] = { type: "attr", byte: sentinelByte(ch) };
      } else if (ch === "\u0000") {
        this.cells[field.startAddr + i] = null; // 空きの桁（NUL）
      } else if (ch !== undefined && ch === NUL_SENTINEL) {
        // **空きの桁（NUL）**。語送りの欄の値が運ぶ（`fieldValue`）。生バイトのセルにすると READ MDT で 00 のまま出てしまう
        this.cells[field.startAddr + i] = null;
      } else if (ch !== undefined && isRawSentinel(ch)) {
        // 表示できない SBCS バイト。生バイトを保ったまま置き直す（送信で元に戻る）
        this.cells[field.startAddr + i] = {
          type: "char",
          char: UNDISPLAYABLE,
          charKind: "sbcs",
          rawByte: sentinelByte(ch)
        };
      } else {
        // O 欄の空白は中身（生バイト 0x40 を持たせて空きの桁と見分ける。`setFieldCells` と同じ）
        const chainSpace = ch === " " && (field.dbcsType === "open" || field.dbcsType === "either");
        this.cells[field.startAddr + i] =
          ch !== undefined ? { type: "char", char: ch, charKind: "sbcs", ...(chainSpace ? { rawByte: 0x40 } : {}) } : null;
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
    const blank = chars.every((c) => c === " ");
    // 継続欄の中間・最終の区間には置かない（SO は欄の頭にだけある。E・J の継続欄は未確認）
    const head = field.continued === undefined || field.continued === "first";
    if (field.dbcsType === "either") {
      if (opts?.eitherDbcsOn !== undefined) {
        // **画面の側が明示した状態を使う**（値からは推せない空の値でも正しく決まる。`20260927-either-field-so`）
        field.eitherDbcsOn = opts.eitherDbcsOn;
        // 全角の状態のまま空にした欄は、先頭に SO だけを残す——ACS は READ で `0e` の 1 バイトを送る
        // （実機の ACS のコア。Erase EOF でも Erase Input でも。`scripts/acs-probe/either-empty.txt`・`either-switch-empty.txt`）。
        // 残りの桁は NUL（空白を残すと `0e 40 40 …` になる）
        if (opts.eitherDbcsOn && blank && head) this.placeEmptyShift(field, false);
      } else {
        // 画面の側から状態が来ない呼び出し（MCP・HLLAPI・マクロ）は従来どおり値から推す
        noteEitherMode(field, chars);
      }
    } else if (field.dbcsType === "only" && blank && head) {
      // **J（DBCS のみ）の欄は空にしても SO と SI を残す**——ACS は Erase Input の後の J 欄を `0e` ＋ NUL ＋ `0f` で送る（ALT の読み。実機の ACS のコア）
      this.placeEmptyShift(field, true);
    }
  }

  /** 空にした DBCS の欄の構造: 先頭に SO（`withSi` なら末尾に SI）、間は NUL（`setFieldValue`） */
  private placeEmptyShift(field: InternalField, withSi: boolean): void {
    for (let i = 0; i < field.length; i++) this.cells[field.startAddr + i] = null;
    this.cells[field.startAddr] = { type: "char", char: " ", charKind: "so" };
    if (withSi && field.length >= 2) this.cells[field.startAddr + field.length - 1] = { type: "char", char: " ", charKind: "si" };
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
    //
    // **門番は「ホストが DBCS 種別を申告したか」ではなく「中身に SO/SI があるか」。**
    // 日本語機では、DDS で `A`（SBCS）と書かれた欄に SO/SI 込みの DBCS データがそのまま
    // 載ってくることがある（char 欄にバイトを置くだけのプログラム）。申告で門番していたため、
    // その欄は 1 文字ずつの復号値になり、**送信時に codec が SO/SI を付け直して 2 バイト増える**
    // ——欄長が固定なので末尾が落ち、ホストには別の値が届いていた
    // （実機 `TESTLIB/UDCPGM` の `IN2` で確認: 打鍵せず送り返すだけで `DIFF`）。
    if (this.hasDbcsStructure(field)) {
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
      // 語送りの欄は空きの桁（NUL）を実空白と区別して返す（語送りが語の間の詰め物に使う。`InternalField.wordWrap`）
      else s += field.wordWrap === true && c === null ? NUL_SENTINEL : " ";
    }
    if (keepTrailingBlanks) return s;
    if (field.wordWrap !== true) return s.replace(/ +$/, "");
    // 語送りの欄は末尾の空白と NUL（センチネル）を落とす
    const cs = [...s];
    while (cs.length > 0 && (cs[cs.length - 1] === " " || cs[cs.length - 1] === NUL_SENTINEL)) cs.pop();
    return cs.join("");
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
    // 末尾のブランク桁（空セル・EBCDIC 空白）を落とす。SO/SI・DBCS の構造桁は残す（末尾の { なども保つ）。
    let end = field.length;
    while (end > 0 && this.isTrailingBlankCell(this.cells[field.startAddr + end - 1])) end--;
    let s = "";
    for (let i = 0; i < end; i++) s += this.dbcsRawCell(this.cells[field.startAddr + i]) ?? " ";
    return s;
  }

  /**
   * **未編集の DBCS 欄を桁ごとに返す**（READ の応答用。`20260927-read-dbcs-fields`）。1 桁 1 要素で、空のセル（NUL）は `undefined`。
   * ACS `DS5250.sendAll` は DBCS の欄も末尾の NUL だけを落とし、ホストが書いた実空白は送る——`fieldValue` は末尾の空白を落とすので、
   * NUL と実空白を区別できるこちらを使う。構造を持たない（編集した・SBCS だけの）欄は `undefined`。
   * **NUL だけの欄**も原本として返す（全桁 `undefined`）——構造の桁が無くても編集していない。ACS は G・O とも 0 バイトで送る（実機の READDBCS）。
   * `force` は構造を持たない欄も桁ごとに返す（継続した DBCS の欄の半角だけの区間。ACS は区間を桁のまま連結する——`20260928-cont-o-cells`）
   */
  dbcsRawCells(field: InternalField, force = false): (string | undefined)[] | undefined {
    if (!force && !this.hasDbcsStructure(field) && !this.allNul(field)) return undefined;
    const out: (string | undefined)[] = [];
    for (let i = 0; i < field.length; i++) out.push(this.dbcsRawCell(this.cells[field.startAddr + i]));
    return out;
  }

  /** 欄の全桁が空のセル（NUL）か */
  private allNul(field: InternalField): boolean {
    for (let i = 0; i < field.length; i++) if (this.cellAt(field.startAddr + i) !== null) return false;
    return true;
  }

  /** 未編集の DBCS 欄の 1 桁（センチネルは read-response が生バイトで書き出す）。空のセルは `undefined` */
  private dbcsRawCell(c: InternalCell | undefined | null): string | undefined {
    if (c?.type === "char" && c.dead === true) return undefined; // 死んだ桁は NUL
    if (c?.type === "char") {
      switch (c.charKind) {
        case "so":
          return rawSentinel(0x0e);
        case "si":
          return rawSentinel(0x0f);
        case "dbcs-tail":
          return c.rawByte !== undefined ? rawSentinel(c.rawByte) : "";
        // dbcs-lead / sbcs: 生バイトがあればそのまま、無ければ文字（フィル空白等）を codec に委ねる
        default:
          return c.rawByte !== undefined ? rawSentinel(c.rawByte) : c.char;
      }
    }
    if (c?.type === "attr") return attrSentinel(c.byte);
    return undefined;
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

  /**
   * **READ MDT 系で送る欄の並び**（ACS `FFT5250.firstModifiedField` / `nextModifiedField`）。再順序付けが無ければ `mdtFields()`。
   * あれば `resequenceFirst` 番の欄から FCW 0x80nn の番号を辿る: 最初の欄に MDT が無ければ次へ進み、それ以降は**辿った先が MDT でなければそこで止まる**
   * （実機の ACS のコアでも、鎖の 2 つ目に MDT が無いと 3 つ目に打っていても 1 欄だけ送った。`scripts/acs-probe/resequence.txt`）。
   * 0xFF で終わり。番号 0・範囲外・一巡も終わりにする（ACS は例外で応答を作れない——当 PJ の判断。`20260928-resequence` decisions D2）。
   * 番号は欄の表（`orderedFields()`＝番地の順）の 1 始まり。ACS の表は追加の順だが、昇順でない SF は表に入らない（`checkNewField`）ので同じ順になる（同 D3）。
   * 継続欄の MDT は並びのどこかで見る（ACS は区間ごとの `isMDTField` だが `setMDT` が並びの全区間に立てる。鎖が中間の区間を指す形は未確認）
   */
  readMdtFields(): readonly InternalField[] {
    if (this.resequenceFirst === 0) return this.mdtFields();
    const table = this.orderedFields();
    const hasMdt = (f: InternalField): boolean => (f.continued === undefined ? [f] : this.continuedRun(f)).some((x) => x.mdt);
    const next = (f: InternalField): InternalField | undefined => {
      const n = f.nextResequence ?? 0;
      if (n === 0xff || n === 0) return undefined;
      const g = table[n - 1];
      return g !== undefined && hasMdt(g) ? g : undefined;
    };
    const out: InternalField[] = [];
    let f = table[this.resequenceFirst - 1];
    if (f !== undefined && !hasMdt(f)) f = next(f);
    while (f !== undefined && !out.includes(f)) {
      out.push(f);
      f = next(f);
    }
    return out;
  }

  /**
   * **READ INPUT 系で送る欄の並び**（ACS `FFT5250.firstInputField` / `nextInputField`）。再順序付けが無ければ `orderedFields()`。
   * あれば同じ鎖を MDT を問わず辿る。番号 0 は表の次の欄、0xFF で終わり。範囲外・一巡は終わり
   */
  readInputFields(): readonly InternalField[] {
    if (this.resequenceFirst === 0) return this.orderedFields();
    const table = this.orderedFields();
    const out: InternalField[] = [];
    let i = this.resequenceFirst - 1;
    while (i >= 0 && i < table.length && !out.includes(table[i]!)) {
      const f = table[i]!;
      out.push(f);
      const n = f.nextResequence ?? 0;
      if (n === 0xff) break;
      i = n === 0 ? i + 1 : n - 1;
    }
    return out;
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
    //
    // **継続入力フィールド（EDTMSK 分割）の先頭・中間区間はここに含めない。** その「終端」は
    // 区間の間の保護された区切り文字（例: `/`）の位置で、まだ同じ続きの欄——次区間の SF が
    // 自分の属性バイトを置くまで、色は前区間から引き継がれるのが正しい（ACS と実機がそう見せる）。
    // ここに含めてしまうと区切り文字だけ既定色に戻り、EDTMSK 欄の色が区切りの桁で途切れる
    // （利用者のスクリーンショット報告: `年月度` 欄の `/` から先の色が変わる）。
    const fieldEnds = new Set<number>(this.retainedEnds);
    for (const f of this.fields) {
      if (f.continued === "first" || f.continued === "middle") continue;
      fieldEnds.add(f.startAddr + f.length);
    }
    // **開いている窓の右端も打ち切り位置に加える。** 窓の中身（ヘルプ等の表示専用テキスト）は
    // 入力欄ではないので `fields` に載らず、上の境界だけでは守れない。窓の中で属性が閉じられずに
    // 行末へ達すると、アドレス順の一続きスキャンがそのまま窓の外（同じ行の右側・次行の左側＝
    // 背面の SEU ソース行）まで下線・色を引きずってしまう（利用者報告: F4 窓の上に F1 ヘルプ窓を
    // 開くと、窓の外のソース行に無いはずの下線が出る）。`blankWindowArea` と同じ矩形（枠を含む）
    // の行ごとに、右端の 1 桁先を打ち切り位置にする。
    //
    // **左端も同じく打ち切る（外側の属性を窓の中へ持ち込ませない）。** 窓を開くときに
    // `blankWindowArea` が矩形のセルを消すので、背面の欄の**閉じ属性**が窓の左端に
    // かかっていると一緒に消える。そのまま走査すると、窓の左側に残った欄の属性
    // （PDM の OPT 欄の下線）が窓の中を突き抜けて右端まで伸びる。
    //
    // 通常は `retainedEnds`（SOH で消えた欄の終端の引き継ぎ）が打ち切ってくれるが、
    // **RESTORE SCREEN で画面イメージを書き戻す経路ではそれも消える**——書き戻しは
    // ただの文字列で欄定義を伴わないため、引き継いだ終端が上書きで捨てられる。
    // 実機 YB0140R の窓を PDM 一覧の上で PageUp すると、この経路に入って
    // 下線が窓の全幅に伸びた（証跡 `work/yb0140r-window/`。ACS は 2-3 桁のまま）。
    for (const w of this.guiWindows) {
      const rowEnd = Math.min(this.rows, w.row + w.height + 1);
      const colStart = Math.max(1, w.col);
      const colEnd = Math.min(this.cols, w.col + w.width + 4);
      for (let row = Math.max(1, w.row); row <= rowEnd; row++) {
        fieldEnds.add((row - 1) * this.cols + colEnd);
        fieldEnds.add((row - 1) * this.cols + (colStart - 1));
      }
    }
    let attr = this.row1col0Attr !== undefined ? decodeAttribute(this.row1col0Attr) : DEFAULT_ATTR;
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
          // 死んだ桁の印（継続した O 欄の編集の続き。web-ui の詰め直しが捨てる桁を見分ける）
          if (cell?.type === "char" && cell.dead === true) out.dead = true;
          // 非表示の欄の中身のある桁（字は出さない。編集が触らない桁を目印で持つため）
          if (attr.nonDisplay && cell?.type === "char" && cell.dead !== true && (charKind === "sbcs" || charKind === "dbcs-lead")) out.keep = true;
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
      // **申告は無いのに中身が DBCS の欄**。値は生バイトで運ぶので、表示はセルから組み立てる
      else if (this.hasDbcsStructure(f)) field.dbcsContent = true;
      if (f.eitherDbcsOn === true) field.eitherDbcsOn = true;
      // 区間をまたぐカーソル移動・Field Exit を web-ui / MCP が組み立てるために出す
      if (f.continued !== undefined) field.continued = f.continued;
      // カーソル送り（FLDCSRPRG）。移動を組み立てるのは UI 側
      if (f.cursorProgression !== undefined) field.cursorProgression = f.cursorProgression;
      // 語送り（WRDWRAP）。語送りを掛けるのは UI 側（ACS `processWordWrap`）
      if (f.wordWrap === true) field.wordWrap = true;
      // 自己点検欄（CHECK(M10)/CHECK(M11)）。検算して送信を止めるのは UI 側（ACS も送信時に検査）
      if (f.selfCheck !== undefined) field.selfCheck = f.selfCheck;
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
    if (this.systemMessage !== undefined) {
      snap.systemMessage = this.systemMessage;
      if (this.systemMessageSeq !== undefined) snap.systemMessageSeq = this.systemMessageSeq;
      // 位置は `systemMessage` があるときだけ載せる（消えた後に古い位置を残さない）
      if (this.systemMessageArea !== undefined) snap.systemMessageArea = { ...this.systemMessageArea };
    }
    // CA キー（SOH の申告）。UI の ME 検査が見る（`sendsDataForAid` と同じビットの並び）
    if (this.cursorInputOnly) snap.cursorInputOnly = true;
    const caKeys: number[] = [];
    for (let n = 1; n <= 24; n++) if (!this.sendsDataForAid(n)) caKeys.push(n);
    if (caKeys.length > 0) snap.caKeys = caKeys;
    // ホーム位置（ACS `homePos`: IC → 先頭の非バイパス欄 → 0。IC は書式を消すまで持ち越す＝`icAddr`）
    snap.home = this.rowColOf(this.icAddr ?? this.homeAddr());
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
      windows: this.guiWindows.map((w) => (w.id === this.currentWindowId ? { ...w, current: true } : { ...w })),
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

/** WRITE ERROR CODE の通し番号（`ScreenBuffer.systemMessageSeq`）。バッファをまたいで重ならないよう、ここで持つ */
let systemMessageSeqCounter = 0;
export function nextSystemMessageSeq(): number {
  return ++systemMessageSeqCounter;
}
