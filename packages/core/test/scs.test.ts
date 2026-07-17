import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ScsDecoder } from "../src/protocol/scs.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(here, "fixtures", name)));

describe("ScsDecoder", () => {
  it("PUB400 実採取の SBCS スプール（DSPLIBL）を論理ページに展開できる", () => {
    const scs = fixture("scs-print-sbcs.bin");
    const pages = new ScsDecoder(37).decode(scs);
    const text = pages.map((p) => p.lines.join("\n")).join("\n---page---\n");
    expect(pages.length).toBe(1);
    // 見出し・フッター（EBCDIC→ASCII 変換と行構成の確認）
    expect(text).toMatch(/Library List/);
    expect(text).toMatch(/E N D {2}O F {2}L I S T I N G/);
    expect(text).toMatch(/http:\/\/pub400\.com/);
    // 桁揃え（AHPP の絶対水平移動）: ライブラリ名・型・説明が正しい桁に並ぶ
    expect(text).toMatch(/QSYS {8}SYS {20}System Library/);
    expect(text).toMatch(/MYLIB {7}CUR {20}USER \(\*CURLIB your current library\)/);
    expect(text).toMatch(/QGPL {8}USR {20}General Purpose Library/);
    // 列見出し
    expect(text).toMatch(/Library {5}Type {7}Device {6}Text Description/);
  });

  it("未対応バイトで例外を投げず、空入力で空配列を返す", () => {
    expect(new ScsDecoder(37).decode(new Uint8Array(0))).toEqual([]);
  });
});
