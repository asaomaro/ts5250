import { describe, it, expect, vi } from "vitest";
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
    // MYLIB 行のテキスト説明に日本語（CHGLIB で設定）が載る。**SO が 1 桁の空白を占める**ので、説明欄の頭（38 桁目）の
    // 次から始まる（ACS `PrintSCS5250DB.shiftOut` の既定。~~`{20}` で 38 桁目から＝SO は桁を占めない~~。`20260921-scs-sosi-columns`）
    expect(text).toMatch(/MYLIB {7}CUR {21}日本語テスト/);
    // 英数の行は従来どおり
    expect(text).toMatch(/QSYS {8}SYS {20}System Library/);
  });

  it("DBCS（CCSID 1399）: SO/SI で囲まれた全角を 2 桁のグリフに展開する", () => {
    // codec.encode は SBCS＋SO..SI 枠付き EBCDIC を出す（＝SCS のデータ相当）。往復で一致することを確認
    const codec = codecForCcsid(1399);
    const scs = codec.encode("AB日本語CD").bytes;
    const pages = new ScsDecoder(1399).decode(scs);
    expect(pages).toHaveLength(1);
    // SO・SI は既定で 1 桁ずつ空白を占める（ACS）
    expect(pages[0]!.lines[0]).toBe("AB 日本語 CD");
    // 全角は 2 桁を占める（後半桁は継続の空文字列）。AB(2)＋SO(1)＋日本語(6)＋SI(1)＋CD(2)=12 桁
    expect(pages[0]!.cols).toBe(12);
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
    expect(raw[0]![1]).toBeUndefined(); // SO の桁
    expect(raw[0]![2]).toBeUndefined(); // 日（前半）
    expect(raw[0]![3]).toBeUndefined(); // 日（継続桁）
    expect(raw[0]![4]).toBeUndefined(); // SI の桁
    expect(raw[0]![5]).toBe(0xc2); // B
  });

  /**
   * **SO/SI は既定で 1 桁ずつ空白を占める**（ACS `PrintSCS5250DB` の `spccBehavior` 既定 1。`20260921-scs-sosi-columns`）。
   * ~~SO/SI 自身は桁を占めない~~ は `20260728-scs-dbcs-column-align` D1 の決定で、ACS の描き方と違った。
   * `col` は SO/SI が占める桁を指す。
   */
  it("SO/SI の位置を残す（既定では 1 桁ずつ占める）", () => {
    const codec = codecForCcsid(1399);
    const pages = new ScsDecoder(1399).decode(codec.encode("A日B").bytes);
    const p = pages[0]!;
    expect(p.shifts![0]).toEqual([
      { col: 2, kind: "so", width: 1 }, // A の次＝SO の桁
      { col: 5, kind: "si", width: 1 }  // 全角 2 桁のあと＝SI の桁
    ]);
    expect(p.lines[0]).toBe("A 日 B");
    expect(p.cols).toBe(6);
  });

  /** ホストの SPCC（`2B FD len 03 値`）で描き方が切り替わる（ACS `setPresentationControlCharacter`） */
  it.each([
    ["00 00＝占めない", [0x00, 0x00], "A日B"],
    ["00 01＝1 桁ずつ（日本語機が送ってくる値）", [0x00, 0x01], "A 日 B"],
    ["00 02＝SO は占めず SI が 2 桁", [0x00, 0x02], "A日  B"],
    ["範囲外（00 03）は既定の 1 桁ずつ", [0x00, 0x03], "A 日 B"]
  ])("SPCC %s", (_l, value, expected) => {
    const codec = codecForCcsid(1399);
    const scs = Uint8Array.from([0x2b, 0xfd, 0x04, 0x03, ...value, ...codec.encode("A日B").bytes]);
    expect(new ScsDecoder(1399).decode(scs)[0]!.lines[0]).toBe(expected);
  });

  /** ACS の JPS は SO/SI を状態に関わらず毎回処理し、**空白を書かずに位置を進める**（独立点検の指摘） */
  it("**冗長な SO も毎回 1 桁進める**（~~読み飛ばす~~）", () => {
    const codec = codecForCcsid(1399);
    const hi = codec.encode("日").bytes; // SO 日 SI
    const scs = Uint8Array.from([hi[0]!, hi[1]!, hi[2]!, hi[0]!, hi[1]!, hi[2]!, hi[3]!, 0xc2]); // SO 日 SO 日 SI B
    expect(new ScsDecoder(1399).decode(scs)[0]!.lines[0]).toBe(" 日 日 B");
  });
  it("**SBCS の状態で来た SI も 1 桁進める**（日本語機の DSPLIBL の先頭にある形）", () => {
    expect(new ScsDecoder(1399).decode(Uint8Array.from([0x0f, 0xc1]))[0]!.lines[0]).toBe(" A");
  });
  it("**FF の後に SI だけが来ても空のページを作らない**（SO/SI は書かずに位置を進めるだけ）", () => {
    const codec = codecForCcsid(1399);
    const scs = Uint8Array.from([...codec.encode("A日").bytes.slice(0, -1), 0x0c, 0x0f]); // A SO 日 FF SI
    expect(new ScsDecoder(1399).decode(scs)).toHaveLength(1);
  });
  it("**CR で戻った重ね打ちの行で、SO/SI が下の字を消さない**", () => {
    const codec = codecForCcsid(1399);
    const scs = Uint8Array.from([...codec.encode("ABCDEFGH").bytes, 0x0d, ...codec.encode("日").bytes]);
    expect(new ScsDecoder(1399).decode(scs)[0]!.lines[0]).toBe("A日DEFGH");
  });
  /**
   * **空白は下の字を消さない**（ACS の JPS は 1 字ずつ描くだけで何も消さない。`20260922-scs-blank-overprint`）。期待値は本物の JPS を headless で動かした記録
   * （調査 R11 の合成ベクタ。`ABCDEF` CR `␠␠␠XY` は A B C が残り D・E に X・Y が重なる）
   */
  it("**CR で戻った重ね書きの空白は、下の字を消さない**（`ABCDEF` CR `␠␠␠XY` → `ABCXYF`）", () => {
    const c = codecForCcsid(37);
    const scs = Uint8Array.from([...c.encode("ABCDEF").bytes, 0x0d, ...c.encode("   XY").bytes]);
    expect(new ScsDecoder(37).decode(scs)[0]!.lines[0]).toBe("ABCXYF");
  });

  it("非空白の字の重ね書きは今までどおり後の字が残る（両方を残す重ね層は未対応。台帳）", () => {
    const c = codecForCcsid(37);
    const scs = Uint8Array.from([...c.encode("ABCDEF").bytes, 0x0d, ...c.encode("XY").bytes]);
    expect(new ScsDecoder(37).decode(scs)[0]!.lines[0]).toBe("XYCDEF");
  });

  it("空白だけを重ねても下の字は残る。生バイトも下の字のまま", () => {
    const c = codecForCcsid(37);
    const scs = Uint8Array.from([...c.encode("ABC").bytes, 0x0d, ...c.encode("   ").bytes]);
    const page = new ScsDecoder(37).decode(scs)[0]!;
    expect(page.lines[0]).toBe("ABC");
    expect(page.raw?.[0]?.slice(0, 3)).toEqual([0xc1, 0xc2, 0xc3]);
  });

  it("**全角の字の 2 桁目（継続桁）に半角の空白が来ても、全角の字を壊さない**", () => {
    const c = codecForCcsid(1399);
    const spcc0 = [0x2b, 0xfd, 0x04, 0x03, 0x00, 0x00];
    // 日 CR ␠␠ X: 1 桁目・2 桁目の空白はどちらも下の字（日）の上を通り過ぎ、X は 3 桁目
    const scs = Uint8Array.from([...spcc0, ...c.encode("日").bytes, 0x0d, ...c.encode("  X").bytes]);
    expect(new ScsDecoder(1399).decode(scs)[0]!.lines[0]).toBe("日X");
  });

  it("行末の空白の桁も、ページの桁数（`cols`）に数える（従来どおり）", () => {
    const c = codecForCcsid(37);
    const page = new ScsDecoder(37).decode(c.encode("AB   ").bytes)[0]!;
    expect(page.cols).toBe(5);
    expect(page.lines[0]).toBe("AB");
  });

  it("何も無い桁への空白は今までどおり（字と字の間の空白・行末の空白の桁）", () => {
    const c = codecForCcsid(37);
    expect(new ScsDecoder(37).decode(c.encode("A  B").bytes)[0]!.lines[0]).toBe("A  B");
  });

  it("**全角空白も下の字を消さない**（全角の字の上・半角 2 字の上・半角 1 字が半分にかかる形）。何も無い桁なら書く", () => {
    const c = codecForCcsid(1399);
    const wideBlank = c.encode("\u3000").bytes; // SO 4040 SI
    const spcc0 = [0x2b, 0xfd, 0x04, 0x03, 0x00, 0x00]; // SO・SI を 0 桁にして、全角空白を 1 桁目から置く
    const over = (under: string): string =>
      new ScsDecoder(1399).decode(Uint8Array.from([...spcc0, ...c.encode(under).bytes, 0x0d, ...wideBlank, ...c.encode("X").bytes]))[0]!.lines[0]!;
    // 後ろに X を置く（行末の空白は帳票では切り落とされ、全角空白も含まれるため）
    expect(over("日"), "全角の字の上").toBe("日X");
    expect(over("AB"), "半角 2 字の上").toBe("ABX");
    expect(over(" A"), "半角 1 字が 2 桁目にかかる").toBe(" AX");
    expect(over("  "), "空白だけの桁には書く").toBe("\u3000X");
  });

  it("SPCC は同じデコーダーのジョブをまたいで残る（ACS は印刷のセッションで 1 回だけ初期化）", () => {
    const codec = codecForCcsid(1399);
    const d = new ScsDecoder(1399);
    d.decode(Uint8Array.from([0x2b, 0xfd, 0x04, 0x03, 0x00, 0x00, 0xc1]));
    expect(d.decode(codec.encode("A日B").bytes)[0]!.lines[0]).toBe("A日B");
  });
  it("SPCC の負の値は SO が 0 桁・SI が 1 桁（ACS は符号付きで読む）", () => {
    const codec = codecForCcsid(1399);
    const scs = Uint8Array.from([0x2b, 0xfd, 0x04, 0x03, 0xff, 0xff, ...codec.encode("A日B").bytes]);
    expect(new ScsDecoder(1399).decode(scs)[0]!.lines[0]).toBe("A日 B");
  });

  it("SPCC の長さが 2 なら値なしで 1 桁ずつ、2・4 以外の長さは受けない（切り替えない）", () => {
    const codec = codecForCcsid(1399);
    const none = [0x2b, 0xfd, 0x04, 0x03, 0x00, 0x00];
    const len2 = Uint8Array.from([...none, 0x2b, 0xfd, 0x02, 0x03, ...codec.encode("A日B").bytes]);
    expect(new ScsDecoder(1399).decode(len2)[0]!.lines[0]).toBe("A 日 B");
    const len3 = Uint8Array.from([...none, 0x2b, 0xfd, 0x03, 0x03, 0x01, ...codec.encode("A日B").bytes]);
    expect(new ScsDecoder(1399).decode(len3)[0]!.lines[0], "長さ 3 は受けないので 00 00 のまま").toBe("A日B");
  });

  it("DBCS 全角の直後に SBCS が続いても桁がずれない（NL 跨ぎ）", () => {
    const codec = codecForCcsid(1399);
    const line1 = codec.encode("名前").bytes; // 全角2文字=4桁
    const scs = Uint8Array.from([...line1, 0x15, ...codec.encode("X").bytes]); // NL(0x15) で次行に X
    const pages = new ScsDecoder(1399).decode(scs);
    expect(pages[0]!.lines[0]).toBe(" 名前"); // SO の 1 桁
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
    expect(pages[0]!.lines).toEqual([" 機", "能"]); // 先頭の空白は SO の桁（ACS の既定）
  });

  it("FF が改ページとして効く", () => {
    const pages = dec([SO, ...KI, FF, ...NOU, SI, FF]);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.lines[0]).toBe(" 機");
    expect(pages[1]!.lines[0]).toBe("能");
  });

  it("SI を閉じた通常の形は従来どおり（退行防止）", () => {
    const pages = dec([SO, ...KI, SI, NL, SO, ...NOU, SI, FF]);
    expect(pages[0]!.lines).toEqual([" 機", " 能"]);
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
    expect(pages[0]!.lines[0]).toBe(" 機\u3000能");
    // SO(1) + 機(2) + 全角空白(2) + 能(2)。SI は位置を進めるだけで書かないので、後ろに字が無ければ桁に数えない
    expect(pages[0]!.cols).toBe(7);
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

/**
 * **制御の表は ACS と同じ**（`PrintSCS5250` の `scs_proc`。`20260921-scs-controls-acs`）。
 * 以前は表に無い制御を印字文字として桁に置き、0x03 を EBCDIC の透過として読み、長さの前置を持つ 2B の
 * オーダーを固定長で読んで、知らないオーダーで帳票の残りを打ち切っていた。
 */
describe("SCS: 制御の表（ACS と同じ）", () => {
  const E = (t: string): number[] => [...t].map((c) => ({ A: 0xc1, B: 0xc2, C: 0xc3, D: 0xc4, X: 0xe7, Y: 0xe8 })[c as "A"]!);
  const lines = (bytes: number[], ccsid = 37): string[] => new ScsDecoder(ccsid).decode(Uint8Array.from(bytes))[0]?.lines ?? [];

  it("**LF（0x25）は次の行へ、桁はそのまま**", () => {
    expect(lines([...E("AB"), 0x25, ...E("C")])).toEqual(["AB", "  C"]);
  });
  it("IRS（0x1E）は NL と同じく次の行の頭へ", () => {
    expect(lines([...E("AB"), 0x1e, ...E("C")])).toEqual(["AB", "C"]);
  });
  it("BS（0x16）は何もしない（JPS。~~1 桁戻って上書き~~ は PDT 経路）", () => {
    expect(lines([...E("AB"), 0x16, ...E("X")])).toEqual(["ABX"]);
  });
  it("HT（0x05）は 1 桁の空白（JPS の `JPSHorizontalTab` は空白 1 つ）", () => {
    expect(lines([...E("A"), 0x05, ...E("B")])).toEqual(["A B"]);
  });
  it("VT（0x0B）はタブ位置が無いので LF と同じ", () => {
    expect(lines([...E("A"), 0x0b, ...E("B")])).toEqual(["A", " B"]);
  });
  it("**TRN（0x35）は長さ＋本体。本体は 1 バイトごとに 0x40 なら空白、ほかは `-`**（JPS `processTransparent`）", () => {
    expect(lines([0x35, 0x04, 0xe7, 0x40, 0x0d, 0xe8, ...E("A")])).toEqual(["- --A"]);
  });
  it("**ATRN（0x03）は ASCII 透過なので置かずに読み飛ばす**（~~EBCDIC の透過~~）", () => {
    expect(lines([0x03, 0x03, 0x1b, 0x45, 0x41, ...E("A")])).toEqual(["A"]);
  });
  it("**表に無い 0x40 未満は印字しない**（~~文字として桁に置く~~。日本語機では SBCS の状態の SI が「�」になっていた）", () => {
    expect(lines([0x0f, 0x07, 0x1b, ...E("AB")])).toEqual(["AB"]);
  });
  it("RNL（0x06）・RFF（0x3A）は ACS も何もしない（Unsupported）", () => {
    const pages = new ScsDecoder(37).decode(Uint8Array.from([...E("A"), 0x06, ...E("B"), 0x3a, ...E("C")]));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lines).toEqual(["ABC"]);
  });
  it("SA（0x28）は 3 バイト、VCS（0x04）は 2 バイトで読み飛ばす", () => {
    expect(lines([0x28, 0x41, 0xc2, ...E("A"), 0x04, 0xc1, ...E("B")])).toEqual(["AB"]);
  });
  it("GE（0x08）は 2 バイト読んで何も置かない（JPS。~~グラフィック・エラー文字 `-`~~ は PDT 経路）", () => {
    expect(lines([...E("A"), 0x08, 0xc1, ...E("B")])).toEqual(["AB"]);
  });
  it("Null（0x00 / 0x14 / 0x23 / 0x24）は読み飛ばす", () => {
    expect(lines([0x00, 0x14, ...E("A"), 0x23, 0x24, ...E("B")])).toEqual(["AB"]);
  });

  it("**2B D1 06 01（SCG）は長さどおり 8 バイト**（~~6 バイトで読み、GCGID・CPGID を本文として読んでいた~~）", () => {
    expect(lines([0x2b, 0xd1, 0x06, 0x01, 0x01, 0x28, 0x03, 0x25, ...E("AB")])).toEqual(["AB"]);
  });
  it("**2B C1（SHF）は長さの前置どおり**（~~長さが 1 以上なら 1 バイトだけ~~）", () => {
    expect(lines([0x2b, 0xc1, 0x04, 0x84, 0x00, 0x05, ...E("AB")])).toEqual(["AB"]);
  });
  it("2B FE（代替文字）も長さどおり読み飛ばす（~~未知で打ち切り~~）", () => {
    expect(lines([0x2b, 0xfe, 0x04, 0x00, 0x00, 0x00, ...E("AB")])).toEqual(["AB"]);
  });
  it("2B C8（SGEA）も長さの前置どおり（JPS。~~5 バイト固定~~ は PDT 経路）", () => {
    // 長さ 5 の本体の後ろ 2 バイトを印字文字にしておく（5 バイト固定で読むと「AB」が本文に出る）
    expect(lines([0x2b, 0xc8, 0x05, 0x40, 0x03, 0xc1, 0xc2, ...E("XY")])).toEqual(["XY"]);
  });
  it("2B CA（EPMP）・2B D4（下線・重ね打ち）も長さの前置どおり（~~0x2B だけ捨てて本文が崩れる~~）", () => {
    expect(lines([...E("A"), 0x2b, 0xd4, 0x03, 0x0a, 0x01, ...E("BC")])).toEqual(["ABC"]);
    expect(lines([...E("A"), 0x2b, 0xca, 0x03, 0x01, 0x02, ...E("BC")])).toEqual(["ABC"]);
  });
  it("2B の長さが 0 でも続きを読める（ACS は 2 バイト進めて長さの 0x00 を Null として読む。結果は同じ）", () => {
    expect(lines([0x2b, 0xc1, 0x00, ...E("AB")])).toEqual(["AB"]);
  });
  it("**表に無い 2B のクラスは 0x2B だけを読み飛ばし、帳票の残りを捨てない**（ACS は未定義の制御として 1 バイト）", () => {
    const warn = vi.fn();
    const pages = new ScsDecoder(37, warn).decode(Uint8Array.from([...E("A"), 0x2b, 0x07, ...E("BC")]));
    expect(pages[0]!.lines).toEqual(["ABC"]);
    expect(warn).toHaveBeenCalled();
    // クラスのバイトが印字文字なら、それは文字として読み直される（2B だけを捨てたことが見える）
    expect(lines([...E("A"), 0x2b, 0xc3, ...E("B")])).toEqual(["ACB"]);
  });
});
