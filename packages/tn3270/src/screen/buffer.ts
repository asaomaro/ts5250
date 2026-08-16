import { As400Error } from "@ts5250/base";
import { NUL, SO, SI } from "../protocol/constants.js";
import { PRIMARY_SIZE, alternateSizeFor, type Model3270 } from "../telnet/terminal-type.js";
import { toRowCol } from "../protocol/address.js";
import { parseFieldAttr, withMdt } from "./attributes.js";

/**
 * 3270 の画面バッファ。**画面の真実はここ 1 箇所**。
 *
 * ## 表現（design D8）
 *
 * 桁ごとの情報を**並列 typed array**で持つ。実機のコントローラと同じ形で、
 * 走査が速く GC 圧も無い。
 *
 * ```
 * 桁:      0     1     2     3     4     5     6     7     8
 *        [attr][ A ][ B ][ C ][ SO ][日 ][日 ][ SI ][ D ]
 * ```
 *
 * **フィールド属性はバッファの 1 桁を占める**（5250 と根本的に違う）。
 * フィールドは属性桁の次から始まり、**次の属性桁の直前**で終わる。
 *
 * ## フィールドは保持しない
 *
 * `snapshot()` のたびに属性桁を走査して導出する。増分管理をやめた理由は、
 * `MF` によるフィールド属性の書き換え・`RA` による属性桁の上書き・`EW` の全消去が
 * 絡むと**組み合わせが爆発する**から。線形走査は 3,564 桁でも無視できる費用で、
 * 正しさを構造で担保できる（tn5250 の `buffer.ts` が 1,047 行に膨らんだ主因がここ）。
 *
 * ## MDT の真実も 1 箇所
 *
 * MDT は**属性桁の属性バイトのビット**に持つ（実機と同じ）。別のフラグ配列を作らない。
 */
export class Screen3270 {
  /** 桁ごとの EBCDIC バイト */
  private chars: Uint8Array;
  /** 1 = その桁は属性桁 */
  private attrMark: Uint8Array;
  /** 属性桁の基本属性バイト（属性桁以外は 0） */
  private fieldAttr: Uint8Array;
  /** 拡張属性（SFE / SA / MF が設定）。桁ごと */
  private extColor: Uint8Array;
  private extHilite: Uint8Array;
  /**
   * 1 = その桁は `GE`（Graphic Escape）で置かれた＝**代替文字集合**として読む。
   *
   * 生バイトだけでは通常の EBCDIC と区別できないので、印を別に持つ。
   * 「保持は生バイト、意味は導出」の方針は保ったまま、**導出に必要な情報だけ**を足している。
   */
  private geMark: Uint8Array;
  /** 桁ごとの文字セット属性（`XA.CHARSET` の値）。0 は基本文字集合 */
  private extCharset: Uint8Array;
  /** 属性桁の入力制御（`XA.INPUT_CONTROL`）。1 なら混在入力を許す欄 */
  private extInputCtl: Uint8Array;

  private cursorPos = 0;
  private alt = false;
  private locked = false;

  rows: number;
  cols: number;

  constructor(private readonly model: Model3270 = 2) {
    this.rows = PRIMARY_SIZE.rows;
    this.cols = PRIMARY_SIZE.cols;
    const n = this.rows * this.cols;
    this.chars = new Uint8Array(n);
    this.attrMark = new Uint8Array(n);
    this.fieldAttr = new Uint8Array(n);
    this.extColor = new Uint8Array(n);
    this.extHilite = new Uint8Array(n);
    this.geMark = new Uint8Array(n);
    this.extCharset = new Uint8Array(n);
    this.extInputCtl = new Uint8Array(n);
  }

  get size(): number {
    return this.rows * this.cols;
  }

  get alternate(): boolean {
    return this.alt;
  }

  get cursor(): number {
    return this.cursorPos;
  }

  get keyboardLocked(): boolean {
    return this.locked;
  }

  setKeyboardLocked(v: boolean): void {
    this.locked = v;
  }

  setCursor(addr: number): void {
    this.cursorPos = this.wrap(addr);
  }

