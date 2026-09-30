import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { SO_MARK, SI_MARK } from "../src/composables/fieldValidate.js";

/**
 * **継続した O 欄の Erase EOF は空き（NUL）を残す**（`20260930-cont-o-nul`）: 消した桁と続く区間の桁は空き（NUL）で、空白（0x40）にすると中身として送られてしまう
 * （ACS の `eraseToEOF_Work` は NUL で埋める）。鎖は (5,10)・(6,10)・(7,10) の 8 桁ずつ。先頭 `SO い え SI X`・中間 `YZ`
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
function snap(): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const r5 = cells[4]!;
  r5[9] = cell(" ", "so");
  r5[10] = cell("い", "dbcs-lead");
  r5[11] = cell("", "dbcs-tail");
  r5[12] = cell("え", "dbcs-lead");
  r5[13] = cell("", "dbcs-tail");
  r5[14] = cell(" ", "si");
  r5[15] = cell("X");
  cells[5]![9] = cell("Y");
  cells[5]![10] = cell("Z");
  const seg = (index: number, row: number, continued: string, value: string): Field =>
    ({ index, row, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value, dbcsType: "open", continued }) as unknown as Field;
  return {
    sessionId: "w1", rows: 24, cols: COLS, cursor: { row: 5, col: 10 }, keyboardLocked: false, cells,
    fields: [seg(1, 5, "first", "いえX"), seg(2, 6, "middle", "YZ"), seg(3, 7, "last", "")]
  } as unknown as ScreenSnapshot;
}

let send: Mock<(m: unknown) => void>;
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
beforeEach(() => {
  send = vi.fn<(m: unknown) => void>();
  keybindingsStore.reset();
  keybindingsStore.set("alt+Delete", "local:erase-eof");
});
async function pane(s: ScreenSnapshot) {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: "w1", label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send } as unknown as WsClient
  });
  const w = mount(EmulatorPane, { props: { sessionId: "w1", focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const el = w.find("input.grid-input:not([readonly])[data-slice='0']").element as HTMLInputElement;
  el.focus();
  await nextTick();
  return { w, el };
}
const key = async (el: HTMLInputElement, k: string, altKey = false) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey, bubbles: true, cancelable: true }));
  await nextTick();
};
const sent = () =>
  send.mock.calls.map((c) => c[0] as { type: string; fields?: { field: number; value: string }[] }).filter((m) => m.type === "key").at(-1)?.fields;

describe("継続した O 欄の Erase EOF", () => {
  it("並びの中から消すと SI で閉じて残りは空き。続く区間も全桁が空き（空白なら中身として送られてしまう）", async () => {
    const { el } = await pane(snap());
    await key(el, "Home");
    await key(el, "ArrowRight"); // え の桁
    await key(el, "Delete", true); // Erase EOF
    await key(el, "Enter");
    const f = sent()!;
    expect(f.find((x) => x.field === 1)?.value).toBe(SO_MARK + "い" + SI_MARK);
    // 中間の区間は空き（U+0000）だけ。空白（U+0020）8 個なら、中身の空白 8 バイトとして送られてしまう（core は U+0000 を空のセルにして、送るときに落とす）
    expect(f.find((x) => x.field === 2)?.value).toBe("\u0000".repeat(8));
  });
});
