/**
 * 純 DBCS（uconv_class "DBCS"）のコーデック。SQL の GRAPHIC / VARGRAPHIC 列が使う。
 *
 * 混在 CCSID（930/939/1399）と違い **SO/SI を持たず、常に 2 バイトで 1 文字**。
 * 状態を持たないため実装は DbcsCodec より単純。
 *
 * 参照: JTOpen 本体の ConvTable16684 / ConvTable300 に対応する
 *       （jtopenlite は GRAPHIC を UTF-16 の CCSID でしか扱わず、純 DBCS を実装していない）。
 */
import { CCSID300_FROM_UNICODE, CCSID300_TO_UNICODE } from "./ccsid300.js";
import { ibm1399 } from "./tables/ibm1399.js";
import type { DbcsPart, PureDbcsTable } from "./table-types.js";
import type { Codec } from "./codec.js";

const REPLACEMENT = 0xfffd;

/**
 * CCSID 16684。
 *
 * **新たに表を持たない**——CCSID 1399 は「SBCS 5123 ＋ DBCS 16684」という構成であり、
 * 既存 `ibm1399.ts` の DBCS 部が 16684 そのもの。ICU の ibm-16684_P110-2003.ucm と
 * 突き合わせて一致を確認済み（0x4260→U+2212 / 0x43A1→U+301C / subchar 0xFEFE ほか）。
 */
export const ibm16684: PureDbcsTable = {
  ccsid: 16684,
  name: "ibm-16684 (from ibm-1399 DBCS part)",
  part: ibm1399.dbcs
};

/**
 * CCSID 300 と 16684 の差分は `ccsid300.ts`（混在 CCSID 側と共用の単一の出所）。
 *
 * JTOpen 本体は 300 の表を独立生成せず `ConvTable300 extends ConvTable16684` として
 * **差分だけを当てる**。理由も原典のコメントにある——独立生成すると
 * 「マップされなくなるコードポイントが数千個」出て、既存アプリの挙動が変わるため。
 */

function applyDiff(
  base: DbcsPart,
  toUnicode: ReadonlyArray<readonly [number, number]>,
  fromUnicode: ReadonlyArray<readonly [number, number]>
): DbcsPart {
  const e2u = new Map(base.ebcdicToUnicode);
  for (const [bytes, cp] of toUnicode) e2u.set(bytes, cp);
  const u2e = new Map(base.unicodeToEbcdic);
  for (const [cp, bytes] of fromUnicode) u2e.set(cp, bytes);
  return { ebcdicToUnicode: e2u, unicodeToEbcdic: u2e, sub: base.sub };
}

/** CCSID 300。16684 に差分を当てたもの（上記参照） */
export const ibm300: PureDbcsTable = {
  ccsid: 300,
  name: "ibm-300 (ibm-16684 + ConvTable300 diffs)",
  part: applyDiff(ibm16684.part, CCSID300_TO_UNICODE, CCSID300_FROM_UNICODE)
};

/** 純 DBCS の変換（2 バイト固定） */
export class PureDbcsCodec implements Codec {
  readonly isDbcs = true;

  constructor(readonly table: PureDbcsTable) {}

  get ccsid(): number {
    return this.table.ccsid;
  }

  /**
   * 純 DBCS に 1 バイト文字は存在しない。
   * Codec インターフェースを満たすために置換文字を返す。
   */
  decodeByte(): number {
    return REPLACEMENT;
  }

  decodeDbcsPair(b1: number, b2: number): number {
    return this.table.part.ebcdicToUnicode.get((b1 << 8) | b2) ?? REPLACEMENT;
  }

  encodeDbcsChar(cp: number): number | undefined {
    return this.table.part.unicodeToEbcdic.get(cp);
  }

  /**
   * 2 バイトずつ 1 文字に畳む。SO/SI は解釈しない（純 DBCS には現れない）。
   * 末尾に 1 バイト余った場合は切り捨てる（不正なバイト列で例外にしない）。
   */
  decode(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(this.decodeDbcsPair(bytes[i]!, bytes[i + 1]!));
    }
    return out;
  }

  /** 文字列 → 2 バイト固定。マップ不能は SUB（0xFEFE 等）に置換し substituted に計上する */
  encode(text: string): { bytes: Uint8Array; substituted: number } {
    const chars = [...text];
    const out = new Uint8Array(chars.length * 2);
    let substituted = 0;
    let pos = 0;
    for (const ch of chars) {
      const mapped = this.encodeDbcsChar(ch.codePointAt(0)!);
      const pair = mapped ?? this.table.part.sub;
      if (mapped === undefined) substituted++;
      out[pos++] = (pair >> 8) & 0xff;
      out[pos++] = pair & 0xff;
    }
    return { bytes: out, substituted };
  }
}

const PURE_DBCS_TABLES = new Map<number, PureDbcsTable>([
  [16684, ibm16684],
  [300, ibm300]
]);

/**
 * GRAPHIC / VARGRAPHIC 列の CCSID からコーデックを得る。
 *
 * UTF-16 の CCSID（1200 / 13488）はここでは扱わない——EBCDIC ではないため
 * 呼び出し側で直接デコードする。
 */
export function pureDbcsCodecForCcsid(ccsid: number): PureDbcsCodec {
  const table = PURE_DBCS_TABLES.get(ccsid);
  if (!table) {
    throw new RangeError(
      `unsupported pure DBCS CCSID ${ccsid} (supported: ${[...PURE_DBCS_TABLES.keys()].join(", ")})`
    );
  }
  return new PureDbcsCodec(table);
}

/** 対応している純 DBCS の CCSID か */
export function isPureDbcsCcsid(ccsid: number): boolean {
  return PURE_DBCS_TABLES.has(ccsid);
}
