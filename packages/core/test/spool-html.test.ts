import { describe, it, expect } from "vitest";
import { renderSpoolHtml } from "../src/html/spool-html.js";
import type { LogicalPage } from "@as400web/scs";

/**
 * スプール（帳票）→ 自己完結 HTML。`renderSpoolPdf` の HTML 版。
 *
 * 固めるのは screen-html と同じ「エビデンスとして成立する条件」——**決定的**であること、
 * **注入されない**こと、**外部を参照しない**こと、そして **桁がずれない**こと。
 * 帳票は桁が命なので、全角の扱いをいちばん厚く見る。
 */
function page(lines: string[], cols = 80): LogicalPage {
  return { rows: lines.length, cols, lines };
}

describe("renderSpoolHtml — エビデンスとして成立する条件", () => {
  it("同じ入力から 2 回生成した HTML が完全一致する（決定的）", () => {
    const pages = [page(["LINE 1", "LINE 2"])];
    const meta = { capturedAt: "2026-07-31T10:00:00Z", spoolId: "sp1" };
    expect(renderSpoolHtml(pages, meta)).toBe(renderSpoolHtml(pages, meta));
  });

  it("外部リソースを参照しない（CSS/JS/フォント/画像）", () => {
    const html = renderSpoolHtml([page(["X"])]);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(https?:/);
  });

  /** 帳票の文字はすべてホスト由来。属性値にも本文にも同じエスケープを通す */
  it("ホスト由来の文字列を HTML として解釈させない", () => {
    const html = renderSpoolHtml([page(['<script>alert(1)</script> & "q"'])], {
      title: "<b>t</b>",
      note: '<img src=x onerror="1">'
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("読み取り専用の記録なので入力欄を出さない", () => {
    const html = renderSpoolHtml([page(["X"])]);
    expect(html).not.toMatch(/<input\b/);
    expect(html).not.toMatch(/<textarea\b/);
  });
});

describe("renderSpoolHtml — 桁がずれない", () => {
  /**
   * **`lines` の全角は 1 文字で 2 桁を占める**（ScsDecoder の putWide が継続桁に空文字列を
   * 置き、join で落ちるため）。素のテキストで流すと、開いた環境のフォント次第で桁がずれる。
   */
  it("全角は width:2ch の箱に入れる", () => {
    const html = renderSpoolHtml([page(["あA"])]);
    expect(html).toContain('<span class="w">あ</span>');
    expect(html).toContain(".w{display:inline-block;width:2ch");
  });

  /**
   * East Asian Width の Ambiguous も DBCS では 2 桁。半角と見なすと以降が左へずれる
   * （core の `isFullWidth` と同じ判定を使う＝表を二重に持たない）。
   */
  it("Ambiguous（罫線・ギリシャ等）も全角として箱に入れる", () => {
    const html = renderSpoolHtml([page(["─Ω"])]);
    expect(html).toContain('<span class="w">─</span>');
    expect(html).toContain('<span class="w">Ω</span>');
  });

  /** 半角カナは narrow のまま（箱に入れると逆にずれる） */
  it("半角カナは箱に入れない", () => {
    const html = renderSpoolHtml([page(["ｱｲｳ"])]);
    expect(html).not.toContain('<span class="w">ｱ</span>');
    expect(html).toContain("ｱｲｳ");
  });

  it("半角の連なりは 1 つにまとめる（1 文字 1 要素にしない）", () => {
    const html = renderSpoolHtml([page(["ABCDEFG"])]);
    expect(html).toContain('<div class="ln">ABCDEFG</div>');
  });

  it("桁数は cols で固定する", () => {
    const html = renderSpoolHtml([page(["X"], 132)]);
    expect(html).toContain('style="width:132ch"');
  });
});

describe("renderSpoolHtml — ページ", () => {
  it("ページごとに figure を出し、ページ数を見出しに載せる", () => {
    const html = renderSpoolHtml([page(["P1"]), page(["P2"]), page(["P3"])]);
    expect((html.match(/<figure class="pg"/g) ?? []).length).toBe(3);
    expect(html).toContain("<dt>ページ数</dt><dd>3</dd>");
  });

  /** 印刷したときに PDF と同じ体裁で紙に落ちること（1 ページだけ印刷される事故を防ぐ） */
  it("印刷ではページ区切りを保ち、全ページを出す", () => {
    const html = renderSpoolHtml([page(["P1"]), page(["P2"])]);
    expect(html).toContain("break-after:page");
    expect(html).toContain("beforeprint");
  });

  it("空のスプールでも壊れない", () => {
    const html = renderSpoolHtml([]);
    expect(html).toContain("<dt>ページ数</dt><dd>0</dd>");
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });
});
