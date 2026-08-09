import { describe, it, expect, vi } from "vitest";
import type { SpoolReport } from "@ts5250/tn5250";
import { handleReport, pagesAsText } from "../src/printer-output.js";
import { PAGE_BREAK } from "../src/print-windows.js";

/**
 * Windows の自動印刷。
 *
 * `lp` は CUPS のコマンドで Windows には無く、そのまま呼んで
 * `spawn lp ENOENT` で必ず失敗していた（利用者の報告）。
 * Windows ではプリントキューへ**テキストを描いて**出す（`print-windows.ts`）。
 */
const report = (pages: string[][]): SpoolReport =>
  ({
    id: "SPL1",
    pages: pages.map((lines) => ({ rows: lines.length, cols: 80, lines })),
    raw: new Uint8Array([1, 2, 3])
  }) as unknown as SpoolReport;

describe("論理ページ → テキスト", () => {
  it("改ページで区切る（ホストが決めた改ページをそのまま出す）", () => {
    const t = pagesAsText(report([["1 行目", "2 行目"], ["次のページ"]]));
    expect(t).toBe(`1 行目\n2 行目${PAGE_BREAK}次のページ`);
  });

  it("空のページも 1 ページとして残す（詰めない）", () => {
    expect(pagesAsText(report([["A"], [], ["B"]]))).toBe(`A${PAGE_BREAK}${PAGE_BREAK}B`);
  });
});

describe("ホスト変換済み（rawPrint）", () => {
  /**
   * ドライバーを通さずスプーラーへ raw で流す必要があり（`lp -o raw` 相当）、
   * winspool の P/Invoke が要る。**実機で確かめられていないので実装していない。**
   * 黙って化けた紙を出すより理由を返す。
   */
  it("Windows では理由つきで断る（lp を呼びに行かない）", async () => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const warns: string[] = [];
      const r = await handleReport(
        report([["x"]]),
        { autoPrint: "どこかのプリンター", rawPrint: true },
        (w) => warns.push(w)
      );
      expect(r.printed).toBe(false);
      expect(r.printError).toContain("Windows では未対応");
      expect(warns.join()).toContain("Windows では未対応");
    } finally {
      spy.mockRestore();
    }
  });

  it("Windows 以外は従来どおり lp へ（lp が無ければその理由が返る）", async () => {
    const r = await handleReport(report([["x"]]), { autoPrint: "p", rawPrint: true }, () => {});
    // この環境に lp は無いので失敗するが、**Windows 用の文言にはならない**
    expect(r.printError ?? "").not.toContain("Windows では未対応");
  });
});