  /** 通し番号を画面内に丸める（3270 のバッファは**環状**——末尾の次は先頭） */
  wrap(addr: number): number {
    const n = this.size;
    return ((addr % n) + n) % n;
  }

  /**
   * サイズを切り替えて全消去する（`EW` は標準・`EWA` は代替。spec D5）。
   *
   * `EW` / `EWA` はどちらも「消してから書く」コマンドなので、内容を移す必要はない。
   */
  resize(alternate: boolean): void {
    const size = alternate ? alternateSizeFor(this.model) : PRIMARY_SIZE;
    this.rows = size.rows;
    this.cols = size.cols;
    this.alt = alternate;
    const n = this.rows * this.cols;
    this.chars = new Uint8Array(n);
    this.attrMark = new Uint8Array(n);
    this.fieldAttr = new Uint8Array(n);
    this.extColor = new Uint8Array(n);
    this.extHilite = new Uint8Array(n);
    this.geMark = new Uint8Array(n);
    this.extCharset = new Uint8Array(n);
    this.extInputCtl = new Uint8Array(n);
    this.cursorPos = 0;
  }

  /** 内容だけ消す（サイズは変えない） */
  clear(): void {
    this.chars.fill(NUL);
    this.attrMark.fill(0);
    this.fieldAttr.fill(0);
    this.extColor.fill(0);
    this.extHilite.fill(0);
    this.geMark.fill(0);
    this.extCharset.fill(0);
    this.extInputCtl.fill(0);
    this.cursorPos = 0;
  }

  /** 文字を書く。**属性桁は消える**（データが上書きしたのだから） */
  writeChar(addr: number, byte: number, charset = 0): void {
    const p = this.wrap(addr);
    this.chars[p] = byte;
    this.attrMark[p] = 0;
    this.fieldAttr[p] = 0;
    this.geMark[p] = 0;
    this.extCharset[p] = charset;
  }

  /** `GE` で 1 文字置く（代替文字集合として読む印を付ける） */
  writeCharGe(addr: number, byte: number): void {
    this.writeChar(addr, byte);
    this.geMark[this.wrap(addr)] = 1;
  }

  /** その桁が `GE` で置かれたか */
  isGe(addr: number): boolean {
    return this.geMark[this.wrap(addr)] === 1;
  }

  /** 属性桁を置く（`SF` / `SFE`）。**その桁は文字を持たない** */
  startField(addr: number, attr: number): void {
    const p = this.wrap(addr);
    this.geMark[p] = 0;
    this.attrMark[p] = 1;
    this.fieldAttr[p] = attr;
    this.chars[p] = NUL;
    this.extColor[p] = 0;
    this.extHilite[p] = 0;
    this.extCharset[p] = 0;
    this.extInputCtl[p] = 0;
  }

  isAttrPos(addr: number): boolean {
    return this.attrMark[this.wrap(addr)] === 1;
  }

  attrAt(addr: number): number {
    return this.fieldAttr[this.wrap(addr)]!;
  }

  charAt(addr: number): number {
    return this.chars[this.wrap(addr)]!;
  }

  setExt(addr: number, color: number, hilite: number): void {
    const p = this.wrap(addr);
    this.extColor[p] = color;
    this.extHilite[p] = hilite;
  }

  extAt(addr: number): { color: number; hilite: number } {
    const p = this.wrap(addr);
    return { color: this.extColor[p]!, hilite: this.extHilite[p]! };
  }

  /**
   * **文字セット属性を置く。**属性桁に置けば欄全体、文字桁に置けばその 1 桁に効く
   * （`XA.CHARSET`。`CHARSET.DBCS` なら DBCS）。
   */
  setCharset(addr: number, charset: number): void {
    this.extCharset[this.wrap(addr)] = charset;
  }

  charsetAt(addr: number): number {
    return this.extCharset[this.wrap(addr)]!;
  }

  /** 属性桁に入力制御を置く（`XA.INPUT_CONTROL`。混在入力を許すか） */
  setInputControl(addr: number, on: boolean): void {
    this.extInputCtl[this.wrap(addr)] = on ? 1 : 0;
  }

