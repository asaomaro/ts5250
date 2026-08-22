import { As400Error } from "@ts5250/base";

/**
 * **VT の世界の文字符号化。**
 *
 * 5250 / 3270 は EBCDIC だが、VT は ASCII の系譜——UTF-8 が既定で、日本語のホストでは
 * Shift_JIS / EUC-JP が現役である（IBM i の PASE や AIX のロケール）。
 *
 * ## 表を 1 バイトも持たない（spec D8）
 *
 * 実測（Node のフル ICU / ブラウザ）:
 *
 * | | `TextDecoder` | `TextEncoder` |
 * |---|---|---|
 * | utf-8 | OK | OK |
 * | shift_jis / euc-jp / iso-2022-jp | **OK** | **不可**（UTF-8 専用） |
 *
 * **復号は標準に任せられる。符号化だけが自前**になるが、変換表を同梱する必要は無い——
 * **`TextDecoder` に総当たりを通して逆引き表を実行時に組み立てる**。
 * `@ts5250/ebcdic` が変換表 18,900 行を抱えている轍を踏まない（AGENTS.md「バンドルサイズ」）。
 */
export type VtEncoding = "utf-8" | "shift_jis" | "euc-jp" | "iso-2022-jp";

export const VT_ENCODINGS: readonly VtEncoding[] = [
  "utf-8",
  "shift_jis",
  "euc-jp",
  "iso-2022-jp"
];

export function isVtEncoding(v: string): v is VtEncoding {
  return (VT_ENCODINGS as readonly string[]).includes(v);
}

/**
 * 届いたバイト列を文字へ。**多バイト文字が TCP のセグメント境界で割れても繋ぐ**ので、
 * 1 本の接続につき 1 つ作って使い回す。
 *
 * 不正なバイト列は `U+FFFD` に落ちる（**例外にしない**——端末は壊れた出力でも動き続ける）。
 */
export class VtDecoder {
  private readonly dec: TextDecoder;

  constructor(readonly encoding: VtEncoding = "utf-8") {
    // fatal:false が既定。**ここを true にしてはならない**（1 バイトの化けで接続が死ぬ）
    this.dec = new TextDecoder(encoding);
  }

  /** 続きが来る前提で復号する（末尾の中途半端なバイトは次回へ持ち越す） */
  decode(bytes: Uint8Array): string {
    return this.dec.decode(bytes, { stream: true });
  }

  /** 接続を閉じるときに、持ち越したバイトを吐き出す */
  flush(): string {
    return this.dec.decode();
  }
}

/**
 * 符号化の逆引き表。**`TextDecoder` に総当たりを通して作る**（同梱データはゼロ）。
 *
 * 作り方: 1 バイト（0x00-0xFF）→ 2 バイト（先頭 0x80-0xFF × 0x00-0xFF）の順に復号し、
 * **ちょうど 1 文字**になったものだけを採る。短い列を先に登録するので、
 * 同じ文字が 1 バイトでも 2 バイトでも表せる場合は 1 バイト側が残る。
 *
 * EUC-JP の 3 バイト（`0x8F` 始まり＝JIS X 0212）も拾う。
 */
class ReverseTable {
  private readonly map = new Map<string, Uint8Array>();

  constructor(encoding: Exclude<VtEncoding, "utf-8" | "iso-2022-jp">) {
    const dec = new TextDecoder(encoding, { fatal: false });
    const one = new Uint8Array(1);
    for (let b = 0; b < 0x100; b++) {
      one[0] = b;
      this.put(dec.decode(one), Uint8Array.of(b));
    }
    const two = new Uint8Array(2);
    for (let a = 0x80; a < 0x100; a++) {
      two[0] = a;
      for (let b = 0; b < 0x100; b++) {
        two[1] = b;
        this.put(dec.decode(two), Uint8Array.of(a, b));
      }
    }
    if (encoding === "euc-jp") {
      const three = new Uint8Array(3);
      three[0] = 0x8f;
      for (let a = 0xa1; a < 0xff; a++) {
        three[1] = a;
        for (let b = 0xa1; b < 0xff; b++) {
          three[2] = b;
          this.put(dec.decode(three), Uint8Array.of(0x8f, a, b));
        }
      }
    }
  }

  /** ちょうど 1 文字（サロゲート対を含む）で、置換文字でないものだけ登録する */
  private put(text: string, bytes: Uint8Array): void {
    if (text.length === 0 || text.includes("�")) return;
    if ([...text].length !== 1) return;
    if (this.map.has(text)) return; // 先に入った（＝より短い）列を優先する
    this.map.set(text, bytes);
  }

  get(ch: string): Uint8Array | undefined {
    return this.map.get(ch);
  }

  get size(): number {
    return this.map.size;
  }
}

/** 表は**要求されたときに初めて**作る（UTF-8 しか使わない利用者に費用を掛けない） */
const tables = new Map<string, ReverseTable>();

function tableFor(encoding: Exclude<VtEncoding, "utf-8" | "iso-2022-jp">): ReverseTable {
  let t = tables.get(encoding);
  if (t === undefined) {
    t = new ReverseTable(encoding);
    tables.set(encoding, t);
  }
  return t;
}

export interface EncodeResult {
  bytes: Uint8Array;
  /** その符号化で表せず落とした文字（重複なし）。**黙って消さないための報告** */
  dropped: string[];
}

const UTF8 = new TextEncoder();

/**
 * 文字をホストへ送るバイト列へ。
 *
 * 表せない文字は `?`（0x3F）に落とし、**何を落としたかを返す**。
 * 打鍵のたびに例外を投げると端末として使えないため、**落として報告する**方を採る。
 *
 * `iso-2022-jp` は**符号化に対応しない**（状態を持つ符号化で、打鍵の送出には向かない。
 * 受信だけ `VtDecoder` で扱える）。
 */
export function encodeText(text: string, encoding: VtEncoding = "utf-8"): EncodeResult {
  if (encoding === "utf-8") return { bytes: UTF8.encode(text), dropped: [] };
  if (encoding === "iso-2022-jp") {
    throw new As400Error(
      "CONFIG_ERROR",
      "iso-2022-jp は受信専用です（送信には utf-8 / shift_jis / euc-jp を使ってください）"
    );
  }
  const table = tableFor(encoding);
  const out: number[] = [];
  const dropped: string[] = [];
  for (const ch of text) {
    const bytes = table.get(ch);
    if (bytes === undefined) {
      out.push(0x3f);
      if (!dropped.includes(ch)) dropped.push(ch);
      continue;
    }
    for (const b of bytes) out.push(b);
  }
  return { bytes: Uint8Array.from(out), dropped };
}

/** 逆引き表に載っている文字数（試験・診断用） */
export function reverseTableSize(
  encoding: Exclude<VtEncoding, "utf-8" | "iso-2022-jp">
): number {
  return tableFor(encoding).size;
}
