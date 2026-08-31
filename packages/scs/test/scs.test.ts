import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ScsDecoder } from "../src/scs.js";
import { codecForCcsid } from "@ts5250/ebcdic";

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

  /**
   * **表示コード切替（カナ ⇄ 英）のために、桁ごとの生バイトを残す。**
   *
   * 復号済みの `lines` からは、CP290 と CP1027 のどちらの表で読むべきかを選び直せない
   * （両表はカタカナと英小文字の位置が入れ替わった鏡像なので、元のバイトが要る）。
   */
  it("SBCS の桁に生 EBCDIC バイトを残す", () => {
    const codec = codecForCcsid(1399);
    const pages = new ScsDecoder(1399).decode(codec.encode("AB").bytes);
    const raw = pages[0]!.raw!;
    expect(raw[0]![0]).toBe(0xc1); // A
    expect(raw[0]![1]).toBe(0xc2); // B
    // 読み直せば同じバイトから別の字が出る（＝切替の材料になっている）
    expect(String.fromCharCode(raw[0]![0]!)).not.toBe("A"); // EBCDIC のまま持っている
  });

  /** 全角とその継続桁には生バイトを残さない（読み直す対象ではない） */
  it("全角の桁には生バイトを残さない", () => {
    const codec = codecForCcsid(1399);
    const pages = new ScsDecoder(1399).decode(codec.encode("A日B").bytes);
    const raw = pages[0]!.raw!;
    expect(raw[0]![0]).toBe(0xc1); // A
    expect(raw[0]![1]).toBeUndefined(); // 日（前半）
    expect(raw[0]![2]).toBeUndefined(); // 日（継続桁）
    expect(raw[0]![3]).toBe(0xc2); // B
  });

  /**
   * **SO/SI の位置を残す。** SO/SI 自身は桁を占めない（この復号器は昔からシフトで桁を
   * 進めない）ので、`col` は**その直後に来る桁**を指す。印をどう描くかは描く側の判断で、
   * ここでは位置だけを渡す。
   */
  it("SO/SI の位置を残す（桁は占めない）", () => {
    const codec = codecForCcsid(1399);
    const pages = new ScsDecoder(1399).decode(codec.encode("A日B").bytes);
    const p = pages[0]!;
    expect(p.shifts![0]).toEqual([
      { col: 2, kind: "so" }, // A の次＝全角の始まり
      { col: 4, kind: "si" }  // 全角 2 桁のあと
    ]);
    // **桁は動いていない**（lines も cols もこれまでどおり）
    expect(p.lines[0]).toBe("A日B");
    expect(p.cols).toBe(4);
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
 * **ホストが SI でシフトを閉じないまま制御コードを送っても、制御として効くこと。**
 *
 * DBCS ラン中は「SO/SI 以外のすべてのバイト」を全角の先行バイトとして消費していたため、
 * 改行（NL）や改ページ（FF）が 2 バイト文字の一部として食われ、**U+FFFD が並んだうえ
 * 行・ページが繋がってしまう**不具合があった（利用者報告「一部の DBCS が化ける」）。
 *
 * SCS の制御はすべて 0x40 未満、DBCS の先行バイトは 0x40 以上（0x4040 の全角空白を含む）。
 * `wtd-applier` の `applyWtd` は元からこの境界で分けており、**両経路で同じ判定にする**のが要点。
 * 制御を処理したあとも `dbcsMode` は落とさない——ホストが SI を送るまでランは続いている。
 */
describe("ScsDecoder — SI を閉じないまま制御コードが来る帳票", () => {
  const SO = 0x0e;
  const SI = 0x0f;
  const NL = 0x15;
  const FF = 0x0c;
  const KI = [0x45, 0x79]; // 機
  const NOU = [0x47, 0x4f]; // 能
  const ZENSP = [0x40, 0x40]; // 全角空白
  const dec = (bytes: number[]) => new ScsDecoder(939).decode(Uint8Array.from(bytes));

  it("NL が改行として効き、前後の全角が化けない", () => {
    const pages = dec([SO, ...KI, NL, ...NOU, SI, FF]);
    expect(pages[0]!.lines).toEqual(["機", "能"]);
  });

  it("FF が改ページとして効く", () => {
    const pages = dec([SO, ...KI, FF, ...NOU, SI, FF]);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.lines[0]).toBe("機");
    expect(pages[1]!.lines[0]).toBe("能");
  });

  it("SI を閉じた通常の形は従来どおり（退行防止）", () => {
    const pages = dec([SO, ...KI, SI, NL, SO, ...NOU, SI, FF]);
    expect(pages[0]!.lines).toEqual(["機", "能"]);
  });

  it("奇数バイトの DBCS ランでも U+FFFD が延々と続かない", () => {
    // ラン内に半角空白 1 個が紛れてペアがずれる形。ずれ自体は避けられないが、
    // 後続の制御（FF）まで食い潰して同期を失わないことを固定する
    const pages = dec([SO, ...KI, 0x40, ...NOU, SI, FF]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lines[0]!.split("\uFFFD").length - 1).toBeLessThanOrEqual(2);
  });

  it("全角空白（0x4040）は行中で 2 桁の U+3000 のまま（退行防止）", () => {
    const pages = dec([SO, ...KI, ...ZENSP, ...NOU, SI, FF]);
    expect(pages[0]!.lines[0]).toBe("機\u3000能");
    expect(pages[0]!.cols).toBe(6); // 機(2) + 全角空白(2) + 能(2)
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
