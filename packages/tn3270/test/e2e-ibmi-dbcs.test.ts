import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { fromHex } from "../src/trace/trace.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **実 IBM i（日本語機）が 3270 で送ってきた DBCS 画面**の照合。
 *
 * これまで 3270 の DBCS は**合成データでしか裏付けが無かった**——
 * ローカルに立てられる唯一の 3270 ホスト（TK4- = MVS 3.8j, 1981 年）が英語 SBCS 専用のため。
 * そこで**日本語 IBM i に DDS のサブファイル画面を出させ、3270 で受け取ったバイトをそのまま
 * 記録した**（`fixtures/ibmi-dbcs-subfile.jsonl`。社内機・CCSID 5035・V7R3）。
 *
 * **実ホストが何を使ってきたか**（この記録から数えた事実）:
 *
 * | 使ったもの | 数 |
 * |---|---|
 * | `SO`／`SI` の対 | **29** |
 * | `SFE` | 100 |
 * | **文字セット属性（`XA.CHARSET`）** | 1（値は `0x00`＝基本文字集合） |
 * | **入力制御（`XA.INPUT_CONTROL`）** | **1（値 `0x01`）** |
 *
 * つまり**出力の DBCS は `SO`/`SI` の小区間**で来る。そして**入力欄には入力制御が立っている**
 * ——s3270 の挙動から実装した「混在入力の欄」が、**実ホストでも同じ形で使われていた**。
 */

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): Uint8Array =>
  fromHex((JSON.parse(readFileSync(join(here, "fixtures", name), "utf8").trim()) as { hex: string }).hex);
const RECORD = load("ibmi-dbcs-subfile.jsonl");
/** 同じ機の **MAIN メニュー**（システム通番は伏せ字にしてある） */
const MENU = load("ibmi-menu-jp.jsonl");
const CCSID = 5035; // 社内機のジョブ CCSID。x3270 では cp939（1027＋300）が同じ組み合わせ

function ourLines(record: Uint8Array = RECORD, ccsid = CCSID): string[] {
  const s = new Screen3270(2);
  applyInbound(s, record, { dbcs: true });
  return snapshot(s, { ccsid }).cells.map((row) =>
    row
      .map((c) => (c.kind === "dbcs-tail" ? "" : c.char))
      .join("")
      .replace(/\s+$/, "")
  );
}

describe("実 IBM i の日本語画面（記録の再生）", () => {
  it("**日本語が読める**——docker もホストも要らない", () => {
    const text = ourLines().join("\n");
    expect(text).toContain("社員マスター一覧");
    expect(text).toContain("田中太郎");
    expect(text).toContain("営業部");
    expect(text).toContain("続く");
  });

  it("**入力欄に入力制御が立っている**——混在入力の欄として扱う", () => {
    const s = new Screen3270(2);
    applyInbound(s, RECORD, { dbcs: true });
    const marked = s.attrPositions().filter((p) => s.inputControlAt(p));
    expect(marked.length, "入力制御の立った欄が無い").toBeGreaterThan(0);
    // 立っているのは非保護欄（検索条件の「部門」）
    for (const p of marked) expect(s.isProtectedAt(s.wrap(p + 1))).toBe(false);
  });

  it("**DBCS 欄ではなく SO/SI で来ている**（文字セット属性は基本のまま）", () => {
    const s = new Screen3270(2);
    applyInbound(s, RECORD, { dbcs: true });
    expect(s.attrPositions().some((p) => s.charsetAt(p) === 0xf8), "DBCS 欄がある").toBe(false);
    // SO/SI がバッファに 1 桁ずつ入っている
    const cells = snapshot(s, { ccsid: CCSID }).cells.flat();
    expect(cells.filter((c) => c.kind === "so").length).toBeGreaterThan(10);
    expect(cells.filter((c) => c.kind === "si").length).toBeGreaterThan(10);
  });
});

describe.skipIf(process.env["TN3270_E2E"] !== "1")("実 IBM i の日本語画面（s3270 と照合）", () => {
  it("**画面全体が s3270 と一致する**", async () => {
    expect(await s3270Available()).toBe(true);
    const mini = await startMini3270({ records: [RECORD], port: 3416 });
    const ref = await S3270.start({
      host: "127.0.0.1", port: 3416, httpPort: 6416, name: "ibmi-dbcs", codePage: "cp939"
    });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);
      const refLines = (await ref.ascii()).map((l) => l.replace(/\s+$/, ""));
      expect(refLines.join("\n"), "s3270 が日本語を描いていない").toContain("社員マスター");
      expect(ourLines()).toEqual(refLines);
    } finally {
      await ref.stop();
      await mini.close();
    }
  }, 120_000);
});

/**
 * **同じ機でも画面によって「正しい CCSID」が違う。**
 *
 * アプリの DDS 画面（上の EMPSFR）は DBCS で来るのでどちらでも読めるが、
 * **IBM i のシステムメニューは半角カタカナ（1 バイト）を使う**。
 * 半角カタカナは CCSID 930 の SBCS 側にしかないので、
 * **930 なら読め、939/5035 では別の文字に化ける**。
 *
 * **これは実装の誤りではない**——s3270 に同じバイトを流すと**同じように化ける**。
 * ホストのジョブ CCSID と端末の申告が食い違うと、こうなるという事実。
 */
describe("日本語 IBM i のメニュー画面と CCSID の選択", () => {
  const line22 = (ccsid: number): string => ourLines(MENU, ccsid)[21] ?? "";

  it("**930（カタカナ）なら半角カタカナが読める**", () => {
    expect(line22(930)).toContain("ﾌﾟﾛﾝﾌﾟﾄ");
    expect(line22(930)).toContain("ｺﾏﾝﾄﾞ");
  });

  it("**939 / 5035（英小文字）では化ける**——同じバイトが別の文字を指すため", () => {
    expect(line22(939)).not.toContain("ﾌﾟﾛﾝﾌﾟﾄ");
    expect(line22(5035)).not.toContain("ﾌﾟﾛﾝﾌﾟﾄ");
    // 漢字（DBCS）はどちらでも読める
    expect(line22(939)).toContain("取り消し");
    expect(line22(5035)).toContain("取り消し");
  });
});

describe.skipIf(process.env["TN3270_E2E"] !== "1")("メニュー画面も s3270 と一致する", () => {
  for (const [cp, ccsid, port, http] of [
    ["cp930", 930, 3417, 6417],
    ["cp939", 939, 3418, 6418]
  ] as [string, number, number, number][]) {
    it(`**${cp} で画面全体が一致する**（化ける側も含めて同じ）`, async () => {
      expect(await s3270Available()).toBe(true);
      const mini = await startMini3270({ records: [MENU], port });
      const ref = await S3270.start({
        host: "127.0.0.1", port, httpPort: http, name: `menu-${cp}`, codePage: cp
      });
      try {
        expect(await ref.waitReady()).toBe(true);
        expect(await ref.waitForContent()).toBe(true);
        const refLines = (await ref.ascii()).map((l) => l.replace(/\s+$/, ""));
        expect(refLines.join("\n"), "s3270 が日本語を描いていない").toContain("メインメニュー");
        expect(ourLines(MENU, ccsid)).toEqual(refLines);
      } finally {
        await ref.stop();
        await mini.close();
      }
    }, 120_000);
  }
});
