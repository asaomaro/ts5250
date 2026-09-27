import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { keybindingsStore } from "../src/stores/keybindings.js";

/**
 * **全角の状態のまま空にした E 欄は、送信する fields に `eitherDbcsOn` を添える**（`20260927-either-field-so`）。
 * コアは空の値では状態を変えられない（`noteEitherMode` が空の値を無視する）ため、画面の側で切り替えが
 * 起きた事実を伝えないと、コアの前の状態が誤って残る（独立点検で見つかった不具合）。
 * ACS はこの状態のまま空にした E 欄を SO の 1 バイトで送る（実機の ACS のコア。`scripts/acs-probe/either-empty.txt`）
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

/** E 欄（1 区間・(5,20) から 6 桁）を「あい」で描く（SO・あ・SI・い なし SI）。dbcsOn は core の申告 */
function snap(eitherDbcsOn: boolean, filled: boolean): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const row = cells[4]!;
  if (filled) {
    row[19] = cell(" ", "so");
    row[20] = cell("あ", "dbcs-lead");
    row[21] = cell("", "dbcs-tail");
    row[22] = cell("い", "dbcs-lead");
    row[23] = cell("", "dbcs-tail");
  }
  const f: Field = { index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", dbcsType: "either", ...(eitherDbcsOn ? { eitherDbcsOn: true } : {}) } as Field;
  return { sessionId: "w1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [f] } as unknown as ScreenSnapshot;
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
});
function seed(s: ScreenSnapshot): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: "w1", label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send } as unknown as WsClient
  });
}
async function pane(s: ScreenSnapshot) {
  seed(s);
  const w = mount(EmulatorPane, { props: { sessionId: "w1", focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const el = w.find("input.grid-input:not([readonly])[data-slice='0']").element as HTMLInputElement;
  el.focus();
  await nextTick();
  return { w, el };
}
const key = async (el: HTMLInputElement, k: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await nextTick();
};
/** 送った key メッセージの fields */
const sentFields = () =>
  send.mock.calls.map((c) => c[0] as { type: string; fields?: { field: number; value: string; eitherDbcsOn?: boolean }[] }).filter((m) => m.type === "key");

describe("E 欄を空にしたときの eitherDbcsOn の送信", () => {
  it("**全角の状態のまま Backspace で空にした**: 送る fields に `eitherDbcsOn:true` が付く", async () => {
    const { el } = await pane(snap(true, true));
    await key(el, "End");
    await key(el, "Backspace");
    await key(el, "Backspace");
    await key(el, "Enter");
    const msgs = sentFields();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.fields).toEqual([{ field: 1, value: "", eitherDbcsOn: true }]);
  });

  it("**半角へ切り替えてから空にした**: 送る fields に `eitherDbcsOn:false` が付く（コアの前の全角状態を誤って残さない）", async () => {
    const { el } = await pane(snap(true, true));
    await key(el, "Home"); // 欄の先頭（SO の桁）
    await key(el, "X"); // 全角の並びの先頭で半角 → 欄を空にして半角へ切り替え
    await key(el, "Backspace"); // X を消して空に
    await key(el, "Enter");
    const msgs = sentFields();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.fields).toEqual([{ field: 1, value: "", eitherDbcsOn: false }]);
  });

  it("元から空・半角の状態の欄に何も打たなければ、そもそも fields に載らない（edits が空）", async () => {
    const { el } = await pane(snap(false, false));
    await key(el, "Enter");
    const msgs = sentFields();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.fields ?? []).toEqual([]);
  });

  it("**Erase Input でも状態を添える**（ACS は Erase Input の後も全角の状態の E 欄を `0e` で送る）", async () => {
    const s = snap(true, true);
    (s.fields[0] as { mdt: boolean }).mdt = true; // Erase Input は MDT の立った欄だけ消す
    const { el } = await pane(s);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", altKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    await key(document.activeElement as HTMLInputElement, "Enter");
    const msgs = sentFields();
    expect(msgs.at(-1)!.fields).toEqual([{ field: 1, value: "", eitherDbcsOn: true }]);
  });

  it("**状態は欄ごと**: 別の E 欄で切り替えても、前の欄の切り替えは消えない", async () => {
    // 欄 1（(5,20)・core は半角）と欄 2（(8,20)・core は全角で `あい`）
    const s = snap(false, false);
    const row8 = (s.cells as Cell[][])[7]!;
    row8[19] = cell(" ", "so");
    row8[20] = cell("あ", "dbcs-lead");
    row8[21] = cell("", "dbcs-tail");
    row8[22] = cell(" ", "si");
    (s.fields as Field[]).push({ index: 2, row: 8, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", dbcsType: "either", eitherDbcsOn: true } as Field);
    const { w, el } = await pane(s);
    await key(el, "あ"); // 欄 1 を全角へ切り替え
    const el2 = w.findAll("input.grid-input:not([readonly])[data-slice='0']")[1]!.element as HTMLInputElement;
    el2.focus();
    await nextTick();
    await key(el2, "Home");
    await key(el2, "X"); // 欄 2 を半角へ切り替え
    el.focus();
    await nextTick();
    await key(el, "End");
    await key(el, "Backspace"); // 欄 1 を空に（全角のまま）
    await key(el, "Enter");
    const f1 = sentFields().at(-1)!.fields!.find((f) => f.field === 1);
    expect(f1).toEqual({ field: 1, value: "", eitherDbcsOn: true });
  });
});
