import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import PrinterPane from "../src/components/PrinterPane.vue";
import { sessionsStore, type SessionState, type SpoolReportView } from "../src/stores/sessions.js";

/**
 * 「印刷」は別ウィンドウへ帳票を書き出してブラウザの印刷に渡す。
 *
 * **中身は core の `renderSpoolHtml` に描かせる**——以前はここで `<pre>` を組み立てており、
 * (1) `--screen-mono` のフォントスタックをインラインで再掲していた（別ウィンドウに CSS 変数は
 * 届かないため）、(2) 改ページが本物にならず `selectedText` の「── (改ページ) ──」という
 * 区切り文字がそのまま紙に出た、(3) 全角の桁が開いた先のフォント任せだった。
 * 同じ帳票の絵を 2 か所で持たないことを、ここで固定する。
 */
const SID = "p1";

function addPrinterSession(reports: SpoolReportView[]): string {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "PRT1",
    kind: "printer",
    snapshot: undefined,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: true,
    reports,
    selectedReportId: reports[0]?.id,
    client: {} as SessionState["client"]
  } as SessionState);
  return SID;
}

/** window.open を捕まえて、書き込まれた HTML を取り出す */
function captureOpen(): { written: () => string; printed: () => boolean } {
  let buf = "";
  let didPrint = false;
  vi.spyOn(window, "open").mockImplementation(
    () =>
      ({
        document: { write: (s: string) => (buf += s), close: () => {} },
        focus: () => {},
        print: () => (didPrint = true)
      }) as unknown as Window
  );
  return { written: () => buf, printed: () => didPrint };
}

const TWO_PAGES: SpoolReportView[] = [
  {
    id: "r1",
    pages: [
      { rows: 1, cols: 20, lines: ["一枚目 ABC"] },
      { rows: 1, cols: 20, lines: ["二枚目 DEF"] }
    ]
  }
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function clickPrint(): Promise<ReturnType<typeof mount>> {
  const id = addPrinterSession(TWO_PAGES);
  const w = mount(PrinterPane, { props: { sessionId: id } });
  const btn = w.findAll("button").find((b) => b.text() === "印刷")!;
  expect(btn, "印刷ボタンがある").toBeTruthy();
  expect(btn.attributes("disabled")).toBeUndefined();
  await btn.trigger("click");
  return w;
}

describe("PrinterPane: 印刷", () => {
  it("renderSpoolHtml の完結した文書を書き出す（<pre> の手組みではない）", async () => {
    const cap = captureOpen();
    const w = await clickPrint();
    const html = cap.written();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<title>");
    // **アプリ側の変数を持ち込まない。** 別ウィンドウに `--screen-mono` は届かないので、
    // ここで組み立てると二重管理になる。フォントは配布 HTML が自前の候補を持つ
    // （読み手がページ内で選べる。`spool-html.ts` の `SPOOL_FONTS`）。
    expect(html).not.toContain("--screen-mono");
    expect(html).toContain("--sheet-mono");
    w.unmount();
  });

  it("ページごとに分け、印刷でページ区切りを保つ", async () => {
    const cap = captureOpen();
    const w = await clickPrint();
    const html = cap.written();
    expect((html.match(/<figure class="pg"/g) ?? []).length).toBe(2);
    expect(html).toContain("break-after:page");
    // 区切り文字（selectedText の見せ方）を紙に出さない
    expect(html).not.toContain("(改ページ)");
    w.unmount();
  });

  it("全角は 2 桁の箱に入れる（開いた先のフォントに桁を委ねない）", async () => {
    const cap = captureOpen();
    const w = await clickPrint();
    expect(cap.written()).toContain('<span class="w">一</span>');
    w.unmount();
  });

  /**
   * `document.write` 直後に印刷を走らせると、レイアウト前に印刷が始まる環境がある。
   * 次のタスクへ回していることを固定する。
   */
  it("印刷は次のタスクで呼ぶ", async () => {
    vi.useFakeTimers();
    const cap = captureOpen();
    const w = await clickPrint();
    expect(cap.printed()).toBe(false);
    vi.runAllTimers();
    expect(cap.printed()).toBe(true);
    w.unmount();
  });

  it("ポップアップが塞がれても落ちない", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const w = await clickPrint();
    expect(w.exists()).toBe(true);
    w.unmount();
  });
});