  inputControlAt(addr: number): boolean {
    return this.extInputCtl[this.wrap(addr)] === 1;
  }

  /**
   * その桁を支配する属性桁の位置を返す（**手前へ環状に探す**）。
   * 属性桁が 1 つも無い＝非フォーマット画面なら `-1`。
   */
  fieldAttrPosFor(addr: number): number {
    const n = this.size;
    let p = this.wrap(addr);
    for (let i = 0; i < n; i++) {
      if (this.attrMark[p] === 1) return p;
      p = p === 0 ? n - 1 : p - 1;
    }
    return -1;
  }

  /** 属性桁の位置を画面順に並べて返す */
  attrPositions(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.size; i++) if (this.attrMark[i] === 1) out.push(i);
    return out;
  }

  get unformatted(): boolean {
    return this.attrPositions().length === 0;
  }

  /** その桁が保護されているか（非フォーマット画面は全体が非保護） */
  isProtectedAt(addr: number): boolean {
    const ap = this.fieldAttrPosFor(addr);
    if (ap < 0) return false;
    return parseFieldAttr(this.fieldAttr[ap]!).protected;
  }

  /** その桁の欄の MDT を立てる／落とす */
  setMdtFor(addr: number, on: boolean): void {
    const ap = this.fieldAttrPosFor(addr);
    if (ap < 0) return; // 非フォーマット画面に MDT は無い
    this.fieldAttr[ap] = withMdt(this.fieldAttr[ap]!, on);
  }

  /** 全欄の MDT を落とす（WCC の resetMDT） */
  resetAllMdt(): void {
    for (const p of this.attrPositions()) this.fieldAttr[p] = withMdt(this.fieldAttr[p]!, false);
  }

  /**
   * 非保護欄を消して MDT を落とす（`EAU` コマンド / `EUA` オーダーの土台）。
   * `from` から `to` の**手前**まで（環状）。省略時は画面全体。
   */
  eraseUnprotected(from = 0, to = -1): void {
    const n = this.size;
    const end = to < 0 ? from : this.wrap(to);
    let p = this.wrap(from);
    for (let i = 0; i < n; i++) {
      if (this.attrMark[p] !== 1 && !this.isProtectedAt(p)) this.chars[p] = NUL;
      p = (p + 1) % n;
      if (p === end) break;
    }
    for (const ap of this.attrPositions()) {
      if (!parseFieldAttr(this.fieldAttr[ap]!).protected) {
        this.fieldAttr[ap] = withMdt(this.fieldAttr[ap]!, false);
      }
    }
  }

  /** 次の非保護欄の先頭へ（`PT` オーダー） */
  /**
   * **先頭から探した最初の非保護桁。** 非保護欄が無ければ 0。
   * `EAU`（Erase All Unprotected）のカーソル位置に使う（実測）。
   */
  firstUnprotected(): number {
    return this.nextUnprotected(this.size - 1);
  }

  nextUnprotected(from: number): number {
    const n = this.size;
    let p = this.wrap(from);
    for (let i = 0; i < n; i++) {
      p = (p + 1) % n;
      if (this.attrMark[p] === 1 && !parseFieldAttr(this.fieldAttr[p]!).protected) {
        return (p + 1) % n; // 属性桁の次が中身の先頭
      }
    }
    return 0;
  }

  /** DBCS 区間の判定に使う。その桁が SO / SI か */
  isSo(addr: number): boolean {
    return this.chars[this.wrap(addr)] === SO;
  }

  isSi(addr: number): boolean {
    return this.chars[this.wrap(addr)] === SI;
  }

  rowColOf(addr: number): { row: number; col: number } {
    return toRowCol(this.wrap(addr), this.cols);
  }

  /** テスト・照合用: 生バイト列をそのまま取り出す */
  rawChars(): Uint8Array {
    return this.chars.slice();
  }

  assertInRange(addr: number): void {
    if (addr < 0 || addr >= this.size) {
      throw new As400Error("PROTOCOL_ERROR", `buffer address ${addr} out of range (size ${this.size})`);
    }
  }
}
