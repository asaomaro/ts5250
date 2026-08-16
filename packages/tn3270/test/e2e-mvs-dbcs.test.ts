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
 * **実 MVS 3.8j（TK4-）が吐いた DBCS を読む。**
 *
 * 3270 の DBCS は長らく合成データと IBM i でしか裏付けが無かった——
 * ローカルに立つ唯一のメインフレーム TK4- は**英語 SBCS 専用**だからである。
 * 別プロジェクト `mvs-dbcs` が、その TK4- 上で **`TPUT FULLSCR` に生バイトを渡す
 * アセンブラ**を組んで「MVS は DBCS バイトを素通しする」ことを実測した。
 *
 * ここで再生しているのは、**そのとき線上に出た本物のレコード**
 * （`mvs-dbcs` の `results/20260816-221914/vtam.records.hex`）。
 *
 * ```
 * f1 c2 1140401d60 6e6e6e 0e 4562 4566 48e7 0f 4c4c4c 13
 * │  │  │          │      └ SO 日 本 語 SI     │      └ IC
 * │  │  │          └ ">>>" マーカー            └ "<<<"
 * │  │  └ SBA(0) ＋ SF（保護）
 * │  └ WCC
 * └ **Write コマンド。TSO が前に付ける**（プログラムはコマンドを書かない）
 * ```
 *
 * **`F1`（Write）で始まる点が IBM i とも合成データとも違う**——こちらは
 * `Erase/Write` ではなく既存画面への上書きで、しかも先頭にコマンドが付いた形。
 * 実ホストの経路を通ったバイトでしか出てこない形が、これで回帰に入る。
 */

const here = dirname(fileURLToPath(import.meta.url));
const PAYLOADS = readFileSync(join(here, "fixtures", "mvs-dbcs-tput.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { name: string; hex: string });

const rec = (name: string): Uint8Array => fromHex(PAYLOADS.find((p) => p.name === name)!.hex);

function lineOf(record: Uint8Array, ccsid: number): string {
  const s = new Screen3270(2);
  applyInbound(s, record, { dbcs: true });
  return snapshot(s, { ccsid })
    .cells[0]!.map((c) => (c.kind === "dbcs-tail" ? "" : c.char))
    .join("")
    .replace(/\s+$/, "");
}

describe("実 MVS の DBCS 出力を読む（記録の再生）", () => {
  it("**「日本語」が読める**（P03）", () => {
    expect(lineOf(rec("P03"), 939)).toBe(" >>> 日本語 <<<");
    // ホストのコードは IBM-930。SBCS 側が違う CCSID でも DBCS の表は同じ
    expect(lineOf(rec("P03"), 930)).toContain("日本語");
    expect(lineOf(rec("P03"), 5035)).toContain("日本語");
  });

  it("**桁割りが SO / 2 桁 ×3 / SI になる**", () => {
    const s = new Screen3270(2);
    applyInbound(s, rec("P03"), { dbcs: true });
    const row = snapshot(s, { ccsid: 939 }).cells[0]!;
    expect(row.slice(0, 12).map((c) => c.kind)).toEqual([
      "attr", "sbcs", "sbcs", "sbcs",
      "so", "dbcs-lead", "dbcs-tail", "dbcs-lead", "dbcs-tail", "dbcs-lead", "dbcs-tail",
      "si"
    ]);
  });

  it("**DBCS 全角空白も 2 桁を占める**（P02。SBCS の空白 2 個と同じバイト列）", () => {
    const s = new Screen3270(2);
    applyInbound(s, rec("P02"), { dbcs: true });
    const row = snapshot(s, { ccsid: 939 }).cells[0]!;
    expect(row.slice(4, 8).map((c) => c.kind)).toEqual(["so", "dbcs-lead", "dbcs-tail", "si"]);
    expect(row[5]!.char).toBe("　"); // 全角空白
  });

  it("**中身の無い SO/SI でも壊れない**（P01）", () => {
    const s = new Screen3270(2);
    applyInbound(s, rec("P01"), { dbcs: true });
    const row = snapshot(s, { ccsid: 939 }).cells[0]!;
    expect(row.slice(4, 6).map((c) => c.kind)).toEqual(["so", "si"]);
    expect(lineOf(rec("P01"), 939)).toBe(" >>>  <<<");
  });

  it("**先頭の Write コマンドを解釈する**（TSO が付ける `F1`）", () => {
    // Erase/Write ではないので画面は消えない——前の内容が残る
    const s = new Screen3270(2);
    applyInbound(s, fromHex("f5c2"), { dbcs: true }); // まず消して
    // **レコードの先頭はコマンド**。`11` から始めると SNA 系の WSF と読まれる（実際に踏んだ）
    applyInbound(s, fromHex("f1c2" + "11c150" + "c1c2c3"), { dbcs: true }); // 2 行目の先頭へ "ABC"
    applyInbound(s, rec("P03"), { dbcs: true }); // Write（消さない）
    const rows = snapshot(s, { ccsid: 939 }).cells.map((r) => r.map((c) => c.char).join(""));
    expect(rows[0]).toContain(">>>");
    expect(rows[1], "Erase/Write ではないので 2 行目は残る").toContain("ABC");
  });
});

describe.skipIf(process.env["TN3270_E2E"] !== "1")("実 MVS の DBCS を s3270 と突き合わせる", () => {
  for (const [name, port, http] of [
    ["P02", 3420, 6420],
    ["P03", 3421, 6421]
  ] as [string, number, number][]) {
    it(`**${name} の画面全体が s3270 と一致する**`, async () => {
      expect(await s3270Available()).toBe(true);
      const record = rec(name);
      const mini = await startMini3270({ records: [record], port });
      const ref = await S3270.start({
        host: "127.0.0.1", port, httpPort: http, name: `mvs-${name}`, codePage: "cp930"
      });
      try {
        expect(await ref.waitReady()).toBe(true);
        expect(await ref.waitForContent()).toBe(true);
        const refLines = (await ref.ascii()).map((l) => l.replace(/\s+$/, ""));
        expect(refLines[0], "s3270 にマーカーが出ていない").toContain(">>>");
        const ours = (() => {
          const s = new Screen3270(2);
          applyInbound(s, record, { dbcs: true });
          return snapshot(s, { ccsid: 930 }).cells.map((r) =>
            r
              .map((c) => (c.kind === "dbcs-tail" ? "" : c.char))
              .join("")
              .replace(/\s+$/, "")
          );
        })();
        expect(ours).toEqual(refLines);
      } finally {
        await ref.stop();
        await mini.close();
      }
    }, 120_000);
  }
});
