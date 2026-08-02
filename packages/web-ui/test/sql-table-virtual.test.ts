import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SqlResultTable from "../src/components/SqlResultTable.vue";
import {
  displayWidth,
  columnCharWidths,
  charWidthToPx,
  visibleWindow,
  CELL_PADDING_PX,
  MAX_COL_CHARS
} from "../src/composables/tableVirtual.js";

/**
 * **結果表の仮想化の計算**（`20260802-sql-table-virtualize`）。
 *
 * DOM を触らない純粋な部分だけをここで固める。実測（1 文字の px・行の高さ）は
 * 実ブラウザでしか取れないので引数にしてある——jsdom はレイアウトを計算しない。
 *
 * 速度そのものは `scripts/verify-sql-table-virtualize.mjs` で測る。
 */
describe("displayWidth", () => {
  it("ASCII は 1 文字 1 幅", () => {
    expect(displayWidth("ABC")).toBe(3);
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("a b-c_1")).toBe(7);
  });

  it("**全角は 2 幅**（1 幅で数えると日本語の列が半分になる）", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("あ")).toBe(2);
  });

  it("混在は足し合わせる", () => {
    expect(displayWidth("ab日本")).toBe(6);
  });

  it("**全角の重みは差し替えられる**（フォント次第で 2 倍ではない）", () => {
    // `IBM Plex Mono` は CJK の字形を持たず代替フォントが描く。実ブラウザでは 1.625 倍
    // （`verify-sql-table-virtualize.mjs` 節 7）。2 で数えると日本語の列だけ広くなる
    expect(displayWidth("日本語", 1.625)).toBeCloseTo(4.875);
    expect(displayWidth("ab日", 1.625)).toBeCloseTo(3.625);
    // ASCII だけなら重みに関係なく文字数
    expect(displayWidth("abc", 1.625)).toBe(3);
  });

  it("ASCII の近道が全角を取りこぼさない", () => {
    // 近道（`length` で返す）に落ちてよいのは印字可能 ASCII だけ
    expect(displayWidth("~")).toBe(1);
    expect(displayWidth("～")).toBe(2); // 全角チルダ
  });
});

describe("columnCharWidths", () => {
  const text = (row: string[], c: number): string => row[c] ?? "";

  it("見出しのほうが長ければ見出しで決まる", () => {
    expect(columnCharWidths(["LONGNAME", "B"], [["a", "b"]], text)).toEqual([8, 1]);
  });

  it("**後ろの行にある最長を拾う**（標本にしない）", () => {
    const rows = [["a"], ["bb"], ["cccccc"]];
    expect(columnCharWidths(["X"], rows, text)).toEqual([6]);
  });

  it("全角を 2 幅で数える", () => {
    expect(columnCharWidths(["X"], [["日本語"]], text)).toEqual([6]);
  });

  it("上限で切る（1 列で画面が埋まらないように）", () => {
    const long = "x".repeat(500);
    expect(columnCharWidths(["X"], [[long]], text)).toEqual([MAX_COL_CHARS]);
  });

  it("重みを渡すと列幅にも効く", () => {
    expect(columnCharWidths(["X"], [["日本"]], text, undefined, 1.625)).toEqual([3.25]);
  });

  it("上限は差し替えられる", () => {
    expect(columnCharWidths(["X"], [["xxxxxxxx"]], text, 3)).toEqual([3]);
  });

  it("行が無くても見出しぶんは返る", () => {
    expect(columnCharWidths(["ABC", "DE"], [], text)).toEqual([3, 2]);
  });

  it("**表示に使う文字で数える**（NULL や LOB の表記を含む）", () => {
    // 実体は null / LOB でも、画面に出るのは "NULL" / "(LOB)"
    const rows = [[null as unknown as string], [undefined as unknown as string]];
    const shown = (row: (string | null)[], c: number): string => (row[c] === null ? "NULL" : "(LOB)");
    expect(columnCharWidths(["X"], rows, shown)).toEqual([5]);
  });
});

describe("charWidthToPx", () => {
  it("文字数 × 文字幅 ＋ 余白", () => {
    expect(charWidthToPx(10, 7)).toBe(70 + CELL_PADDING_PX);
  });

  it("端数は切り上げる（1px 足りずに切れるのを防ぐ）", () => {
    expect(charWidthToPx(3, 7.2)).toBe(22 + CELL_PADDING_PX); // 21.6 → 22
  });
});

