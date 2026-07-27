import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SbcsCodec,
  DbcsCodec,
  codecForCcsid,
  katakanaChar,
  SO,
  SI,
  PureDbcsCodec,
  pureDbcsCodecForCcsid,
  isPureDbcsCcsid,
  ibm300,
  ibm16684,
  decodeCcsidText,
  encodeCcsidText,
  isEbcdicCcsid,
  canDecodeCcsid,
  canEncodeCcsid,
  TEXT_CCSIDS,
  ccsidLabel,
  ScsDecoder
} from "../src/index.js";
import { codecForCcsid as codecFromSubpath, katakanaChar as katakanaFromSubpath } from "../src/codec/codec.js";
import { TEXT_CCSIDS as catalogCcsids, ccsidLabel as catalogLabel } from "../src/browser.js";

/**
 * codec / SCS を `@as400web/ebcdic` と `@as400web/scs` へ切り出した後の**後方互換**。
 *
 * core は実体を持たず再輸出するだけになったので、**列挙を 1 つ落としても core 内部は
 * 何も壊れず、型検査もビルドも通る**——壊れるのは外の利用者だけ、という気づけない
 * 種類の回帰になる。`Tn5250Error` → `As400Error` の改名時に実際に起きた
 * （`errors-compat.test.ts` 参照）ので、同じ轍を踏まないよう到達可能性を実行時に押さえる。
 *
 * 外の利用者は現時点で次の 4 経路:
 *   - `@as400web/core`         … server の `pdf.ts` / `host-spools.ts`（`LogicalPage`）
 *   - `@as400web/core/codec`   … server の `host-dtaq.ts`（`codecForCcsid`）
 *   - `@as400web/core/browser` … web-ui の `IfsPane.vue`（`TEXT_CCSIDS` / `ccsidLabel`）、
 *                                `ScreenGrid.vue`（`katakanaChar`）
 *   - `@as400web/ebcdic` 直接  … 本リポジトリ内の core（切り出し後の正規の経路）
 */
describe("codec / SCS の再輸出（@as400web/core 経由の後方互換）", () => {
  it("root から文字変換の公開面がすべて取れる", () => {
    for (const sym of [
      SbcsCodec,
      DbcsCodec,
      codecForCcsid,
      katakanaChar,
      PureDbcsCodec,
      pureDbcsCodecForCcsid,
      isPureDbcsCcsid,
      decodeCcsidText,
      encodeCcsidText,
      isEbcdicCcsid,
      canDecodeCcsid,
      canEncodeCcsid,
      ccsidLabel
    ]) {
      expect(sym).toBeTypeOf("function");
    }
    expect(SO).toBe(0x0e);
    expect(SI).toBe(0x0f);
    expect(ibm300.ccsid).toBe(300);
    expect(ibm16684.ccsid).toBe(16684);
    expect(TEXT_CCSIDS.length).toBeGreaterThan(0);
  });

  it("root から取った codec が実際に変換できる", () => {
    // EBCDIC 37: 'A'=0xC1 / 'a'=0x81 / '0'=0xF0
    const codec = codecForCcsid(37);
    expect(codec).toBeInstanceOf(SbcsCodec);
    expect(codec.decode(Uint8Array.of(0xc1, 0x81, 0xf0))).toBe("Aa0");
    expect(codecForCcsid(930)).toBeInstanceOf(DbcsCodec);
    expect(pureDbcsCodecForCcsid(300)).toBeInstanceOf(PureDbcsCodec);
  });

  it("root から ScsDecoder が取れて論理ページを返す", () => {
    expect(ScsDecoder).toBeTypeOf("function");
    // 'AB' + NL(0x15) + 'C' を 1 ページに展開する
    const pages = new ScsDecoder(37).decode(Uint8Array.of(0xc1, 0xc2, 0x15, 0xc3));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lines).toEqual(["AB", "C"]);
  });

  it("`/codec` サブパスが server の host-dtaq.ts と同じ使い方で動く", () => {
    expect(codecFromSubpath).toBe(codecForCcsid);
    expect(codecFromSubpath(37).encode("AB").bytes).toEqual(Uint8Array.of(0xc1, 0xc2));
    expect(codecFromSubpath(37).decode(Uint8Array.of(0xc1, 0xc2))).toBe("AB");
  });

  it("`/codec` サブパスから katakanaChar が取れる（後方互換。現在の利用側は無い）", () => {
    // web-ui は `@as400web/core/browser` 経由に移した（表を引き込まないため。
    // `20260726-ccsid-table-bundling`）。この経路は外部利用者のために残している。
    expect(katakanaFromSubpath).toBe(katakanaChar);
    // 0x81 は 37 では 'a'、930 の SBCS 部（カタカナ）では別字に化ける
    expect(katakanaFromSubpath(0x81)).not.toBe("a");
    expect(katakanaFromSubpath(0x40)).toBe(" ");
  });

  it("`/browser` サブパスから CCSID の一覧が取れる（web-ui の IfsPane.vue が使う）", () => {
    expect(catalogCcsids).toBe(TEXT_CCSIDS);
    expect(catalogLabel(1208)).toContain("UTF-8");
  });

  it("ファサードはバレルではなく `@as400web/ebcdic/codec`（狭い入口）を参照する", () => {
    // バレル（`@as400web/ebcdic`）に向けると pure-dbcs / ccsid-text まで module graph に
    // 入り、web-ui の本番バンドルが 628 バイト増える（実測。decisions.md D2）。
    // **ビルドもテストも通ってしまう**種類の劣化なので、参照先そのものを固定する。
    const here = dirname(fileURLToPath(import.meta.url));
    const facade = readFileSync(join(here, "..", "src", "codec", "codec.ts"), "utf8");
    expect(facade).toContain('from "@as400web/ebcdic/codec"');
    expect(facade).not.toMatch(/from "@as400web\/ebcdic"/);
  });

  it("package.json の exports が `/codec` を再輸出ファサードに向けている", () => {
    // 上のテストは相対 import なので、`exports` マップを書き換えても気づけない。
    // 外の利用者が通るのはこのマップなので、宣言そのものを固定する。
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
      dependencies: Record<string, string>;
    };
    expect(pkg.exports["./codec"]!.default).toBe("./dist/codec/codec.js");
    expect(pkg.exports["./browser"]!.default).toBe("./dist/browser.js");
    expect(pkg.dependencies["@as400web/ebcdic"]).toBeDefined();
    expect(pkg.dependencies["@as400web/scs"]).toBeDefined();
  });
});
