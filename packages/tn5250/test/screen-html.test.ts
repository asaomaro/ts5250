import { describe, it, expect } from "vitest";
import { renderScreenHtml, renderScreenHistoryHtml } from "../src/screen-html.js";
import type { Cell, ScreenSnapshot, Field } from "../src/screen/types.js";

/**
 * `ScreenSnapshot` → 自己完結 HTML の変換。
 *
 * ここで固めるのは「エビデンスとして成立する条件」——**決定的であること**（差分が取れる）、
 * **注入されないこと**（画面文字はすべてホスト由来）、**外部を参照しないこと**（開く場所に
 * 依らず同じに見える）、そして**桁がずれないこと**（ずれた瞬間に証拠として使えない）。
 */
function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  } as Cell;
}

function snapWith(mut?: (cells: Cell[][]) => void, fields: Field[] = []): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  mut?.(cells);
  return {
    sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields
  } as ScreenSnapshot;
}

/** 1 行目に文字列を置く（SBCS） */
function putText(cells: Cell[][], text: string, extra: Partial<Cell> = {}): void {
  [...text].forEach((ch, i) => (cells[0]![i] = cell(ch, extra)));
}

describe("renderScreenHtml — エビデンスとして成立する条件", () => {
  it("同じ入力から 2 回生成した HTML が完全一致する（決定的）", () => {
    const snap = snapWith((c) => putText(c, "HELLO"));
    const meta = { capturedAt: "2026-07-28T10:00:00Z", sessionId: "s1" };
    expect(renderScreenHtml(snap, meta)).toBe(renderScreenHtml(snap, meta));
  });

  /**
   * **画面文字はすべてホスト由来**。`<script>` や `"` がそのまま来る。
   * 属性値とテキストの両方に同じエスケープを通していないと、片方から漏れる。
   */
  it("ホスト由来の文字列で HTML が壊れず、注入も起きない", () => {
    const evil = '<script>alert("x")</script>';
    const snap = snapWith((c) => putText(c, evil));
    const html = renderScreenHtml(snap, { note: evil, sessionId: evil, title: evil });
    // 画面・メタ・title のどこにも生の <script> が出ない（末尾の実装スクリプトを除く）
    const body = html.slice(0, html.lastIndexOf("<script>"));
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;");
    // 属性値に生の " が漏れない（title 属性・data 属性が割れない）
    expect(body).not.toContain('alert("x")');
  });

  it("外部リソースを一切参照しない（自己完結）", () => {
    const snap = snapWith((c) => putText(c, "X"));
    const html = renderScreenHtml(snap, { capturedAt: "2026-07-28T10:00:00Z" });
    expect(html).not.toMatch(/https?:/);
    expect(html).not.toMatch(/\ssrc=/);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(/);
    expect(html).not.toMatch(/<link/);
  });

  it("JS を切っても画面が読める（描画は静的 HTML/CSS だけ）", () => {
    const snap = snapWith((c) => putText(c, "READABLE"));
    const html = renderScreenHtml(snap);
    const body = html.slice(0, html.lastIndexOf("<script>"));
    expect(body).toContain("READABLE"); // script より前に画面がある
  });

  it("押せる部品を置かない（読み取り専用のエビデンス）", () => {
    const fields: Field[] = [
      { index: 1, row: 5, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "typed" }
    ];
    const html = renderScreenHtml(snapWith(undefined, fields));
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  /** `fields[].value` を出さない＝非表示欄の中身を HTML に載せる経路を作らない */
  it("フィールドの値を HTML に書かない（秘密の露出経路を作らない）", () => {
    const fields: Field[] = [
      { index: 1, row: 5, col: 10, length: 8, protected: false, hidden: true, numeric: false, mdt: false, value: "s3cret" }
    ];
    expect(renderScreenHtml(snapWith(undefined, fields))).not.toContain("s3cret");
  });
});

describe("renderScreenHtml — 桁がずれない（忠実さの核）", () => {
  /**
   * **全角は必ず 2ch の箱に入れる。** 配布 HTML は Web フォントを持てないので、
   * 開いた環境のフォントが全角を 1 桁で描く可能性を残せない。
   */
  it("正常な全角は 2ch の箱（w）に入り、tail 桁は出さない", () => {
    const snap = snapWith((c) => {
      c[0]![0] = cell("日", { kind: "dbcs-lead" });
      c[0]![1] = cell("", { kind: "dbcs-tail" });
      c[0]![2] = cell("A");
    });
    const html = renderScreenHtml(snap);
    expect(html).toContain('<span class="w c-green">日</span>');
    // tail は独立した span にならない（lead が 2 桁ぶんを占める）
    expect(html).not.toContain('class="h c-green"');
  });

  it("対を失った全角は 1ch の箱（h）になる（ACS と同じ分断表示）", () => {
    const orphanLead = snapWith((c) => {
      c[0]![0] = cell("日", { kind: "dbcs-lead" }); // 次が tail ではない
      c[0]![1] = cell("A");
    });
    expect(renderScreenHtml(orphanLead)).toContain('<span class="h c-green">日</span>');

    const orphanTail = snapWith((c) => {
      c[0]![0] = cell("", { kind: "dbcs-tail" }); // 前に lead が無い
    });
    expect(renderScreenHtml(orphanTail)).toContain('class="h c-green"');
  });

  it("桁と行の単位が ch / 1.25em で一貫している", () => {
    const snap = snapWith();
    snap.cursor = { row: 3, col: 5 };
    const html = renderScreenHtml(snap);
    expect(html).toContain('class="cur" style="left:4ch;top:2.5em"'); // (3-1)*1.25=2.5
  });
});

describe("renderScreenHtml — 表示属性", () => {
  it("7 色と反転・下線・点滅のクラスが出る", () => {
    const snap = snapWith((c) => {
      c[0]![0] = cell("A", { color: "red", reverse: true });
      c[0]![1] = cell("B", { color: "blue", underline: true });
      c[0]![2] = cell("C", { color: "pink", blink: true });
    });
    const html = renderScreenHtml(snap);
    expect(html).toContain('class="c-red a-r"');
    expect(html).toContain('class="c-blue a-u"');
    expect(html).toContain('class="c-pink a-b"');
  });

  /**
   * 属性バイト表に黄・青緑の「修飾なし」が無いため、CS ビットは意図の印にならない。
   * **判定は class 属性で行う**——CSS 定義（`.a-cs{…}`）は常に出るので、
   * 文書全体の部分一致で見ると必ず当たってしまい、テストが意味を失う。
   */
  it("桁区切りは出るが、黄・青緑では出さない", () => {
    const green = snapWith((c) => (c[0]![0] = cell("A", { columnSeparator: true })));
    expect(renderScreenHtml(green)).toContain('class="c-green a-cs"');
    for (const color of ["yellow", "turquoise"] as const) {
      const snap = snapWith((c) => (c[0]![0] = cell("A", { columnSeparator: true, color })));
      expect(renderScreenHtml(snap)).toContain(`class="c-${color}"`);
      expect(renderScreenHtml(snap)).not.toContain(`class="c-${color} a-cs"`);
    }
  });

  /**
   * **反転で `currentColor` を使ってはいけない。**
   * `background:currentColor; color:var(--crt)` を同じルールに書くと、`currentColor` が
   * その新しい `color` に解決され、背景と文字が同色になって反転部分が消える。
   * 色 class 側で `--cell` に控え、反転はそれを背景に使う（web-ui の `--cell` と同じ理由）。
   * **見えなくなっても HTML の文字列としては正しいので、目視しないと気付けない**——
   * だから CSS の形を固定する。
   */
  it("反転は --cell を背景に使う（currentColor だと文字が消える）", () => {
    const html = renderScreenHtml(snapWith());
    const rule = /\.a-r\{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).toContain("background:var(--cell)");
    expect(rule).toContain("color:var(--crt)");
    expect(html).not.toContain("background:currentColor");
    // 7 色すべてが --cell を持たないと、その色の反転だけ背景が消える
    for (const c of ["green", "white", "red", "turquoise", "yellow", "pink", "blue"]) {
      expect(html).toContain(`--cell:var(--t-${c})`);
    }
  });

  /**
   * **縦に並んだ反転の間に地色の隙間を作らない／隣の行へはみ出さない。**
   *
   * 素のインライン要素は内容領域（フォントの ascent+descent）にしか背景を塗らないので、
   * 反転が縦に続くと行間に地色が横線として並ぶ。**box-shadow 等で固定量を足す手は使わない**
   * ——足りるかどうかはフォント次第で、内容領域の広いフォントでは隣の行へはみ出す
   * （実測: Noto Sans Mono CJK JP で行送り 18.75px に対し塗り 25px）。
   * 文字ランの箱そのものを行送りに合わせる（`.ln span`）ことで、
   * 足りない／はみ出すが原理的に起きない。実画素の確認は
   * `scripts/verify-browser-reverse-rows.mjs`。
   */
  it("文字ランは行送りぶんの箱（反転が行間まで塗られ、隣の行へは出ない）", () => {
    const html = renderScreenHtml(snapWith());
    const lineHeight = Number(/\.grid\{[^}]*line-height:([\d.]+)/.exec(html)?.[1]);
    expect(lineHeight).toBe(1.25);
    const run = /\.ln span\{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(run).toContain("display:inline-block");
    expect(run).toContain(`height:${lineHeight}em`); // 行送りと同じ高さ
    expect(run).toContain("vertical-align:top"); // 箱の上端を行の上端へ
    // **固定量で足すのは禁止**（フォント次第で足りない／はみ出す）
    const rule = /\.a-r\{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).not.toContain("box-shadow");
    expect(rule).not.toContain("padding");
  });

  it("非表示（nonDisplay）の桁は伏せる", () => {
    const snap = snapWith((c) => putText(c, "SECRET", { nonDisplay: true }));
    expect(renderScreenHtml(snap)).not.toContain("SECRET");
  });

  it("属性が同じ連なりは 1 つの span にまとめる（3564 セルを 1 セル 1 要素にしない）", () => {
    const snap = snapWith((c) => putText(c, "AAAA"));
    const html = renderScreenHtml(snap);
    expect(html).toContain(">AAAA");
  });
});

describe("renderScreenHtml — 罫線の幾何", () => {
  const withGrid = (g: Partial<Parameters<typeof gridLine>[0]> = {}): ScreenSnapshot => {
    const snap = snapWith();
    snap.gui = { selectionFields: [], windows: [], scrollBars: [], gridLines: [gridLine(g)] };
    return snap;
  };
  function gridLine(o: Record<string, unknown>) {
    return {
      id: 1, minorType: 0x04, row: 5, col: 10, width: 20, height: 6,
      lineStyle: 0x00, color: 0x07, value1: 0, value2: 0, ...o
    } as never;
  }

  /**
   * **罫線はセルの境界に引く。** 下辺は最終行の下端＝row+height、右辺は最終桁の右端＝col+width。
   * 行番号・桁番号のまま置くと辺が 1 つ内側に寄り、箱が閉じない。
   */
  it("箱が閉じる（下辺・右辺が最終セルの外側）", () => {
    const html = renderScreenHtml(withGrid({ minorType: 0x04, row: 5, col: 10, width: 20, height: 6 }));
    expect(html).toContain("top:5em"); // 上辺 (5-1)*1.25
    expect(html).toContain("top:12.5em"); // 下辺 (4+6)*1.25
    expect(html).toContain("left:9ch"); // 左辺
    expect(html).toContain("left:29ch"); // 右辺 9+20
  });

  it("単独罫線は value1=繰り返し数・value2=間隔で複数本引く", () => {
    const html = renderScreenHtml(
      withGrid({ minorType: 0x02, row: 4, col: 3, width: 0, height: 10, value1: 3, value2: 2 })
    );
    // 左辺の縦線が 2 桁おきに 3 本（left:2ch / 4ch / 6ch）
    expect(html).toContain("left:2ch");
    expect(html).toContain("left:4ch");
    expect(html).toContain("left:6ch");
  });

  /** 罫線の色は 5250 の属性バイトではなく GRDATR 専用コード */
  it("GRDATR の色コードで色が付く（属性バイトとして解釈しない）", () => {
    expect(renderScreenHtml(withGrid({ color: 0x04 }))).toContain("c-red");
    expect(renderScreenHtml(withGrid({ color: 0x01 }))).toContain("c-blue");
  });

  /**
   * **線種は原典（`GRID_LINE_STYLE`）どおりに読む。**
   * 独自の対応表を書くと、同じ画面が web-ui と HTML で違う線に見える。実測で
   * 0x03（点線）を破線・0x08（破線）を実線として描いていた（実機 GRIDCL2/GRIDCL3）。
   */
  it.each([
    [0x00, ""],
    [0x01, "gl-thick"],
    [0x02, "gl-double"],
    [0x03, "gl-dotted"],
    [0x08, "gl-dashed"],
    [0x09, "gl-dashed gl-thick"],
    [0x0a, "gl-double"],
    [0xff, ""]
  ])("線種 0x%s は web-ui と同じクラスになる", (lineStyle, cls) => {
    const html = renderScreenHtml(withGrid({ lineStyle }));
    if (cls === "") {
      // 実線は追加クラスを付けない（gl-h / gl-v の既定が実線）
      expect(html).not.toMatch(/class="gl [^"]*gl-(thick|double|dotted|dashed)/);
    } else {
      // 向き（gl-h / gl-v）は後ろに付く
      expect(html).toContain(`class="gl c-white ${cls} gl-h"`);
    }
  });

  it("線種のクラスに対応する CSS を必ず同梱する（クラスだけ付けて見た目が出ない、を防ぐ）", () => {
    const html = renderScreenHtml(withGrid());
    for (const cls of ["gl-dotted", "gl-dashed", "gl-double", "gl-thick"]) {
      expect(html).toContain(`.gl-h.${cls}`);
      expect(html).toContain(`.gl-v.${cls}`);
    }
  });
});

describe("renderScreenHtml — web-ui と絵を食い違わせない", () => {
  /**
   * **表示できないバイト（U+FFFD）は空白にする。** EBCDIC の表にマップの無いバイトを
   * そのまま描くと、実機に無い「�」がエビデンスに写り込む。web-ui（`displayText`）は
   * ACS に合わせて空白にしており、そちらに揃える。実機の FEATPGM（DBCS 分断）で発覚。
   */
  it("U+FFFD は空白にする（web-ui / ACS と同じ）", () => {
    const snap = snapWith((c) => putText(c, "AB�C"));
    const html = renderScreenHtml(snap);
    expect(html).not.toContain("�");
    expect(html).toContain("AB C");
  });

  it("DBCS 対の中身が U+FFFD でも「�」を出さない", () => {
    const snap = snapWith((c) => {
      c[0]![0] = cell("�", { kind: "dbcs-lead" });
      c[0]![1] = cell("", { kind: "dbcs-tail" });
    });
    expect(renderScreenHtml(snap)).not.toContain("�");
  });

  /**
   * **窓の枠はホストが送る位置の 1 桁右**。中身は宣言位置の 1 行下・3 桁右から始まり、
   * 枠の矩形は 行 row〜row+height+1 / 桁 col+1〜col+width+4。宣言位置のまま置くと
   * 左へ 1 桁ずれる（web-ui の `windowStyle` は既に +1 で描いている）。
   */
  it("窓の枠は col+1 から描く（web-ui の windowStyle と同じ矩形）", () => {
    const snap = snapWith();
    snap.gui = {
      selectionFields: [], scrollBars: [], gridLines: [],
      windows: [{ id: 1, row: 6, col: 17, width: 30, height: 8 }] as never
    };
    const html = renderScreenHtml(snap);
    expect(html).toContain('class="gwin" style="left:17ch;top:6.25em;width:34ch');
  });
});

describe("renderScreenHistoryHtml — 描画経路を二重に持たない", () => {
  const snapA = snapWith((c) => putText(c, "FIRST"));
  const snapB = snapWith((c) => putText(c, "SECOND"));

  /**
   * **履歴版に載る 1 画面 1 画面は、単票が出すのと同じ出力**。
   * ここが分かれると「1 枚で見たときと履歴で見たときで絵が違う」ことになり、
   * エビデンスとして成立しなくなる。
   */
  it("履歴版の各コマが単票と同じ画面マークアップを含む", () => {
    const single = renderScreenHtml(snapA);
    // 単票から画面本体（figure）だけ取り出す
    const body = single.slice(single.indexOf('<div class="crt">'), single.indexOf("</figure>"));
    expect(body.length).toBeGreaterThan(100);
    const hist = renderScreenHistoryHtml([{ screen: snapA }, { screen: snapB }]);
    expect(hist).toContain(body);
  });

  it("コマ数ぶんの figure と送信キーが出る", () => {
    const hist = renderScreenHistoryHtml([
      { screen: snapA },
      { screen: snapB, key: "Enter", capturedAt: "2026-07-28T10:00:01Z" }
    ]);
    expect(hist.match(/<figure class="scr"/g)).toHaveLength(2);
    expect(hist).toContain("Enter");
  });

  it("空の履歴でも壊れない", () => {
    const html = renderScreenHistoryHtml([]);
    expect(html).toContain("記録された画面がありません");
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it("決定的（同じ履歴から同じ HTML）", () => {
    const e = [{ screen: snapA }, { screen: snapB, key: "F3" }];
    expect(renderScreenHistoryHtml(e)).toBe(renderScreenHistoryHtml(e));
  });

  it("外部リソースを参照しない", () => {
    const html = renderScreenHistoryHtml([{ screen: snapA }]);
    expect(html).not.toMatch(/https?:/);
    expect(html).not.toMatch(/\ssrc=/);
  });
});
