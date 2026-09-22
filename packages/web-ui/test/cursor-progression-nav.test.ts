import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **カーソル送り（DDS の `FLDCSRPRG`。FCW `0x88nn`）。**
 *
 * ホストが「この欄を出たら画面順の次ではなく nn 番の欄へ」と指定してくる。読み飛ばしていたので
 * **Tab の行き先が実機と違っていた**（実機 `TESTLIB/KEYPGM`: `IN1` は `FLDCSRPRG(IN3)` なのに
 * `IN2` へ行っていた）。参照実装 2 つとも Tab と満杯・Field Exit の自動送りで見る
 * （GNU tn5250 `tn5250_display_set_cursor_next_field`、tn5250j `ScreenFields.gotoFieldNext`）。
 *
 * ~~**Shift+Tab には効かせない**——tn5250j は逆引きもするが GNU tn5250 はしない。
 * どちらが実機と同じか確かめる手段が無いので、実装しない側へ倒した。~~
 * → ACS は欄の先頭での Backtab で逆にも辿る（`FFT5250.previousNonByPassInputFieldPos`。
 * `20260921-backtab-acs`。逆引きのテストは `backtab-acs.test.ts`）。
 */
const SID = "s1";

function cell(): Cell {
  return { char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false };
}
function snap(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields };
}
function field(index: number, row: number, over: Partial<Field> = {}): Field {
  return { index, row, col: 10, length: 5, protected: false, hidden: false, numeric: false,
    mdt: false, value: "", ...over };
}
function seed(fields: Field[]): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(fields), edits: new Map(),
    cursor: { row: 1, col: 1 }, link: { state: "connected" },
 resumability: "resumable", readOnly: false,
    client: { send: () => {} } as unknown as WsClient
  });
}
const mountPane = () => mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
const inputs = (w: ReturnType<typeof mount>) =>
  Array.from(w.element.querySelectorAll('input.grid-input:not([readonly])[data-slice="0"]')) as HTMLInputElement[];

describe("Tab はホストが指定したカーソル送り先へ行く", () => {
  // 実機と同じ形: IN1（行3・`FLDCSRPRG(IN3)`）/ IN2（行5）/ IN3（行7）
  beforeEach(() => seed([field(1, 3, { cursorProgression: 3 }), field(2, 5), field(3, 7)]));

  it("**指定された欄へ飛ぶ**（画面順の次ではない）", async () => {
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement, "画面順の次（IN2）へ行っている").toBe(els[2]);
    w.unmount();
  });

  it("指定の無い欄は従来どおり画面順の次へ", async () => {
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[1]!.focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[2]);
    w.unmount();
  });

  it("Shift+Tab: 送り先の指定を持つ欄の先頭からは、そこへ送る欄が無ければ画面順の前へ（IN1 は誰からも送られない）", async () => {
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(els[2]); // 先頭からは末尾へラップ（従来どおり）
    w.unmount();
  });

  it("送り先が無い番号なら画面順どおりに倒す（原典も見つからなければ次の欄へ落ちる）", async () => {
    seed([field(1, 3, { cursorProgression: 9 }), field(2, 5), field(3, 7)]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[1]);
    w.unmount();
  });

  it("送り先が保護欄なら画面順どおりに倒す", async () => {
    seed([field(1, 3, { cursorProgression: 3 }), field(2, 5), field(3, 7, { protected: true })]);
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(els[1]);
    w.unmount();
  });

  it("**欄が満杯になった自動送りでも指定先へ行く**（打ち切りの Field Exit と同じ経路）", async () => {
    const w = mountPane();
    await nextTick();
    const els = inputs(w);
    els[0]!.focus();
    els[0]!.setSelectionRange(0, 0);
    await nextTick();
    for (const ch of "ABCDE") {
      els[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      await nextTick();
    }
    expect(document.activeElement, "満杯の自動送りが指定を見ていない").toBe(els[2]);
    w.unmount();
  });
});

/**
 * **番号は継続欄の 2 区間目以降を数えない並びで引く**（ACS `FFT5250.getStandardFieldList`。`20260921-hllapi-tab-acs` の節目の独立点検の指摘。
 * 以前は `index`＝全区間を数える番号で引いていて、前に継続欄があると行き先がずれた）。
 * 欄: A（3 行・送り先 3）/ B は継続欄（5 行 first・6 行 last）/ C（7 行）/ D（9 行）。ACS の並び [A, B, C, D] の 3 番は C
 */
describe("カーソル送りの番号（前に継続欄があるとき）", () => {
  beforeEach(() =>
    seed([field(1, 3, { cursorProgression: 3 }), field(2, 5, { continued: "first" }), field(3, 6, { continued: "last" }), field(4, 7), field(5, 9)])
  );
  const byIndex = (w: ReturnType<typeof mount>, index: number) => inputs(w).find((el) => Number(el.dataset["fieldIndex"]) === index);

  it("Tab: A から送り先 3＝C（B の最終区間ではない）", async () => {
    const w = mountPane();
    await nextTick();
    byIndex(w, 1)!.focus();
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    expect(Number((document.activeElement as HTMLInputElement).dataset["fieldIndex"])).toBe(4);
    w.unmount();
  });

  it("Shift+Tab: C の先頭から、C（並びの 3 番）へ送る A へ戻る", async () => {
    const w = mountPane();
    await nextTick();
    const c = byIndex(w, 4)!;
    c.focus();
    c.setSelectionRange(0, 0);
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Tab", shiftKey: true });
    expect(Number((document.activeElement as HTMLInputElement).dataset["fieldIndex"])).toBe(1);
    w.unmount();
  });
});
