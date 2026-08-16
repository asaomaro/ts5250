import { ByteWriter } from "./bytes.js";
import { encodeAddress, encodeAttribute } from "./address.js";
import { NUL, ORDER } from "./constants.js";
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

export interface OutboundOptions {
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

  for (const data of modifiedFieldData(screen)) w.bytes(data);
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
export function buildReadBuffer(screen: Screen3270, key: AidKey | null = null): Uint8Array {
  const w = new ByteWriter();
  // **Read Buffer も覚えている AID を返す**——0x60 固定ではない。
  // `PA1` の後に Read Buffer を撃つと s3270 は `6c` を先頭に置いた（実測）
  w.u8(key === null ? AID_NONE : AID[key]);
  const [hi, lo] = encodeAddress(screen.cursor, screen.size);
  w.u8(hi).u8(lo);
  for (let p = 0; p < screen.size; p++) {
    if (screen.isAttrPos(p)) w.u8(ORDER.SF).u8(encodeAttribute(screen.attrAt(p)));
    else w.u8(screen.charAt(p));
  }
  return w.toUint8Array();
}

/**
 * 変更された欄を「SBA + 先頭アドレス + データ」の並びで返す。
 *
 * **末尾・途中の NUL は落とす**（実測: s3270 は `"AB"` とだけ送り、欄の残り桁を埋めてこない）。
 * 3270 は NUL と空白(0x40)を区別するので、NUL を空白に読み替えてはならない。
 */
function* modifiedFieldData(screen: Screen3270): Generator<number[]> {
  const positions = screen.attrPositions();
  if (positions.length === 0) {
    // **非フォーマット画面**: 画面全体を 1 つの入力として、SBA を付けずに送る（実測）
    yield trimNul(collect(screen, 0, screen.size));
    return;
  }
  for (let i = 0; i < positions.length; i++) {
    const ap = positions[i]!;
    if (!parseFieldAttr(screen.attrAt(ap)).modified) continue;
    const nextAp = positions[(i + 1) % positions.length]!;
    const len = nextAp > ap ? nextAp - ap - 1 : screen.size - ap - 1 + nextAp;
    const start = screen.wrap(ap + 1);
    const data = trimNul(collect(screen, start, len));
    // **SBA は欄の中身の先頭を指す**（属性桁の次）
    yield [ORDER.SBA, ...encodeAddress(start, screen.size), ...data];
  }
}

function collect(screen: Screen3270, from: number, len: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < len; k++) out.push(screen.charAt(screen.wrap(from + k)));
  return out;
}

/** 末尾の NUL を落とす（途中の NUL も送らない＝詰めて送る） */
function trimNul(bytes: number[]): number[] {
  return bytes.filter((b) => b !== NUL);
}
