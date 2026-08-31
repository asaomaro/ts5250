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

  /**
   * **帳票 HTML は JS を 1 行も持たない**（利用者の指示）。
   *
   * テーマ・フォント・SO/SI・表示コードに加え、**ページ送りまで CSS だけ**にした。
   * ページ 1 枚につきラジオ 1 つを置き、押した番号のページだけ出す。ラジオなので、
   * 束にフォーカスすれば矢印キーで送れる（前は JS でやっていた挙動がそのまま残る）。
   * 規則は枚数に比例して増えるが、**読み手の環境（JS 無効・CSP）に依存しない**ほうを採る。
   */
  it("script を 1 つも出さない（切り替えもページ送りも CSS だけ）", () => {
    const html = renderSpoolHtml([page(["X"]), page(["Y"])]);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("data-theme"); // 旧実装の JS の痕跡
    // テーマ
    expect(html).toContain('<input class="tg" type="checkbox" id="t">');
    expect(html).toContain("#t:checked ~ .page{");
    // ページ送り
    expect(html).toContain('<input class="tg" type="radio" name="pg" id="pg0" checked>');
    expect(html).toContain('<label class="btn jump" for="pg1">2</label>');
    expect(html).toContain('#pg1:checked ~ .page figure.pg[data-page="2"]{display:block}');
  });

  it("フォントは候補を順送りできる（自己完結なので Web フォントは積まない）", () => {
    const html = renderSpoolHtml([page(["X"])]);
    expect(html).toContain('<input class="tg" type="radio" name="g" id="g0" checked>');
    expect(html).toContain("フォント: 標準");
    expect(html).toContain("フォント: 白源 HackGen");
    expect(html).toContain("--sheet-mono:");
    expect(html).not.toMatch(/@font-face|https?:/); // 外から取ってこない
  });

  /**
   * **押しても後ろのボタンが動かない。** 状態で字数が変わる部分だけを固定幅の箱に入れ、
   * 幅を固定できないフォント名は**一番右**へ置く（利用者の指摘）。
   */
  it("状態で変わる部分は固定幅、フォントは一番右", () => {
    const html = renderSpoolHtml([dbcsPage()], {}, { sbcs: { host: "latin" } });
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    // 変化する語はどれも固定幅の箱に入っている
    expect(html).toContain(".tv{display:inline-block");
    expect(html).toContain(".tv.theme{width:");
    expect(html).toContain(".tv.sosi{width:");
    expect(html).toContain(".tv.kana{width:");
    // 並びは テーマ → SO/SI → 表示コード → フォント（フォントが最後）
    const at = (needle: string): number => header.indexOf(needle);
    expect(at('for="t"')).toBeLessThan(at('for="s1"'));
    expect(at('for="s1"')).toBeLessThan(at('for="k"'));
    expect(at('for="k"')).toBeLessThan(at('class="btn fw"'));
    // フォントより後ろにボタンは無い＝幅が変わっても何も動かない
    expect(header.slice(header.lastIndexOf('class="btn fw"'))).not.toContain('class="btn" for=');
  });

  it("指定のフォントで開く", () => {
    const html = renderSpoolHtml([page(["X"])], {}, { font: "udev" });
    expect(html).toMatch(/id="g4" checked/);
  });

  /**
   * **SO/SI の印は桁を占めない。** 文字の流れに挟むと印を出した行だけ右へずれる。
   * 実採取の帳票（PUB400 の Library List）では DBCS の行も他の行と同じ 39 桁目から
   * 始まっており、**ホストは SO/SI が桁を占めない前提で桁を組んでいる**——
   * 桁を与えるとその行だけ食い違う。だから桁の境目に重ねて描く。
   */
  it("SO/SI の印を桁の境目に重ねて置く（幅を持たせない）", () => {
    const html = renderSpoolHtml([dbcsPage()]);
    expect(html).toContain('<span class="so" style="left:2ch">{</span>');
    expect(html).toContain('<span class="so" style="left:8ch">}</span>');
    expect(html).toContain(".so{display:none;position:absolute"); // 既定は非表示・重ねて置く
    expect(html).toContain('<input class="tg" type="radio" name="s" id="s0" checked>');
  });

  /**
   * **SO/SI は画面 HTML と同じ 3 値**（非表示 / 薄目 / 濃目。利用者の指示）。
   * 濃目も薄目もふつうの文字より薄い——本物の `{ }` と区別が付かなくなると意味が消える。
   */
  it("SO/SI は 3 値の順送りで、濃さが変わる", () => {
    const html = renderSpoolHtml([dbcsPage()]);
    // 変化するのは末尾の語だけ。**固定幅の箱に入れて**ボタンの幅を変えない（`.tv` の注記）
    expect(html).toContain('<label class="btn sw" for="s1">SO/SI <span class="tv sosi">非表示</span></label>');
    expect(html).toContain('<label class="btn sw" for="s2">SO/SI <span class="tv sosi">薄目</span></label>');
    expect(html).toContain('<label class="btn sw" for="s0">SO/SI <span class="tv sosi">濃目</span></label>');
    expect(html).toContain("color:color-mix(in srgb,var(--ink) 30%,var(--paper))"); // 薄目
    expect(html).toContain("color:color-mix(in srgb,var(--ink) 65%,var(--paper))"); // 濃目
  });

  /**
   * **印の有無で桁が 1 つも動かない。** 印は常に HTML に入っていて CSS で見せ隠しするだけなので、
   * 行のマークアップは初期状態に関わらず**完全に同じ**になる（違うのはチェック状態だけ）。
   */
  it("SO/SI の有無で行のマークアップが変わらない", () => {
    const lineOf = (html: string): string => html.match(/<div class="ln">.*?<\/div>/)![0];
    const off = renderSpoolHtml([dbcsPage()], {}, { shiftMarks: "none" });
    const on = renderSpoolHtml([dbcsPage()], {}, { shiftMarks: "strong" });
    expect(lineOf(on)).toBe(lineOf(off));
    // 違うのは開いたときの状態だけ
    expect(on.replace('id="s2" checked', 'id="s2"').replace('id="s0"', 'id="s0" checked')).toBe(off);
  });

  it("SO/SI の初期状態を指定できる", () => {
    expect(renderSpoolHtml([dbcsPage()], {}, { shiftMarks: "dim" })).toContain('id="s1" checked');
    expect(renderSpoolHtml([dbcsPage()], {}, { shiftMarks: "strong" })).toContain('id="s2" checked');
  });

  it("SO/SI の無い帳票には切り替えを出さない", () => {
    const html = renderSpoolHtml([page(["ABC"])]);
    expect(html).not.toContain('name="s"');
  });

  /** 表示コード切替。読みで字が変わる区間だけ 2 つ出す（変わらない区間は素のまま） */
  it("両方の読みを入れ、CSS で差し替える", () => {
    const html = renderSpoolHtml([dbcsPage()], {}, { sbcs: { host: "latin" } });
    expect(html).toContain('<span class="va">exit</span>');
    expect(html).toContain('<span class="vb">ｵﾒｹﾎ</span>');
    expect(html).toContain(".sheet .vb{display:none}");
    expect(html).toContain("#k:checked ~ .page .sheet .va{display:none}");
    // 向きはホストの読みで決まる（英系ホストなので 英 ⇄ カナ）
    expect(html).toContain('表示コード: <span class="st-off tv kana">英</span>');
    expect(html).toContain('<span class="st-on tv kana">カナ</span>');
  });

  /**
   * **復号できなかったバイトを本文に混ぜない。**
   *
   * 帳票の復号コードページにマップの無いバイトを、コーデックは U+FFFD で返す
   * （CCSID 1399 では 256 中 29 バイト）。素通しすると `◆` が本文に混ざり、
   * DSPFMT の帳票で実際に出た（利用者の報告）。しかも U+FFFD は多くのフォントで
   * **全角幅**なので、1 桁のはずが 2 桁を占めて行がずれる。
   */
  it("復号できなかった字（U+FFFD）は空白にする", () => {
    const p: LogicalPage = {
      rows: 1,
      cols: 8,
      lines: ["\uFFFDDSPFMT"],
      raw: [[0x41, 0xc4, 0xe2, 0xd7, 0xc6, 0xd4, 0xe3]],
      shifts: [[]]
    };
    // 切り替えの有無にかかわらず混ざらない
    expect(renderSpoolHtml([p])).not.toContain("\uFFFD");
    const withToggle = renderSpoolHtml([p], {}, { sbcs: { host: "latin" } });
    expect(withToggle).not.toContain("\uFFFD");
    expect(withToggle).toContain('<span class="va"> </span>'); // そのまま側は空白
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
  /**
   * **印刷でも JS に頼らない。** 以前は `beforeprint` で全ページを出していたが、
   * JS を落としたので `@media print` の `display:block!important` が受け持つ
   * ——`!important` は後ろの規則（`figure.pg{display:none}`）にも勝つ。
   */
  it("印刷ではページ区切りを保ち、全ページを出す（JS 無し）", () => {
    const html = renderSpoolHtml([page(["P1"]), page(["P2"])]);
    expect(html).toContain("break-after:page");
    expect(html).toContain("figure.pg{display:block!important;break-after:page");
    expect(html).not.toContain("beforeprint");
  });

  it("空のスプールでも壊れない", () => {
    const html = renderSpoolHtml([]);
    expect(html).toContain("<dt>ページ数</dt><dd>0</dd>");
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });
});
