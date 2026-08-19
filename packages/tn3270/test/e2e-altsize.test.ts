import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { Tn3270Session } from "../src/session/session.js";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC } from "../src/protocol/constants.js";
import { alternateSizeFor, PRIMARY_SIZE, type Model3270 } from "../src/telnet/terminal-type.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **代替画面サイズ（Erase/Write Alternate）の検証。**
 *
 * ここは**どの実ホストにも一度も踏まれていなかった**——TK4- も IBM i も
 * `EraseWrite`(F5) しか送ってこず、`EraseWriteAlternate`(7E / SNA 0D) は fixture に 1 件も無い。
 * つまり EW/EWA の切り替えは **RFC の読解だけが根拠**で、実バイトで動かした実績が無かった。
 *
 * ISPF などは モデル 3/4/5 の代替サイズを多用するので、z/OS を相手にする前に
 * ここを踏んでおく。**s3270 を独立オラクルにする**のは他の照合と同じ。
 *
 * > **s3270 の性質に注意**: s3270 は EW/EWA のどちらを受けても
 * > **モデルの代替サイズで報告する**（実測。前 work の decisions D5）。
 * > よって「EWA で代替サイズになる」ことは s3270 と突き合わせられるが、
 * > 「EW で標準サイズに戻る」ことは**自実装の内部状態でしか確かめられない**。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];
const txt = (s: string): number[] => [...codecForCcsid(37).encode(s).bytes];

/** 代替サイズの右下あたりに印を置く画面（標準 24x80 には収まらない位置） */
function altScreen(model: Model3270): { record: Uint8Array; row: number; col: number; mark: string } {
  const alt = alternateSizeFor(model);
  const row = alt.rows;            // 最終行
  const col = alt.cols - 12;       // 右寄り
  const addr = (row - 1) * alt.cols + (col - 1);
  const mark = `ALT${model}`;
  return {
    record: Uint8Array.from([
      CMD3270.ERASE_WRITE_ALTERNATE, WCC.RESTORE,
      ...sba(0), ORDER.SF, 0x60, ...txt(`MODEL ${model}`),
      ...sba(addr), ORDER.SF, 0x60, ...txt(mark)
    ]),
    row, col, mark
  };
}

const lines = (s: Tn3270Session): string[] =>
  s.snapshot().cells.map((r) => r.map((c) => (c.kind === "dbcs-tail" ? "" : c.char)).join("").replace(/\s+$/, ""));

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("EW / EWA の切り替え（実ホストが一度も送ってこなかった経路）", () => {
  it("**EWA で代替サイズへ、EW で標準サイズへ戻る**（内部状態）", () => {
    // s3270 では確かめられない側（あちらは常にモデル最大で報告する）
    for (const model of [3, 4, 5] as Model3270[]) {
      const s = new Screen3270(model);
      const alt = alternateSizeFor(model);

      applyInbound(s, altScreen(model).record);
      expect([s.rows, s.cols], `model ${model} の EWA`).toEqual([alt.rows, alt.cols]);
      expect(s.alternate).toBe(true);

      applyInbound(s, Uint8Array.from([CMD3270.ERASE_WRITE, WCC.RESTORE]));
      expect([s.rows, s.cols], `model ${model} の EW`).toEqual([PRIMARY_SIZE.rows, PRIMARY_SIZE.cols]);
      expect(s.alternate).toBe(false);
    }
  });

  it("**代替サイズでしか届かないアドレスに書ける**", () => {
    // model 5（27x132＝3,564 桁）の最終行は 24x80（1,920 桁）には存在しない
    const s = new Screen3270(5);
    const { record, row, mark } = altScreen(5);
    applyInbound(s, record);
    const snap = snapshot(s);
    expect([snap.rows, snap.cols]).toEqual([27, 132]);
    expect(snap.cells[row - 1]!.map((c) => c.char).join("")).toContain(mark);
  });

  it("SNA 系のコード（0x0D）でも代替サイズになる", () => {
    const s = new Screen3270(5);
    applyInbound(s, Uint8Array.from([0x0d, WCC.RESTORE, ...sba(0), ORDER.SF, 0x60, ...txt("X")]));
    expect([s.rows, s.cols]).toEqual([27, 132]);
  });

  it("モデル 2 は代替も 24x80（RFC 1576）", () => {
    const s = new Screen3270(2);
    applyInbound(s, Uint8Array.from([CMD3270.ERASE_WRITE_ALTERNATE, WCC.RESTORE]));
    expect([s.rows, s.cols]).toEqual([24, 80]);
    expect(s.alternate).toBe(true);
  });
});

describe.skipIf(!enabled)("代替サイズを s3270 と突き合わせる", () => {
  for (const [model, port, httpPort] of [[3, 3340, 6350], [4, 3341, 6351], [5, 3342, 6352]] as const) {
    it(`モデル ${model}（${alternateSizeFor(model).rows}x${alternateSizeFor(model).cols}）で一致する`, async () => {
      expect(await s3270Available()).toBe(true);
      const { record, mark } = altScreen(model);
      const alt = alternateSizeFor(model);

      // --- 自実装 ---
      const mini1 = await startMini3270({ records: [record], port });
      const s = new Tn3270Session({ host: "127.0.0.1", port: mini1.port, model });
      let n = 0;
      s.on("screen", () => n++);
      let ours: string[] = [];
      try {
        await s.connect();
        expect(await waitFor(() => n, 1), "画面が来ない").toBe(true);
        ours = lines(s);
        expect(s.snapshot().rows).toBe(alt.rows);
        expect(s.snapshot().cols).toBe(alt.cols);
      } finally {
        s.close();
        await mini1.close();
      }

      // --- s3270 ---
      const mini2 = await startMini3270({ records: [record], port: port + 10 });
      const ref = await S3270.start({
        host: "127.0.0.1", port: mini2.port, model, httpPort, name: `alt-${model}`
      });
      try {
        expect(await ref.waitReady()).toBe(true);
        expect(await ref.waitForContent()).toBe(true);
        const refLines = (await ref.ascii()).map((l) => l.replace(/\s+$/, ""));
        expect(refLines.length, "s3270 の行数").toBe(alt.rows);
        // 空振り防止——印が実際に描かれていること
        expect(refLines.join("\n")).toContain(mark);
        expect(ours).toEqual(refLines);
      } finally {
        await ref.stop();
        await mini2.close();
      }
    }, 120_000);
  }
});
