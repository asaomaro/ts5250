import { ByteWriter } from "./bytes.js";
import { encodeAddress, encodeAttribute } from "./address.js";
import { NUL, ORDER, XA, CHARSET, REPLY_MODE } from "./constants.js";
import { parseFieldAttr } from "../screen/attributes.js";
import type { Screen3270 } from "../screen/buffer.js";
import { AID, AID_NONE, isShortForm, type AidKey } from "../session/aid-keys.js";

/**
 * 端末 → ホストの応答を組み立てる。
 *
 * ## 形式は実測で確定した（`artifacts/aid.trc`）
 *
 * `mini3270` を受信側にして `s3270` に実際に押させ、送ってきた生バイトを捕まえた。
 * `s3270` 自身のトレース（送信側も復号する）とも突き合わせてある。
 *
 * ```
 * Enter（入力なし）    7d 40c1                             AID + カーソル
 * PF1                 f140c1
 * PA1 / PA2 / PA3 / Clear   6c / 6e / 6b / 6d              **AID 1 バイトだけ**
 * Enter（2 欄に入力）  7d 4b5d 11 40c1 c1c2 11 4b5b e9e9   AID + カーソル
 *                                                          + (SBA + 欄の先頭 + データ) × n
 * Read Modified コマンド    先頭が 60（キー押下ではない）
 * ```
 *
 * `SBA` が指すのは**欄の中身の先頭**（属性桁の次）。上の例では属性桁 0 の欄が `11 40c1`（＝1）、
 * 属性桁 730 の欄が `11 4b5b`（＝731）。
 *
 * ## フォーマット画面と非フォーマット画面で形が変わる
 *
 * - **フォーマット画面**（属性桁がある）: 変更欄ごとに `SBA + 先頭アドレス + データ`
 * - **非フォーマット画面**（属性桁が 1 つも無い）: `AID + カーソル + 画面の中身`（**SBA なし**）
 *
 * > **一度これを取り違えた。** 最初の探針はキーを総当たりする際、末尾で `Clear()` を押していた。
 * > Clear は画面を消すので**以後は非フォーマット画面**になり、そこへの入力は SBA 無しで送られる。
 * > その状態を測って「s3270 は SBA を出さない」と結論しかけた。
 * > **測った状態が何だったかを確かめる**のが要る、という実例。
 */

/** 応答モードの設定（`Set Reply Mode` で受け取ったもの） */
export interface ReplyMode {
  /** `REPLY_MODE.FIELD` / `EXTENDED_FIELD` / `CHARACTER` */
  mode: number;
  /** 文字モードで載せる属性の種類（ホストが並べてくる。並んでいないものは載せない） */
  types: number[];
}

export interface OutboundOptions {
  /** 応答モード。省略時は欄モード（拡張属性を載せない） */
  reply?: ReplyMode;
  /**
   * **`Read Modified All`（0x6e）なら true。**
   *
   * 違いは**短形式の扱いだけ**——`PA1`〜`PA3`・`Clear` の後、
   * `Read Modified` は AID 1 バイトだけを返すが、`Read Modified All` は
   * **短形式を無視して欄まで返す**（s3270 実測）。
   * ホストが「PA キーの後でも入力内容が欲しい」ときに使う、そのための命令。
   */
  all?: boolean;
}

/**
 * AID 押下 / ホスト起動の読み取りに対する応答（Read Modified 相当）を組み立てる。
 */
export function buildReadModified(
  screen: Screen3270,
  key: AidKey | null,
  opts: OutboundOptions = {}
): Uint8Array {
  const w = new ByteWriter();
  w.u8(key === null ? AID_NONE : AID[key]);

  // **短形式は AID 1 バイトだけ**（実測）。カーソルも欄も送らない。
  // ただし `Read Modified All` は短形式を無視する
  if (key !== null && isShortForm(key) && opts.all !== true) return w.toUint8Array();

  const [hi, lo] = encodeAddress(screen.cursor, screen.size);
  w.u8(hi).u8(lo);

  for (const data of modifiedFieldData(screen, opts.reply)) w.bytes(data);
  return w.toUint8Array();
}

