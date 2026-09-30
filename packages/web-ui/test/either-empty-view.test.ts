import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { SO_MARK, SI_MARK, DEAD_MARK } from "../src/composables/fieldValidate.js";

/**
 * **全角の状態の E・J の欄のカーソルの桁と End**（`20260928-either-empty-view`）。欄は (17,10) の 12 桁。期待値は実機の ACS のコアの測定:
 * - 空にした全角の E（`scripts/acs-probe/either-empty-type.txt`）: SO の次から Erase EOF → カーソル 17,11、そこへ い → `0e 4482`・カーソル 17,13、先頭で X → `e7`・17,11
 * - End（`scripts/acs-probe/je-field-end.txt`）: J の `あい`＋全角空白は い の直後・compact の E は SI の後ろ・open の E は字の直後・切り替えた E は字の直後・空にした全角の E は SO の次
 * 送るカーソルは AID の key メッセージの `cursor`
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

/** (17,10) から 12 桁の欄。`layout` は先頭からのセル（`so`・`si`・全角の字・空＝undefined） */
function snap(dbcsType: "only" | "either", layout: (string | undefined)[], dbcsOn: boolean): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const row = cells[16]!;
  let c = 9;
  for (const k of layout) {
    if (k === "so" || k === "si") row[c++] = cell(" ", k);
    else if (k === undefined) c++;
    else {
      row[c++] = cell(k, "dbcs-lead");
      row[c++] = cell("", "dbcs-tail");
    }
  }
  const f = { index: 1, row: 17, col: 10, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", dbcsType, ...(dbcsOn ? { eitherDbcsOn: true } : {}) } as Field;
  return { sessionId: "w1", rows: 24, cols: COLS, cursor: { row: 17, col: 11 }, keyboardLocked: false, cells, fields: [f] } as unknown as ScreenSnapshot;
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
let paneWrapper: ReturnType<typeof mount> | undefined;
async function pane(s: ScreenSnapshot): Promise<void> {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: "w1", label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send } as unknown as WsClient
  });
  const w = mount(EmulatorPane, { props: { sessionId: "w1", focused: true }, attachTo: document.body });
  mounted.push(w);
  paneWrapper = w;
  await nextTick();
  (w.find("input.grid-input:not([readonly])[data-slice='0']").element as HTMLInputElement).focus();
  await nextTick();
}
const key = async (k: string, altKey = false) => {
  (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey, bubbles: true, cancelable: true }));
  await nextTick();
};
/** Enter を押して、送った key メッセージ（カーソル・欄） */
async function enter() {
  await key("Enter");
  return send.mock.calls.map((c) => c[0] as { type: string; cursor?: { row: number; col: number }; fields?: unknown[] }).filter((m) => m.type === "key").at(-1)!;
}

describe("空にした全角の E（SO の桁を残す）", () => {
  it("**SO の次から Erase EOF → カーソルは SO の次（17,11）**", async () => {
    await pane(snap("either", ["so", "あ", "si"], true));
    await key("Home");
    await key("Delete", true);
    const m = await enter();
    expect(m.cursor).toEqual({ row: 17, col: 11 });
    expect(m.fields).toEqual([{ field: 1, value: "", eitherDbcsOn: true }]);
  });

  it("**空にしてから い → `0e 4482`・カーソル 17,13**（~~17,14~~: 空きが半角空白で SI の後ろへ出ていた）", async () => {
    await pane(snap("either", ["so", "あ", "si"], true));
    await key("Home");
    await key("Delete", true);
    await key("い");
    const m = await enter();
    expect(m.cursor).toEqual({ row: 17, col: 13 });
    expect(m.fields).toEqual([{ field: 1, value: SO_MARK + "い", eitherDbcsOn: true }]);
  });

  it("**空にしてから先頭で X → 半角へ切り替えて `e7`・カーソル 17,11**（~~X が打てなかった~~）", async () => {
    await pane(snap("either", ["so", "あ", "si"], true));
    await key("Home");
    await key("Delete", true);
    await key("Home");
    await key("X");
    const m = await enter();
    expect(m.cursor).toEqual({ row: 17, col: 11 });
    expect(m.fields).toEqual([{ field: 1, value: "X", eitherDbcsOn: false }]);
  });
});

