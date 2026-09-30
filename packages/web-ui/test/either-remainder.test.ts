import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { rawSentinel } from "@ts5250/tn5250/browser";
import { SO_MARK, SI_MARK, DEAD_MARK } from "../src/composables/fieldValidate.js";

/**
 * **E（DBCS either）の欄の残り**（`20260930-either-remainder`）。期待値は実機の ACS のコア（`scripts/acs-probe/either-remainder.txt`・`either-insert.txt`）で
 * ホストが受け取ったバイト列: 伏せ字の E にも全角が打てて空の E と同じ形で届く／Dup は欄の残りの**バイト**ぶん 0x1C を置く（`あ` の後ろの `い` の桁で 8 個）／
 * 全角の状態の E への挿入は欄の最後の桁を SI の分に取っておく（`SO あいうえ SI`＋空き 2 に全角 1 字は余地なし）
 */
const COLS = 80;
const DUP = rawSentinel(0x1c);
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

/** (5,20) から 12 桁の E の欄。`layout` は先頭からのセル（SO=`so`、全角=字、SI=`si`、空=undefined） */
function snap(layout: (string | undefined)[], opts: { dupEnable?: boolean; hidden?: boolean } = {}): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const row = cells[4]!;
  let c = 19;
  for (const k of layout) {
    if (k === "so" || k === "si") row[c++] = cell(" ", k);
    else if (k === undefined) c++;
    else {
      row[c++] = cell(k, "dbcs-lead");
      row[c++] = cell("", "dbcs-tail");
    }
  }
  const f = {
    index: 1, row: 5, col: 20, length: 12, protected: false, hidden: opts.hidden === true, numeric: false, mdt: false, value: "", dbcsType: "either",
    ...(layout[0] === "so" ? { eitherDbcsOn: true } : {}),
    ...(opts.dupEnable ? { dupEnable: true } : {})
  } as Field;
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
const key = async (el: HTMLInputElement, k: string, mods: { shiftKey?: boolean } = {}) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  await nextTick();
};
const sent = () =>
  send.mock.calls.map((c) => c[0] as { type: string; fields?: { field: number; value: string; eitherDbcsOn?: boolean }[] }).filter((m) => m.type === "key").at(-1)?.fields;

describe("全角の状態の E への挿入は最後の桁を SI の分に取っておく（ACS の i1）", () => {
  it("`SO あいうえ SI`＋空き 2（10 バイト）に全角 1 字は余地なし。値は変わらない", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "う", "え", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight"); // い の桁
    await key(el, "Insert");
    await key(el, "か");
    await key(el, "Enter");
    expect(sent() ?? []).toEqual([]);
  });

  it("`SO あいう SI`＋空き 4（8 バイト）は 1 字入り、続けてもう 1 字は余地なし", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "う", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert");
    await key(el, "か");
    await key(el, "き"); // 10 バイトの後、もう 2 バイトは要るが最後の桁を除くと 1 バイトしか無い
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あかいう" + SI_MARK, eitherDbcsOn: true }]);
  });

  it("full でちょうど 2 バイト空いている欄（`SO あいうえ` NUL 2 つ `SI`）にも 1 字入る（空きが SI の手前なので取っておく桁は要らない）", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "う", "え", undefined, undefined, "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert");
    await key(el, "か");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あかいうえ" + SI_MARK, eitherDbcsOn: true }]);
  });

  it("SI が欄の最後の桁の形（full）は空きが SI の手前なので従来どおり入る（空き 6 の欄に 2 バイトの字）", async () => {
    const { el } = await pane(snap(["so", "あ", "い", undefined, undefined, undefined, undefined, undefined, undefined, "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert");
    await key(el, "か");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あかい" + DEAD_MARK.repeat(4) + SI_MARK, eitherDbcsOn: true }]);
  });
});

describe("挿入モードの貼り付けも同じ余地で数える（ACS は 1 字ずつ insertChar）", () => {
  const paste = async (el: HTMLInputElement, text: string) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => text };
    el.dispatchEvent(ev);
    await nextTick();
  };
  it("`SO あいうえ SI`＋空き 2 に全角 1 字を貼ると余地なし。値は変わらない", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "う", "え", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert");
    await paste(el, "か");
    await key(el, "Enter");
    expect(sent() ?? []).toEqual([]);
  });
  it("複数行の貼り付けの経路（改行つき）も同じ: 余地なし", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "う", "え", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert");
    await paste(el, "か\n");
    await key(el, "Enter");
    expect(sent() ?? []).toEqual([]);
  });
  it("複数行の貼り付けの経路（改行つき）も同じ: 余地があれば入る", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "う", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert");
    await paste(el, "か\n");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あかいう" + SI_MARK, eitherDbcsOn: true }]);
  });
  it("`SO あいう SI`＋空き 4 には 1 字貼れる", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "う", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert");
    await paste(el, "か");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あかいう" + SI_MARK, eitherDbcsOn: true }]);
  });
});

describe("Dup は欄の残りのバイトぶん 0x1C を置く（ACS の X2）", () => {
  it("`SO あい SI`＋空き 6 の い の桁で Dup すると 0x1C は 8 個（い 2＋空き 6）", async () => {
    const { el } = await pane(snap(["so", "あ", "い", "si"], { dupEnable: true }));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "Insert", { shiftKey: true }); // Dup
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あ" + DUP.repeat(8) + SI_MARK, eitherDbcsOn: true }]);
  });

  it("空の E の先頭で Dup すると 12 個（半角の状態。SO・SI は付かない）", async () => {
    const { el } = await pane(snap([], { dupEnable: true }));
    await key(el, "Insert", { shiftKey: true });
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: DUP.repeat(12), eitherDbcsOn: false }]);
  });
});

describe("伏せ字の E も全角が打てる（ACS の X1）", () => {
  it("空の伏せ字の E に全角を打つと、ふつうの E と同じ full の形で届く。値は DOM に出さない", async () => {
    const { el } = await pane(snap([], { hidden: true }));
    await key(el, "あ");
    expect(el.value.trim()).toBe("");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あ" + DEAD_MARK.repeat(8) + SI_MARK, eitherDbcsOn: true }]);
  });

  it("全角の後の半角は断られ、値は変わらない", async () => {
    const { el } = await pane(snap([], { hidden: true }));
    await key(el, "あ");
    await key(el, "A");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あ" + DEAD_MARK.repeat(8) + SI_MARK, eitherDbcsOn: true }]);
  });

  it("半角の後の全角も断られる", async () => {
    const { el } = await pane(snap([], { hidden: true }));
    await key(el, "A");
    await key(el, "B");
    await key(el, "あ");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: "AB", eitherDbcsOn: false }]);
  });
});