/**
 * バッファ全体を返す（`Read Buffer` コマンドへの応答）。
 *
 * 形は `AID(0x60) + カーソル(2) + 全桁` で、**属性桁は `SF` オーダー(0x1D) ＋ 属性バイトの
 * 2 バイトで表す**（裸の属性バイトではない）。
 *
 * **実測で確定した**（`e2e-orders.test.ts`）。当初は属性バイトをそのまま置いていたが、
 * s3270 と突き合わせたら食い違った:
 *
 * ```
 * s3270 : … 6040 40 **1d60** d9c2 …   ← SF + 属性
 * 当初  : … 6040 40 **60**   d9c2 …   ← 属性を裸で置いていた（誤り）
 * ```
 *
 * TK4- も IBM i もこのコマンドを撃ってこなかったので、**実ホストだけ見ていては
 * 見つからない誤り**だった。
 */
export function buildReadBuffer(
  screen: Screen3270,
  key: AidKey | null = null,
  opts: OutboundOptions = {}
): Uint8Array {
  const w = new ByteWriter();
  // **Read Buffer も覚えている AID を返す**——0x60 固定ではない。
  // `PA1` の後に Read Buffer を撃つと s3270 は `6c` を先頭に置いた（実測）
  w.u8(key === null ? AID_NONE : AID[key]);
  const [hi, lo] = encodeAddress(screen.cursor, screen.size);
  w.u8(hi).u8(lo);
  const sa = new SaTracker(opts.reply);
  for (let p = 0; p < screen.size; p++) {
    if (screen.isAttrPos(p)) w.bytes(fieldAttrBytes(screen, p, opts.reply));
    else w.bytes(sa.charBytes(screen, p));
  }
  return w.toUint8Array();
}

/**
 * **属性桁の書き出し。** 応答モードで形が変わる（s3270 実測）。
 *
 * ```
 * 欄モード       1d 60                          SF ＋ 属性
 * 拡張欄・文字   29 03 c0 60 42 f2 41 f4        SFE ＋ 組数 ＋ 対
 * ```
 *
 * **並びは決まっている**——基本(0xc0) → 前景(0x42) → 背景(0x45) → ハイライト(0x41) →
 * 文字セット(0x43)。ホストが送ってきた順ではない（順を変えて撃って確かめた）。
 * **値が 0 の拡張属性は載せない**（基本属性だけは必ず載る）。
 */
function fieldAttrBytes(screen: Screen3270, p: number, reply?: ReplyMode): number[] {
  const attr = encodeAttribute(screen.attrAt(p));
  if (reply === undefined || reply.mode === REPLY_MODE.FIELD) return [ORDER.SF, attr];

  const pairs: number[] = [XA.BASIC, attr];
  const { color, hilite } = screen.extAt(p);
  const bg = screen.backgroundAt(p);
  const cs = screen.charsetAt(p);
  if (color !== 0) pairs.push(XA.FOREGROUND, color);
  if (bg !== 0) pairs.push(XA.BACKGROUND, bg);
  if (hilite !== 0) pairs.push(XA.HIGHLIGHT, normalizeHilite(hilite));
  if (cs === CHARSET.DBCS || cs === CHARSET.APL) pairs.push(XA.CHARSET, cs);
  return [ORDER.SFE, pairs.length / 2, ...pairs];
}

/** ハイライトは下位 3 ビットだけが意味を持ち、返すときは 0xf0 を立てる（実測） */
function normalizeHilite(v: number): number {
  return (v & 0x07) | 0xf0;
}

/**
 * **文字モードで `SA` オーダーを挟む。**
 *
 * ホストが `Set Reply Mode` で並べた種類だけを、**値が変わった桁で** 1 度ずつ出す。
 * 直前の値を覚えて比べる必要があるので、走査をまたいで状態を持つ。
 * 併せて **`GE` で置かれた桁には `GE` を前置する**——生バイトだけ返すと、
 * ホストは代替文字集合だったことを知りようがない。
 */
