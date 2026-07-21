import { describe, it, expect } from "vitest";
import { reactive, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **フォーカス中の入力欄の value に、埋め込み属性のセンチネル（U+E020–E03F）を絶対に入れない。**
 *
 * SEU の色付きソースのように SBCS 欄へ属性バイトが埋め込まれると、core はそれを私用面センチネルで
 * 値の中に返す。表示のときは常に空白へ落とす（`stripAttrSentinels`）ことになっているが、
 * PR #111 は writeSlices / :value / blur には入れたのに **onInputFocus・貼り付け再表示・IME prefix**
 * を取りこぼしていた。センチネルが生のまま <input> に入ると、`--screen-mono` の先頭
 * "HackGen Console NF" のような **Nerd Font（PUA にアイコングリフを持つ）** で可視化される:
 *   - 症状1: 文字色制御用の「セマンティック文字」がそのまま見える。
 *   - 症状2: そのグリフが 2 桁幅だと欄幅（width:Nch）を超えて横スクロールし、
 *            文字入力のたびにカーソルが行末へ飛んで見える。
 *
 * jsdom では実フォントのグリフ幅を測れないため、**不変条件そのもの**——フォーカス中の value に
 * センチネルが含まれないこと——をガードする（これが両症状の共通の根本原因）。
 */
const SENT = (b: number): string => String.fromCharCode(0xe000 + b);
const hasSentinel = (s: string): boolean => [...s].some((ch) => {
  const c = ch.charCodeAt(0);
  return c >= 0xe020 && c <= 0xe03f;
});

function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  };
}

/** row 5 col 9〜 に 緑"ABC" + 赤属性 + 赤"DEF"。値の属性位置はセンチネル。 */
function snapWithEmbeddedAttr(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  const row = cells[5]!;
  row[9] = cell("A"); row[10] = cell("B"); row[11] = cell("C");
  row[12] = cell(" ", { kind: "attr", color: "red" });
  row[13] = cell("D", { color: "red" }); row[14] = cell("E", { color: "red" }); row[15] = cell("F", { color: "red" });
  for (let c = 16; c <= 20; c++) row[c] = cell(" ", { color: "red" });
  return {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 6, col: 10 },
    keyboardLocked: false, cells, fields: []
  };
}

const FIELD: Field = {
  index: 1, row: 6, col: 10, length: 12, protected: false, hidden: false,
  numeric: false, mdt: false, value: "ABC" + SENT(0x28) + "DEF"
};

describe("フォーカス中の入力欄はセンチネルを表示しない", () => {
  it("色付き欄にフォーカスしても value にセンチネルが出ない（生のまま入れない）", async () => {
    const snap = snapWithEmbeddedAttr();
    snap.fields = [FIELD];
    const w = mount(ScreenGrid, {
      props: { snapshot: snap, edits: reactive(new Map()), focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    const value = (input.element as HTMLInputElement).value;
    expect(hasSentinel(value), `フォーカス中の value にセンチネルが混入: ${JSON.stringify(value)}`).toBe(false);
    expect(value.startsWith("ABC DEF")).toBe(true); // 属性桁は空白で桁は保たれる
    w.unmount();
  });

  it("色付き欄で文字入力してもフォーカス中 value にセンチネルが出ない", async () => {
    const snap = snapWithEmbeddedAttr();
    snap.fields = [FIELD];
    const w = mount(ScreenGrid, {
      props: { snapshot: snap, edits: reactive(new Map()), focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(1, 1);
    for (const key of ["1", "2", "3"]) {
      await input.trigger("keydown", { key });
      await nextTick();
      expect(hasSentinel(el.value), `入力中の value にセンチネル: ${JSON.stringify(el.value)}`).toBe(false);
    }
    // カーソルは打鍵ぶんだけ進む（行末へ飛ばない）
    expect(el.selectionStart).toBe(4);
    w.unmount();
  });
});
