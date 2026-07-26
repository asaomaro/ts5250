import { CCSID300_TO_UNICODE } from "./ccsid300.js";
import type { SbcsTable, StatefulTable } from "./table-types.js";
import { ibm37 } from "./tables/ibm37.js";
import { ibm273 } from "./tables/ibm273.js";
import { ibm930 as ibm930Ucm } from "./tables/ibm930.js";
import { ibm939 as ibm939Ucm } from "./tables/ibm939.js";
import { ibm1399 } from "./tables/ibm1399.js";

/** SO（Shift Out・DBCS モードへ）/ SI（Shift In・SBCS モードへ）制御文字 */
export const SO = 0x0e;
export const SI = 0x0f;

/**
 * **930/939 の DBCS 部は CCSID 300**（16684 を使うのは 1399 だけ）。ICU の ucm は 300 の
 * 5 文字を Unicode 規格寄り（U+2212 等）に割り当てるが、ACS / jt400 は全角形（U+FF0D 等）を
 * 返す。ACS と同じ結果を正とするので、デコード側だけ `ccsid300.ts` の割り当てに寄せる。
 *
 * 逆方向は ucm の時点でどちらの符号位置からも同じバイト対へ寄っている（往復は変わらない）ため
 * 差し替えない。表示の実害は PDM の F1 ヘルプ「オプション−ヘルプ」で実測——U+2212 は East Asian
 * Width が Ambiguous で欧文等幅フォントが 1 桁に描き、以降の桁が左へずれる。
 */
function withCcsid300Dbcs(table: StatefulTable): StatefulTable {
  const ebcdicToUnicode = new Map(table.dbcs.ebcdicToUnicode);
  for (const [bytes, cp] of CCSID300_TO_UNICODE) ebcdicToUnicode.set(bytes, cp);
  return { ...table, dbcs: { ...table.dbcs, ebcdicToUnicode } };
}

const ibm930: StatefulTable = withCcsid300Dbcs(ibm930Ucm);
const ibm939: StatefulTable = withCcsid300Dbcs(ibm939Ucm);

/** SBCS / DBCS 共通のコーデックインターフェース */
export interface Codec {
  readonly ccsid: number;
  readonly isDbcs: boolean;
  decodeByte(byte: number): number;
  decode(bytes: Uint8Array): string;
  encode(text: string): { bytes: Uint8Array; substituted: number };
  /** DBCS 2 バイトを Unicode に（DBCS コーデックのみ。SBCS は undefined） */
  decodeDbcsPair?(b1: number, b2: number): number;
  /** Unicode を DBCS 2 バイト(b1<<8|b2)に（マップ不能は undefined） */
  encodeDbcsChar?(cp: number): number | undefined;
}

/** SBCS の EBCDIC ⇔ Unicode 変換（ピュアロジック・Node API 非依存） */
export class SbcsCodec implements Codec {
  readonly isDbcs = false;
  constructor(readonly table: SbcsTable) {}

  get ccsid(): number {
    return this.table.ccsid;
  }

  /** EBCDIC バイト 1 個 → Unicode コードポイント（未定義は U+FFFD） */
  decodeByte(byte: number): number {
    return this.table.ebcdicToUnicode[byte & 0xff] ?? 0xfffd;
  }

  /** EBCDIC バイト列 → 文字列（未定義は U+FFFD で可視化） */
  decode(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(this.table.ebcdicToUnicode[b] ?? 0xfffd);
    return out;
  }

  /**
   * 文字列 → EBCDIC バイト列。マップ不能文字は SUB（0x3F）に置換し、置換数を返す
   * （呼び出し側で substituted > 0 を警告ログにする。spec「変換不能文字」）。
   */
  encode(text: string): { bytes: Uint8Array; substituted: number } {
    const bytes = new Uint8Array(text.length);
    let substituted = 0;
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      const b = this.table.unicodeToEbcdic.get(cp);
      if (b === undefined) {
        bytes[i] = this.table.sub;
        substituted++;
      } else {
        bytes[i] = b;
      }
    }
    return { bytes, substituted };
  }
}

/**
 * EBCDIC_STATEFUL（DBCS）の EBCDIC ⇔ Unicode 変換。
 * SO(0x0E)/SI(0x0F) でモード遷移。SBCS 部は 1 バイト、DBCS 部は 2 バイト（SO..SI で囲む）。
 */
export class DbcsCodec implements Codec {
  readonly isDbcs = true;
  constructor(readonly table: StatefulTable) {}

  get ccsid(): number {
    return this.table.ccsid;
  }

  /** SBCS モードの 1 バイトデコード（SO/SI をまたがない用途。DBCS は decode を使う） */
  decodeByte(byte: number): number {
    return this.table.sbcs.ebcdicToUnicode[byte & 0xff] ?? 0xfffd;
  }

