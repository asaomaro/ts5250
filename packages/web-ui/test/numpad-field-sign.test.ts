import { describe, it, expect, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { classifyKey } from "../src/composables/useKeymap.js";
import { MSG_FIELD_MINUS_INVALID } from "../src/composables/opMessages.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **テンキーの − / ＋ は Field− / Field+、メイン行の `-` `+` は文字**（ACS の既定の割り当て `B109 = [field-]`・
 * `B107 = [field+]`。`20260921-numpad-field-sign`）。以前は物理キーを見分けず、数値欄の `-` `+` をすべて Field± にしていた。
 */
const plain = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

describe("classifyKey: テンキーを物理キーで見分ける", () => {
  const on = { fieldSignKeys: true };
  it("テンキーの − / ＋ は Field− / Field+（5250）", () => {
    expect(classifyKey({ ...plain, key: "-", code: "NumpadSubtract" }, on)).toEqual({ local: "field-minus" });
    expect(classifyKey({ ...plain, key: "+", code: "NumpadAdd" }, on)).toEqual({ local: "field-plus" });
  });

  it("**3270（fieldSignKeys なし）では振り分けない**（Field± は 5250 だけ。独立点検の指摘）", () => {
    expect(classifyKey({ ...plain, key: "-", code: "NumpadSubtract" })).toEqual({});
  });

  it("**IME の変換中（key が Process）は振り分けない**（変換の途中で欄を出ない。独立点検の指摘）", () => {
    expect(classifyKey({ ...plain, key: "Process", code: "NumpadAdd" }, on)).toEqual({});
    expect(classifyKey({ ...plain, key: "+", code: "NumpadAdd", isComposing: true }, on)).toEqual({});
  });

  it("メイン行の `-` `+` は文字（分類しない）", () => {
    expect(classifyKey({ ...plain, key: "-", code: "Minus" }, on)).toEqual({});
    expect(classifyKey({ ...plain, key: "+", code: "Semicolon", shiftKey: true }, on)).toEqual({});
  });

  it("Shift 付きのテンキーは割り当てない（ACS の割り当ては修飾なしの `B`）", () => {
    expect(classifyKey({ ...plain, shiftKey: true, key: "-", code: "NumpadSubtract" }, on)).toEqual({});
  });
});

const SID = "np1";
function cell(): Cell {
  return { char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false };
}
function fld(index: number, row: number, extra: Partial<Field> = {}): Field {
  return { index, row, col: 20, length: 7, protected: false, hidden: false, numeric: false,
    mdt: false, value: "", ...extra } as Field;
}
function seed(fs: Field[]): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  const s: ScreenSnapshot = { sessionId: SID, rows: 24, cols: 80, cursor: { row: fs[0]!.row, col: fs[0]!.col },
    keyboardLocked: false, cells, fields: fs };
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send: vi.fn() } as unknown as WsClient
  });
}
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
async function typeThenNumpad(fs: Field[], text: string, code: string, key: string, terminal?: "3270") {
  seed(fs);
  if (terminal) sessionsStore.get(SID)!.meta = { terminal };
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const el = w.element.querySelector('input.grid-input[data-field-index="1"][data-slice="0"]') as HTMLInputElement;
  el.focus();
  el.setSelectionRange(0, 0);
  await nextTick();
  for (const ch of text) el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
  await nextTick();
  const ev = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  (document.activeElement as HTMLElement).dispatchEvent(ev);
  await nextTick();
  await nextTick();
  return { w, ev };
}
const opmsg = (w: ReturnType<typeof mount>) => (w.find(".opmsg").exists() ? w.find(".opmsg").text().replace(/\s/g, "") : "");

describe("ペイン: テンキーの − を欄で押す", () => {
  it("**符号付き数値欄で `12` → テンキーの − → `    12-`**（文字としては入らない）", async () => {
    const { ev } = await typeThenNumpad([fld(1, 5, { numeric: true, signedNumeric: true }), fld(2, 7)], "12", "NumpadSubtract", "-");
    expect(sessionsStore.get(SID)!.edits.get(1)).toBe("    12-");
    expect(ev.defaultPrevented, "ブラウザが `-` を入力欄へ入れてしまう").toBe(true);
  });

  it("英数字欄でテンキーの − はエラー 0022（値はそのまま）", async () => {
    const { w } = await typeThenNumpad([fld(1, 5), fld(2, 7)], "AB", "NumpadSubtract", "-");
    expect(sessionsStore.get(SID)!.edits.get(1)).toBe("AB");
    expect(opmsg(w)).toBe(MSG_FIELD_MINUS_INVALID.replace(/\s/g, ""));
    // 操作員エラー（ACS `setErrorCode`）なので次の文字は入らない
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "C", bubbles: true, cancelable: true }));
    await nextTick();
    expect(sessionsStore.get(SID)!.edits.get(1)).toBe("AB");
  });

  it("DBCS 欄でもテンキーの ＋ は文字ではなく Field+（次の欄へ。`+` は入らない）", async () => {
    const { w } = await typeThenNumpad([fld(1, 5, { dbcsType: "open", length: 10 }), fld(2, 7)], "AB", "NumpadAdd", "+");
    expect(sessionsStore.get(SID)!.edits.get(1) ?? "").not.toContain("+");
    expect(document.activeElement).toBe(w.element.querySelector('input.grid-input[data-field-index="2"][data-slice="0"]'));
  });

  it("**3270 のセッションではテンキーの − は文字**（英数字欄に `-` が入る。独立点検の指摘）", async () => {
    await typeThenNumpad([fld(1, 5), fld(2, 7)], "12", "NumpadSubtract", "-", "3270");
    expect(sessionsStore.get(SID)!.edits.get(1)).toBe("12-");
  });

  it("**IME の変換中にテンキーの ＋ を押しても欄を出ない**", async () => {
    seed([fld(1, 5), fld(2, 7)]);
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    const el = w.element.querySelector('input.grid-input[data-field-index="1"][data-slice="0"]') as HTMLInputElement;
    el.focus();
    await nextTick();
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", code: "NumpadAdd", isComposing: true, bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(el);
  });

  it("**キャレットから始めた矩形選択の最中でもテンキーの − は Field−**（文字 `-` を入れない）", async () => {
    seed([fld(1, 5, { numeric: true, length: 6 }), fld(2, 7)]);
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    const el = w.element.querySelector('input.grid-input[data-field-index="1"][data-slice="0"]') as HTMLInputElement;
    el.focus();
    el.setSelectionRange(0, 0);
    await nextTick();
    for (const ch of "12") el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    await nextTick();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "-", code: "NumpadSubtract", bubbles: true, cancelable: true })
    );
    await nextTick();
    await nextTick();
    // 文字の `-` は入らない。数値専用の欄なので Field− が最終桁のゾーンを D にする（ACS と同じ。`20260921-field-minus-zone-d`）
    const v = sessionsStore.get(SID)!.edits.get(1)!;
    expect(v.slice(0, 5)).toBe("12   ");
    expect(v.includes("-"), "文字の - が入った").toBe(false);
    expect(document.activeElement).toBe(w.element.querySelector('input.grid-input[data-field-index="2"][data-slice="0"]'));
  });

  it("英数字欄でテンキーの ＋ は Field Exit と同じく次の欄へ", async () => {
    const { w } = await typeThenNumpad([fld(1, 5), fld(2, 7)], "AB", "NumpadAdd", "+");
    expect(document.activeElement).toBe(w.element.querySelector('input.grid-input[data-field-index="2"][data-slice="0"]'));
  });
});