describe("visibleWindow", () => {
  const ROW = 24;
  const VIEW = 480; // 20 行ぶん

  it("先頭では 0 から始まる", () => {
    const w = visibleWindow(0, VIEW, ROW, 1000, 5);
    expect(w.start).toBe(0);
    expect(w.end).toBe(25); // 20 行 ＋ 余白 5
  });

  it("途中では前後に余白を取る", () => {
    const w = visibleWindow(ROW * 100, VIEW, ROW, 1000, 5);
    expect(w.start).toBe(95);
    expect(w.end).toBe(125);
  });

  it("末尾を超えない", () => {
    const w = visibleWindow(ROW * 990, VIEW, ROW, 1000, 5);
    expect(w.end).toBe(1000);
    expect(w.start).toBeLessThan(w.end);
  });

  it("全部入るなら全部描く", () => {
    const w = visibleWindow(0, VIEW, ROW, 10, 5);
    expect(w).toEqual({ start: 0, end: 10 });
  });

  it("行が無ければ空", () => {
    expect(visibleWindow(0, VIEW, ROW, 0)).toEqual({ start: 0, end: 0 });
  });

  it("**行の高さが測れなければ全部描く**（間引きに失敗して行を消さない）", () => {
    expect(visibleWindow(0, VIEW, 0, 500)).toEqual({ start: 0, end: 500 });
    expect(visibleWindow(0, 0, ROW, 500)).toEqual({ start: 0, end: 500 });
  });

  it("**見出しの高さを引く**（引き忘れると窓がその分ずれる）", () => {
    const withHeader = visibleWindow(ROW * 10 + 30, VIEW, ROW, 1000, 0, 30);
    expect(withHeader.start).toBe(10);
  });

  it("scrollTop が負でも壊れない", () => {
    expect(visibleWindow(-500, VIEW, ROW, 1000, 5).start).toBe(0);
  });

  it("scrollTop が過大でも start が end を追い越さない", () => {
    const w = visibleWindow(ROW * 100_000, VIEW, ROW, 1000, 5);
    expect(w.start).toBeLessThan(w.end);
    expect(w.end).toBe(1000);
  });
});

/**
 * **測れない環境では全行描く。**
 *
 * jsdom はレイアウトを計算しないので行の高さが 0 になる。そこで間引くと
 * **行が消える**——遅いほうがましなので、測れないときは全部描く方へ倒してある。
 * ここはその安全弁が効いていることの門番（窓の計算そのものは上で固定済み）。
 */
describe("SqlResultTable: レイアウトが測れないとき", () => {
  const columns = [
    { name: "ID", typeName: "INTEGER", nullable: false },
    { name: "S", typeName: "CHAR(10)", nullable: true }
  ];
  const rows = Array.from({ length: 100 }, (_, i) => ({ ID: i + 1, S: `v${i + 1}` }));

  it("行を落とさない（100 行すべて描く）", async () => {
    const w = mount(SqlResultTable, { props: { columns, rows, hasMore: false, loadingMore: false } });
    // **測るのは `onMounted` の中の `nextTick`**。1 ティックでは間に合わない
    await flushPromises();
    expect(w.findAll("tbody tr.data")).toHaveLength(100);
    w.unmount();
  });

  it("詰め物を出さない（間引いていないので高さを足す必要が無い）", async () => {
    const w = mount(SqlResultTable, { props: { columns, rows, hasMore: false, loadingMore: false } });
    // **測るのは `onMounted` の中の `nextTick`**。1 ティックでは間に合わない
    await flushPromises();
    expect(w.findAll("tbody tr.spacer")).toHaveLength(0);
    w.unmount();
  });

  it("**行番号は通し番号**（間引いてもずれない形にしてある）", async () => {
    const w = mount(SqlResultTable, { props: { columns, rows, hasMore: false, loadingMore: false } });
    // **測るのは `onMounted` の中の `nextTick`**。1 ティックでは間に合わない
    await flushPromises();
    const nums = w.findAll("tbody tr.data td.rownum").map((t) => t.text());
    expect(nums[0]).toBe("1");
    expect(nums[99]).toBe("100");
    w.unmount();
  });

  it("列幅は宣言される（`auto` に任せない）", async () => {
    const w = mount(SqlResultTable, { props: { columns, rows, hasMore: false, loadingMore: false } });
    // **測るのは `onMounted` の中の `nextTick`**。1 ティックでは間に合わない
    await flushPromises();
    const style = w.findAll("thead th")[1]?.attributes("style") ?? "";
    expect(style).toContain("width:");
    expect(style).toContain("max-width:");
    w.unmount();
  });
});
