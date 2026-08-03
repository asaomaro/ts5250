/**
 * Unicode → CP932（Shift-JIS）の符号化。
 *
 * ## なぜ CP932 で返すのか
 *
 * HLLAPI 資産は **1 セル = 1 バイト**を前提に `24×80 = 1920` バイトの器を確保する。
 * CP932 なら**全角がちょうど 2 バイト**で、5250 の画面上でも全角は 2 桁（`dbcs-lead` ＋
 * `dbcs-tail` の 2 セル）を占めるので、**バイト位置と PS 位置が一致する**。
 *
 * UTF-8 だと日本語 1 文字が 3 バイトになり、1920 バイトの器に日本語画面が収まらない
 * （`20260803-hllapi-bridge` の実機検証で踏んだ）。
 *
 * ## 依存を足さない
 *
 * Node には Shift-JIS の**符号化器**が無い（`TextDecoder` は復号だけ）。
 * そこで **復号器から逆引き表を組む**——CP932 として妥当な 2 バイト列を総当たりで復号し、
 * 得られた文字から元のバイト列への対応を作る。表は起動時に 1 度だけ作る。
 *
 * この作り方なら、変換表を自前で抱え込まずに済み（保守の的が減る）、
 * **その環境の `TextDecoder` と必ず一致する**（片方だけずれる事故が起きない）。
 */

/** 1 バイトで表せる文字 → そのバイト（ASCII と半角カナ） */
let singleByte: Map<string, number> | undefined;
/** 2 バイトで表せる文字 → 上位・下位バイト */
let doubleByte: Map<string, [number, number]> | undefined;

/** CP932 に無い文字の代わり。**黙って消さない**ために置く */
const SUBSTITUTE = 0x3f; // '?'

function buildTables(): void {
  if (singleByte && doubleByte) return;
  const dec = new TextDecoder("shift_jis", { fatal: false });
  const single = new Map<string, number>();
  const double = new Map<string, [number, number]>();

  // 1 バイト: ASCII（0x00-0x7F）と半角カナ（0xA1-0xDF）
  for (let b = 0x00; b <= 0xff; b++) {
    if (b >= 0x81 && b <= 0x9f) continue;
    if (b >= 0xe0 && b <= 0xfc) continue;
    const ch = dec.decode(new Uint8Array([b]));
    // 復号できない／置換文字になったものは入れない
    if (ch.length === 1 && ch !== "�" && !single.has(ch)) single.set(ch, b);
  }

  // 2 バイト: 上位 0x81-0x9F / 0xE0-0xFC、下位 0x40-0xFC（0x7F を除く）
  const leads: number[] = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  for (const hi of leads) {
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([hi, lo]));
      if (ch.length !== 1 || ch === "�") continue;
      // **先に見つけたほうを使う**（同じ文字に複数のバイト列が当たる領域があるため、
      // 決定的にするには順序で決める必要がある）
      if (!double.has(ch)) double.set(ch, [hi, lo]);
    }
  }
  singleByte = single;
  doubleByte = double;
}

/** その文字は CP932 で表せるか */
export function encodable(ch: string): boolean {
  buildTables();
  return singleByte!.has(ch) || doubleByte!.has(ch);
}

/**
 * 文字列を CP932 のバイト列にする。
 *
 * **表せない文字は `?`（1 バイト）に落とす。** 落としたことは `substituted` で返す
 * ——黙って化けさせない（呼び出し側が警告に使える）。
 */
export function encodeCp932(text: string): { bytes: Uint8Array; substituted: number } {
  buildTables();
  const out: number[] = [];
  let substituted = 0;
  for (const ch of text) {
    const one = singleByte!.get(ch);
    if (one !== undefined) {
      out.push(one);
      continue;
    }
    const two = doubleByte!.get(ch);
    if (two) {
      out.push(two[0], two[1]);
      continue;
    }
    out.push(SUBSTITUTE);
    substituted += 1;
  }
  return { bytes: Uint8Array.from(out), substituted };
}

/**
 * CP932 のバイト列を文字列に戻す（HLLAPI から**入力**として渡された文字列用）。
 *
 * 呼び出し側は CP932 で書いてくるので、こちらで戻してから欄へ入れる。
 */
export function decodeCp932(bytes: Uint8Array): string {
  return new TextDecoder("shift_jis", { fatal: false }).decode(bytes);
}

/**
 * 画面 1 行ぶんの文字列を、**セル数と同じバイト数**に整える。
 *
 * 5250 の画面では全角が 2 桁を占め、CP932 でも 2 バイトなので普通は一致する。
 * ただし **CP932 に無い文字**（`?` 1 バイトに落ちる）や、
 * **DBCS の追従セル**の扱いで 1 バイトずれることがある。
 *
 * **ずれたら黙って直さない**——足りなければ空白で埋め、余ればそこで切る。
 * どちらの場合も何が起きたかを返す。
 */
export function fitToCells(text: string, cells: number): { bytes: Uint8Array; adjusted: number } {
  const { bytes } = encodeCp932(text);
  if (bytes.length === cells) return { bytes, adjusted: 0 };
  if (bytes.length < cells) {
    const padded = new Uint8Array(cells).fill(0x20);
    padded.set(bytes);
    return { bytes: padded, adjusted: cells - bytes.length };
  }
  return { bytes: bytes.slice(0, cells), adjusted: cells - bytes.length };
}
