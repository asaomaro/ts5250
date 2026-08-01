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
  ccsidLabel
} from "../src/index.js";
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
 *   - `@as400web/tn5250`         … server の `pdf.ts` / `host-spools.ts`（`LogicalPage`）
 *   - `@as400web/tn5250/codec`   … server の `host-dtaq.ts`（`codecForCcsid`）
 *   - `@as400web/tn5250/browser` … web-ui の `IfsPane.vue`（`TEXT_CCSIDS` / `ccsidLabel`）、
 *                                `ScreenGrid.vue`（`katakanaChar`）
 *   - `@as400web/ebcdic` 直接  … 本リポジトリ内の core（切り出し後の正規の経路）
 */
describe("codec / SCS の再輸出（@as400web/tn5250 経由の後方互換）", () => {
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




  it("`/browser` サブパスから CCSID の一覧が取れる（web-ui の IfsPane.vue が使う）", () => {
    expect(catalogCcsids).toBe(TEXT_CCSIDS);
    expect(catalogLabel(1208)).toContain("UTF-8");
  });


  it("package.json の exports が `/codec` を再輸出ファサードに向けている", () => {
    // 上のテストは相対 import なので、`exports` マップを書き換えても気づけない。
    // 外の利用者が通るのはこのマップなので、宣言そのものを固定する。
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
      dependencies: Record<string, string>;
    };
    expect(pkg.exports["./browser"]!.default).toBe("./dist/browser.js");
    expect(pkg.dependencies["@as400web/ebcdic"]).toBeDefined();
  });
});
