import { describe, it, expect } from "vitest";
import { renderSpoolHtml } from "../src/spool-html.js";
import { ScsDecoder, type LogicalPage } from "../src/scs.js";
import { codecForCcsid } from "@ts5250/ebcdic";

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

  /**
   * **押せる部品を置かないのは「紙の中」の話。** 帳票そのものは読み取り専用の記録なので、
   * 入力欄も編集の導線も出さない。ページのクローム（テーマ・フォント・SO/SI・表示コードの
   * 切り替え）は紙ではなく**見え方**を変えるもので、この規則の対象ではない
   * ——それらは CSS だけで動かすために隠した `<input>` を使う（`TOGGLE_CSS` の注記）。
   */
  it("紙の中に押せる部品を置かない（読み取り専用の記録）", () => {
    const html = renderSpoolHtml([page(["X"])]);
    const sheet = html.slice(html.indexOf("<figure"), html.indexOf("</figure>"));
    expect(sheet).not.toMatch(/<input\b/);
    expect(sheet).not.toMatch(/<textarea\b/);
    expect(sheet).not.toMatch(/<button\b/);
    // クロームの入力は**隠した状態用**だけ（値を打たせる欄は 1 つも無い）
    expect(html.match(/<input\b[^>]*>/g) ?? []).toSatisfy((all: string[]) =>
      all.every((t) => /type="(checkbox|radio)"/.test(t) && t.includes('class="tg"'))
    );
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

/**
 * **見え方の切り替えは CSS だけで作る。** チェックボックス／ラジオと `:checked ~` で動くので、
 * JS を切っても・CSP で script を止められても切り替えが生きる。JS に残るのはページ送りだけ。
 */
describe("renderSpoolHtml — 見え方の切り替え", () => {
  const dbcsPage = (): LogicalPage => {
    const codec = codecForCcsid(1399);
    return new ScsDecoder(1399).decode(codec.encode("AB日本語 exit").bytes)[0]!;
  };

  it("テーマは JS ではなく CSS のトグルで切り替える", () => {
    const html = renderSpoolHtml([page(["X"])]);
    expect(html).toContain('<input class="tg" type="checkbox" id="t">');
    expect(html).toContain("#t:checked ~ .page{");
    // 旧実装の JS が残っていない（script はページ送りだけ）
    expect(html).not.toContain("data-theme");
    const js = html.slice(html.lastIndexOf("<script>"));
    expect(js).toContain("figure.pg");
    expect(js).not.toContain("getElementById('t')");
  });

  it("フォントは候補を順送りできる（自己完結なので Web フォントは積まない）", () => {
    const html = renderSpoolHtml([page(["X"])]);
    expect(html).toContain('<input class="tg" type="radio" name="g" id="g0" checked>');
    expect(html).toContain("フォント: 標準");
    expect(html).toContain("フォント: 白源 HackGen");
    expect(html).toContain("--sheet-mono:");
    expect(html).not.toMatch(/@font-face|https?:/); // 外から取ってこない
  });

  it("指定のフォントで開く", () => {
    const html = renderSpoolHtml([page(["X"])], {}, { font: "udev" });
    expect(html).toMatch(/id="g4" checked/);
  });

  /**
   * SO/SI は桁を占めないので、印を出すと**その行は右へずれる**。既定を非表示にしてあるのは
   * そのため——紙と突き合わせるときは消しておく。
   */
  it("SO/SI の印を入れ、出すかは CSS で決める", () => {
    const html = renderSpoolHtml([dbcsPage()]);
    expect(html).toContain('<span class="so">{</span>');
    expect(html).toContain('<span class="so">}</span>');
    expect(html).toContain(".so{display:none"); // 既定は非表示
    expect(html).toContain("#s:checked ~ .page .so{display:inline-block}");
    expect(html).toContain('<input class="tg" type="checkbox" id="s">');
  });

  it("SO/SI 表示で開くよう指定できる", () => {
    const html = renderSpoolHtml([dbcsPage()], {}, { shiftMarks: true });
    expect(html).toMatch(/id="s" checked/);
  });

  it("SO/SI の無い帳票には切り替えを出さない", () => {
    const html = renderSpoolHtml([page(["ABC"])]);
    expect(html).not.toContain('id="s"');
  });

  /** 表示コード切替。読みで字が変わる区間だけ 2 つ出す（変わらない区間は素のまま） */
  it("両方の読みを入れ、CSS で差し替える", () => {
    const html = renderSpoolHtml([dbcsPage()], {}, { sbcs: { host: "latin" } });
    expect(html).toContain('<span class="va">exit</span>');
    expect(html).toContain('<span class="vb">ｵﾒｹﾎ</span>');
    expect(html).toContain(".sheet .vb{display:none}");
    expect(html).toContain("#k:checked ~ .page .sheet .va{display:none}");
    // 向きはホストの読みで決まる（英系ホストなので 英 ⇄ カナ）
    expect(html).toContain("表示コード: 英");
    expect(html).toContain("表示コード: カナ");
  });

  it("読み替わる桁が無ければ表示コードの切り替えを出さない", () => {
    // 大文字と数字は 2 表で同じ位置
    const codec = codecForCcsid(1399);
    const p = new ScsDecoder(1399).decode(codec.encode("ABC123").bytes)[0]!;
    const html = renderSpoolHtml([p], {}, { sbcs: { host: "latin" } });
    expect(html).not.toContain('id="k"');
    expect(html).not.toContain('class="va"');
  });

  it("渡さなければ表示コードの切り替えは出ない（従来どおり 1 通り）", () => {
    const html = renderSpoolHtml([dbcsPage()]);
    expect(html).not.toContain('id="k"');
    expect(html).not.toContain('class="va"');
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
