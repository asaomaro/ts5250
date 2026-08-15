import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **日本語 DBCS が `s3270` と一致することの照合**（subtask 04 の受け入れ基準）。
 *
 * ```sh
 * sh packages/tn3270/test/harness/testenv.sh up
 * TN3270_E2E=1 npx vitest run test/e2e-dbcs.test.ts
 * ```
 *
 * **実ホストからは DBCS が出てこない**——ローカルに立てられる TK4-（MVS 3.8j, 1981 年）は
 * 英語 SBCS 専用で、日本語対応が入るのは z/OS の Japanese feature（ライセンス製品）から。
 * そこで **自前の `@ts5250/ebcdic` で符号化した日本語**を `mini3270` から流し、
 * `s3270 -codepage cp930 / cp939` の描画と突き合わせる。
 * ホスト OS が日本語である必要は無く、**日本語バイト列があればよい**。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

const LINES = [
  "3270 DBCS TEST",
  "kanji : 日本語表示",
  "kana  : カタカナ",
  "mixed : ABCあいうDEF",
  "long  : 東京都港区六本木一丁目"
];

/** 自前コーデックで各行を符号化した 3270 データストリーム */
function dbcsRecord(ccsid: number): Uint8Array {
  const codec = codecForCcsid(ccsid);
  const out: number[] = [CMD3270.ERASE_WRITE, WCC.RESTORE];
  LINES.forEach((text, i) => {
    out.push(...sba(i * 80), ORDER.SF, 0x20, ...codec.encode(text).bytes);
  });
  return Uint8Array.from(out);
}

function ourLines(record: Uint8Array, ccsid: number): string[] {
  const s = new Screen3270(2);
  applyInbound(s, record);
  return snapshot(s, { ccsid }).cells.map((row) =>
    row
      .map((c) => (c.kind === "dbcs-tail" ? "" : c.char))
      .join("")
      .replace(/\s+$/, "")
  );
}

describe.skipIf(!enabled)("DBCS が s3270 と一致する", () => {
  for (const [ccsid, codePage, port, httpPort] of [
    [930, "cp930", 3296, 6150],
    [939, "cp939", 3297, 6151]
  ] as [number, string, number, number][]) {
    it(`CCSID ${ccsid}（${codePage}）で表示が一致する`, async () => {
      expect(await s3270Available()).toBe(true);
      const record = dbcsRecord(ccsid);
      // 自前テーブルが取りこぼしていないこと（substituted=0）
      for (const text of LINES) {
        expect(codecForCcsid(ccsid).encode(text).substituted, `符号化できない文字: ${text}`).toBe(0);
      }

      const ours = ourLines(record, ccsid);
      const mini = await startMini3270({ records: [record], port });
      const ref = await S3270.start({
        host: "127.0.0.1",
        port: mini.port,
        codePage,
        httpPort,
        name: `tn3270-dbcs-${ccsid}`
      });
      try {
        expect(await ref.waitReady()).toBe(true);
        expect(await ref.waitForContent()).toBe(true);
        const refLines = (await ref.ascii()).map((l) => l.replace(/\s+$/, ""));

        // **日本語が実際に描かれていること**（空振りで緑にならないこと）
        expect(refLines.join("\n")).toMatch(/日本語表示/);
        expect(refLines.join("\n")).toMatch(/カタカナ/);

        expect(ours).toEqual(refLines);
      } finally {
        await ref.stop();
        await mini.close();
      }
    }, 90_000);
  }
});