class SaTracker {
  private prev = new Map<number, number>();
  constructor(private readonly reply?: ReplyMode) {}

  /**
   * @param faPos その桁を支配する属性桁。`>= 0` なら**文字に指定が無いとき欄の値を使う**
   *   （`Read Modified` はこちら。`Read Buffer` は文字の値だけを見る——x3270 の呼び分けと同じ）
   */
  charBytes(screen: Screen3270, p: number, faPos = -1): number[] {
    const out: number[] = [];
    if (this.reply !== undefined && this.reply.mode === REPLY_MODE.CHARACTER) {
      const pick = (own: number, fa: number): number => (own !== 0 ? own : faPos >= 0 ? fa : 0);
      const cs = pick(screen.charsetAt(p), faPos >= 0 ? screen.charsetAt(faPos) : 0);
      const gr = pick(screen.extAt(p).hilite, faPos >= 0 ? screen.extAt(faPos).hilite : 0);
      const wanted: [number, number][] = [
        [XA.FOREGROUND, pick(screen.extAt(p).color, faPos >= 0 ? screen.extAt(faPos).color : 0)],
        [XA.BACKGROUND, pick(screen.backgroundAt(p), faPos >= 0 ? screen.backgroundAt(faPos) : 0)],
        [XA.HIGHLIGHT, gr === 0 ? 0 : normalizeHilite(gr)],
        [XA.CHARSET, cs === CHARSET.DBCS || cs === CHARSET.APL ? cs : 0]
      ];
      for (const [type, value] of wanted) {
        if (!this.reply.types.includes(type)) continue;
        if ((this.prev.get(type) ?? 0) === value) continue;
        this.prev.set(type, value);
        out.push(ORDER.SA, type, value);
      }
    }
    if (screen.isGe(p)) out.push(ORDER.GE);
    out.push(screen.charAt(p));
    return out;
  }
}

/**
 * 変更された欄を「SBA + 先頭アドレス + データ」の並びで返す。
 *
 * **末尾・途中の NUL は落とす**（実測: s3270 は `"AB"` とだけ送り、欄の残り桁を埋めてこない）。
 * 3270 は NUL と空白(0x40)を区別するので、NUL を空白に読み替えてはならない。
 */
function* modifiedFieldData(screen: Screen3270, reply?: ReplyMode): Generator<number[]> {
  const positions = screen.attrPositions();
  const sa = new SaTracker(reply);
  if (positions.length === 0) {
    // **非フォーマット画面**: 画面全体を 1 つの入力として、SBA を付けずに送る（実測）
    yield collect(screen, 0, screen.size, sa, -1);
    return;
  }
  for (let i = 0; i < positions.length; i++) {
    const ap = positions[i]!;
    if (!parseFieldAttr(screen.attrAt(ap)).modified) continue;
    const nextAp = positions[(i + 1) % positions.length]!;
    const len = nextAp > ap ? nextAp - ap - 1 : screen.size - ap - 1 + nextAp;
    const start = screen.wrap(ap + 1);
    const data = collect(screen, start, len, sa, ap);
    // **SBA は欄の中身の先頭を指す**（属性桁の次）
    yield [ORDER.SBA, ...encodeAddress(start, screen.size), ...data];
  }
}

/**
 * 欄の中身を取り出す。**NUL の桁は丸ごと飛ばす**——バイトも `SA` も `GE` も出さない
 * （実測: s3270 は `"AB"` とだけ送り、欄の残り桁を埋めてこない）。
 * 3270 は NUL と空白(0x40)を区別するので、NUL を空白に読み替えてはならない。
 */
function collect(
  screen: Screen3270,
  from: number,
  len: number,
  sa: SaTracker,
  faPos: number
): number[] {
  const out: number[] = [];
  for (let k = 0; k < len; k++) {
    const p = screen.wrap(from + k);
    if (screen.charAt(p) === NUL) continue;
    out.push(...sa.charBytes(screen, p, faPos));
  }
  return out;
}

/** 末尾の NUL を落とす（途中の NUL も送らない＝詰めて送る） */
