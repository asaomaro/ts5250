import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ScsDecoder } from "../src/scs.js";
import { codecForCcsid } from "@as400web/ebcdic";

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

  it("PUB400 実採取の DBCS スプール（DSPLIBL・CCSID 1399）を帳票化できる", () => {
    const scs = fixture("scs-print-dbcs.bin");
    const pages = new ScsDecoder(1399).decode(scs);
    const text = pages.map((p) => p.lines.join("\n")).join("\n");
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(text).toMatch(/Library List/);
    // MYLIB 行のテキスト説明に日本語（CHGLIB で設定）が桁揃えで載る
    expect(text).toMatch(/MYLIB {7}CUR {20}日本語テスト/);
    // 英数の行は従来どおり
    expect(text).toMatch(/QSYS {8}SYS {20}System Library/);
  });

  it("DBCS（CCSID 1399）: SO/SI で囲まれた全角を 2 桁のグリフに展開する", () => {
    // codec.encode は SBCS＋SO..SI 枠付き EBCDIC を出す（＝SCS のデータ相当）。往復で一致することを確認
    const codec = codecForCcsid(1399);
    const scs = codec.encode("AB日本語CD").bytes;
    const pages = new ScsDecoder(1399).decode(scs);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lines[0]).toBe("AB日本語CD");
    // 全角は 2 桁を占める（後半桁は継続の空文字列）。AB(2)＋日本語(6)＋CD(2)=10 桁
    expect(pages[0]!.cols).toBe(10);
  });

  it("DBCS 全角の直後に SBCS が続いても桁がずれない（NL 跨ぎ）", () => {
    const codec = codecForCcsid(1399);
    const line1 = codec.encode("名前").bytes; // 全角2文字=4桁
    const scs = Uint8Array.from([...line1, 0x15, ...codec.encode("X").bytes]); // NL(0x15) で次行に X
    const pages = new ScsDecoder(1399).decode(scs);
    expect(pages[0]!.lines[0]).toBe("名前");
    expect(pages[0]!.lines[1]).toBe("X");
  });
});

/**
 * **0x2B 0xFD（IGC/DBCS 制御）を読み飛ばせること。**
 *
 * 日本語機の業務帳票（DSPFMT のレコード設計書）が 1 ページも取れなかった原因。
 * 帳票の先頭付近にこのオーダーが並び、未知として打ち切っていたため decode が空配列を返した。
 * 構造は 0xD2 と同じ長さ前置（len は自身を含む）。実機で観測した 3 パターンをそのまま使う。
 *
 * 業務データはフィクスチャにできないので、観測したオーダーだけを合成して固定する。
 */
describe("SCS: IGC 制御オーダー 0x2BFD", () => {
  /** 実機で観測した 3 つの 2B FD（len 前置） */
  const IGC_ORDERS = [
    [0x2b, 0xfd, 0x06, 0x01, 0x00, 0x00, 0x00, 0xc0],
    [0x2b, 0xfd, 0x04, 0x03, 0x00, 0x01],
    [0x2b, 0xfd, 0x04, 0x02, 0x10, 0x00]
  ].flat();

  it("IGC オーダーの後ろの本文を取りこぼさない", () => {
    const codec = codecForCcsid(939);
    const body = [...codec.encode("設計書").bytes];
    const pages = new ScsDecoder(939).decode(Uint8Array.from([...IGC_ORDERS, ...body]));
    expect(pages.length, "IGC オーダーで打ち切らない").toBe(1);
    expect(pages[0]!.lines.join("")).toContain("設計書");
  });

  it("打ち切りの警告を出さない", () => {
    const warns: string[] = [];
    const codec = codecForCcsid(939);
    const body = [...codec.encode("あ").bytes];
    new ScsDecoder(939, (m) => warns.push(m)).decode(Uint8Array.from([...IGC_ORDERS, ...body]));
    expect(warns).toEqual([]);
  });

  it("長さ前置どおりに消費する（続く本文がずれない）", () => {
    const codec = codecForCcsid(939);
    // IGC オーダー → "AB" → IGC オーダー → "CD"
    const bytes = Uint8Array.from([
      ...IGC_ORDERS.slice(0, 8), // 1 つ目だけ
      ...codec.encode("AB").bytes,
      ...IGC_ORDERS.slice(8), // 残り 2 つ
      ...codec.encode("CD").bytes
    ]);
    const pages = new ScsDecoder(939).decode(bytes);
    expect(pages[0]!.lines.join("")).toBe("ABCD");
  });
});