describe("compact の E の全角空白は中身", () => {
  it("**ホストが SI の前に書いた全角空白は落とさない**（compact の空きは半角空白。落とすと `0e 4482 4040 0f` が `0e 4482 0f` になる）", async () => {
    await pane(snap("either", ["so", "あ", "\u3000", "si"], true));
    await key("Home");
    await key("い"); // あ を上書き
    const m = await enter();
    expect(m.fields).toEqual([{ field: 1, value: SO_MARK + "い\u3000" + SI_MARK, eitherDbcsOn: true }]);
  });
});

describe("複数行の貼り付け（独立点検の指摘）", () => {
  it("**空きが全角空白の E の途中の桁へ貼ると、その桁に置く**（半角空白で埋めると字が左へずれ、SO と SI の間に半角が混ざる）", async () => {
    await pane(snap("either", ["so", ...Array<undefined>(10).fill(undefined), "si"], true)); // SI が最後の桁（full）
    const grid = paneWrapper!.findComponent(ScreenGrid);
    (grid.vm as unknown as { pasteAt: (r: number, c: number, t: string) => void }).pasteAt(17, 15, "い\nう");
    await nextTick();
    const edits = (grid.emitted("edit") ?? []) as [number, string, { wire?: string }?][];
    const last = edits[edits.length - 1]!;
    expect(last[1]).toBe("\u3000\u3000い"); // SO(10)・空き(11-12)・空き(13-14)・い(15-16)
    // 貼っていない手前の桁は書かなかった桁（空き＝NUL の組）。READ MDT は 40 40・ALT は 00 00 で送る（`20260930-wide-nul`）
    expect(last[2]?.wire).toBe(SO_MARK + DEAD_MARK.repeat(4) + "い" + DEAD_MARK.repeat(4) + SI_MARK);
  });
});

describe("J・全角の E の End（ACS `getEndPosition`: SO・SI を除いた内側で 0x40 と NUL を飛ばす）", () => {
  it("J の `あい`＋全角空白: い の直後（17,15）", async () => {
    await pane(snap("only", ["so", "あ", "い", "　", "　", "　", "si"], false));
    await key("Home");
    await key("End");
    expect((await enter()).cursor).toEqual({ row: 17, col: 15 });
  });

  it("compact の E: SI の後ろ（17,14）", async () => {
    await pane(snap("either", ["so", "あ", "si"], true));
    await key("Home");
    await key("End");
    expect((await enter()).cursor).toEqual({ row: 17, col: 14 });
  });

  it("open の E（中身の中から Erase EOF した E）: 字の直後（17,13）", async () => {
    await pane(snap("either", ["so", "あ", "い", "si"], true));
    await key("Home");
    await key("ArrowRight");
    await key("Delete", true);
    await key("Home");
    await key("End");
    expect((await enter()).cursor).toEqual({ row: 17, col: 13 });
  });

  it("半角から切り替えた E（full）: 字の直後（17,13）", async () => {
    await pane(snap("either", [], false));
    await key("ArrowLeft"); // 欄の先頭
    await key("あ");
    await key("ArrowLeft");
    await key("End");
    const m = await enter();
    expect(m.cursor).toEqual({ row: 17, col: 13 });
    expect(m.fields).toEqual([{ field: 1, value: SO_MARK + "あ" + DEAD_MARK.repeat(8) + SI_MARK, eitherDbcsOn: true }]);
  });

  it("空にした全角の E: SO の次（17,11）", async () => {
    await pane(snap("either", ["so", "あ", "い", "si"], true));
    await key("Home");
    await key("Delete", true);
    await key("End");
    expect((await enter()).cursor).toEqual({ row: 17, col: 11 });
  });
});