  /** DBCS 2 バイト → Unicode */
  decodeDbcsPair(b1: number, b2: number): number {
    return this.table.dbcs.ebcdicToUnicode.get((b1 << 8) | b2) ?? 0xfffd;
  }

  /** Unicode → DBCS 2 バイト(b1<<8|b2)。マップ不能は undefined */
  encodeDbcsChar(cp: number): number | undefined {
    return this.table.dbcs.unicodeToEbcdic.get(cp);
  }

  /** SO/SI ステートマシンでバイト列を文字列にデコードする（DBCS は 1 文字に畳む） */
  decode(bytes: Uint8Array): string {
    let out = "";
    let dbcs = false;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b === SO) {
        dbcs = true;
        continue;
      }
      if (b === SI) {
        dbcs = false;
        continue;
      }
      if (dbcs) {
        const b2 = bytes[++i];
        if (b2 === undefined) break;
        const cp = this.table.dbcs.ebcdicToUnicode.get((b << 8) | b2);
        out += String.fromCharCode(cp ?? 0xfffd);
      } else {
        out += String.fromCharCode(this.table.sbcs.ebcdicToUnicode[b] ?? 0xfffd);
      }
    }
    return out;
  }

  /**
   * 文字列 → EBCDIC バイト列。SBCS 文字はそのまま、DBCS 文字は SO..SI で囲んで 2 バイトで出す。
   * 連続する DBCS 文字は 1 組の SO/SI にまとめる。マップ不能は SUB に置換し substituted に計上。
   */
  encode(text: string): { bytes: Uint8Array; substituted: number } {
    const out: number[] = [];
    let substituted = 0;
    let dbcs = false;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const sb = this.table.sbcs.unicodeToEbcdic.get(cp);
      if (sb !== undefined) {
        if (dbcs) {
          out.push(SI);
          dbcs = false;
        }
        out.push(sb);
        continue;
      }
      const db = this.table.dbcs.unicodeToEbcdic.get(cp);
      if (db !== undefined) {
        if (!dbcs) {
          out.push(SO);
          dbcs = true;
        }
        out.push((db >> 8) & 0xff, db & 0xff);
        continue;
      }
      // マップ不能: SBCS SUB
      if (dbcs) {
        out.push(SI);
        dbcs = false;
      }
      out.push(this.table.sbcs.sub);
      substituted++;
    }
    if (dbcs) out.push(SI);
    return { bytes: Uint8Array.from(out), substituted };
  }
}

/**
 * 日本語 SBCS。**混在 CCSID の SBCS 部そのもの**なので、表を作り直さず借りる。
 * 290 = 930 の SBCS 部（カタカナ）、1027 = 939 の SBCS 部（英小文字）。
 *
 * DB2 の列は混在 CCSID ではなく SBCS の CCSID を持つことがあり（日本語機の CHAR 列など）、
 * 未登録だと SQL やデータ取得が `unsupported CCSID 290` で落ちる。
 */
const ibm290: SbcsTable = { ...ibm930.sbcs, ccsid: 290, name: "ibm-290 (930 SBCS 部)" };
const ibm1027: SbcsTable = { ...ibm939.sbcs, ccsid: 1027, name: "ibm-1027 (939 SBCS 部)" };

const SBCS_TABLES: ReadonlyMap<number, SbcsTable> = new Map([
  [37, ibm37],
  [273, ibm273],
  [290, ibm290],
  [1027, ibm1027]
]);
const DBCS_TABLES: ReadonlyMap<number, StatefulTable> = new Map([
  [930, ibm930],
  [939, ibm939],
  [1399, ibm1399],
  // CCSID エイリアス（research F4）: 931/5035 = 939、5026 = 930
  [931, ibm939],
  [5035, ibm939],
  [5026, ibm930]
]);

/**
 * 生 EBCDIC バイトをカタカナ SBCS（CCSID 930 の SBCS 部）で再解釈する。
 * ACS の表示コード切替（半角カナ⇔英小文字）用。英小文字位置がカタカナに化ける。
 */
export function katakanaChar(byte: number): string {
  return String.fromCharCode(ibm930.sbcs.ebcdicToUnicode[byte & 0xff] ?? 0xfffd);
}

/** CCSID → codec。37=SBCS、930/939/1399（＋エイリアス）=DBCS */
export function codecForCcsid(ccsid: number): Codec {
  const sbcs = SBCS_TABLES.get(ccsid);
  if (sbcs) return new SbcsCodec(sbcs);
  const dbcs = DBCS_TABLES.get(ccsid);
  if (dbcs) return new DbcsCodec(dbcs);
  throw new RangeError(
    `unsupported CCSID ${ccsid} (supported: ${[...SBCS_TABLES.keys(), ...DBCS_TABLES.keys()].join(", ")})`
  );
}
