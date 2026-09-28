import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { SO_MARK, SI_MARK, DEAD_MARK } from "../src/composables/fieldValidate.js";

/**
 * **J・全角の E の欄は、欄の形（`jeShapeOf`）どおりの印入りの値で送る**（`20260928-je-field-shape`）。
 * ACS は J・全角の E の欄を SO・字・SI のセルで持ち、SI の位置が欄の形で決まる（実機の ACS のコアの JEEDIT。
 * `scripts/acs-probe/je-field-edit.txt`）。画面の値（`edits`）は字だけのまま、送る値（`SessionState.wire`）だけが印入りになる
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

/** (5,20) から 12 桁の欄。`kinds` は先頭からのセル（SO=`so`、全角=字、SI=`si`、空=undefined） */
function snap(dbcsType: "only" | "either", layout: (string | undefined)[], mdt = false): ScreenSnapshot {
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
  const dbcsOn = layout[0] === "so";
  const f = { index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt, value: "", dbcsType, ...(dbcsType === "either" && dbcsOn ? { eitherDbcsOn: true } : {}) } as Field;
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
const key = async (el: HTMLInputElement, k: string, altKey = false) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, altKey, bubbles: true, cancelable: true }));
  await nextTick();
};
const sent = () =>
  send.mock.calls.map((c) => c[0] as { type: string; fields?: { field: number; value: string; eitherDbcsOn?: boolean }[] }).filter((m) => m.type === "key").at(-1)?.fields;

describe("J・全角の E の欄の送る形", () => {
  it("**J の欄は full**: SI は欄の最後の桁、空きは NUL の組（ACS J1）", async () => {
    const { el } = await pane(snap("only", ["so", "あ", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "si"]));
    await key(el, "Home"); // あ の桁
    await key(el, "ArrowRight"); // あ の後ろ
    await key(el, "い");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あい" + DEAD_MARK.repeat(6) + SI_MARK }]);
  });

  it("**SI が中身の直後の E は compact**: 足した字の後ろへ SI が動く（ACS J2）", async () => {
    const { el } = await pane(snap("either", ["so", "あ", "si"]));
    await key(el, "End");
    await key(el, "い");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あい" + SI_MARK, eitherDbcsOn: true }]);
  });

  it("**SI の無い E は open**: SI を足さない（ACS J3）", async () => {
    const { el } = await pane(snap("either", ["so", "あ"]));
    await key(el, "End");
    await key(el, "い");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あい", eitherDbcsOn: true }]);
  });

  it("**compact の E を Erase Input で消すと open**: SI も内側なので消え、次に打った字に SI を足さない（ACS `eraseField_Work`）", async () => {
    const { el } = await pane(snap("either", ["so", "あ", "si"], true));
    await key(el, "End", true); // Erase Input
    await nextTick();
    const input = document.activeElement as HTMLInputElement;
    await key(input, "End"); // 空の中身の先頭
    await key(input, "い");
    await key(input, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "い", eitherDbcsOn: true }]);
  });

  it("**半角の E を先頭で全角へ切り替えると full**（ACS は SO…NUL の組…SI を欄いっぱいに置く）", async () => {
    const { el } = await pane(snap("either", []));
    await key(el, "あ");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あ" + DEAD_MARK.repeat(8) + SI_MARK, eitherDbcsOn: true }]);
  });

  it("半角の E は印を付けない（形を持たない）", async () => {
    const { el } = await pane(snap("either", []));
    await key(el, "X");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: "X", eitherDbcsOn: false }]);
  });

  it("**SI が欄の最後の桁の E は full**（ホストが欄いっぱいに書いた全角の E）", async () => {
    const { el } = await pane(snap("either", ["so", "あ", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "い");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あい" + DEAD_MARK.repeat(6) + SI_MARK, eitherDbcsOn: true }]);
  });

  it("**compact の E を中身の中から Erase EOF で消すと open**（SI も 1 桁の内側。ACS の JEEDIT）", async () => {
    keybindingsStore.set("alt+Delete", "local:erase-eof");
    const { el } = await pane(snap("either", ["so", "あ", "い", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight"); // い の桁
    await key(el, "Delete", true); // Erase EOF
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あ", eitherDbcsOn: true }]);
  });

  it("**カーソルが SI の桁でも SI は消える**（SI は 1 桁の内側の最後）", async () => {
    keybindingsStore.set("alt+Delete", "local:erase-eof");
    const { el } = await pane(snap("either", ["so", "あ", "い", "si"]));
    await key(el, "Home");
    await key(el, "ArrowRight");
    await key(el, "ArrowRight"); // SI の桁
    await key(el, "Delete", true);
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あい", eitherDbcsOn: true }]);
  });

  it("**SI より後ろから Erase EOF しても SI は残る**", async () => {
    keybindingsStore.set("alt+Delete", "local:erase-eof");
    const { el } = await pane(snap("either", ["so", "あ", "い", "si"]));
    await key(el, "Home");
    for (let i = 0; i < 3; i++) await key(el, "ArrowRight"); // SI の後ろ
    await key(el, "Delete", true);
    await key(el, "Home");
    await key(el, "Delete"); // 値を変えて MDT を立てる（あ を消す）
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "い" + SI_MARK, eitherDbcsOn: true }]);
  });

  it("**全角の E を先頭で半角へ切り替えたら印入りの値を送らない**（前の送る形を持ち越さない）", async () => {
    const { el } = await pane(snap("either", ["so", "あ", "si"]));
    await key(el, "End");
    await key(el, "い"); // 印入りの送る形が付く
    await key(el, "Home");
    await key(el, "X"); // 先頭で半角 → 欄を空にして半角へ
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: "X", eitherDbcsOn: false }]);
  });

  it("**新しい画面では形を捨てる**: 切り替えで full にした欄も、次の画面ではセルから形を決め直す", async () => {
    const { el } = await pane(snap("either", []));
    await key(el, "あ"); // full へ
    const s = sessionsStore.byId.get("w1")!;
    s.snapshot = snap("either", ["so", "あ", "si"]);
    s.edits.clear();
    await nextTick();
    await nextTick();
    const input = document.querySelector("input.grid-input:not([readonly])[data-slice='0']") as HTMLInputElement;
    input.focus();
    await nextTick();
    await key(input, "End");
    await key(input, "い");
    await key(input, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あい" + SI_MARK, eitherDbcsOn: true }]);
  });

  it("**半角へ切り替えてから全角へ戻すと full**（画面の SI の位置〔compact〕には戻らない——ACS は切り替えのたびに欄いっぱいに置き直す）", async () => {
    const { el } = await pane(snap("either", ["so", "あ", "si"]));
    await key(el, "Home");
    await key(el, "X"); // 半角へ
    await key(el, "Backspace"); // 空の半角の E
    await key(el, "い"); // 全角へ戻す
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "い" + DEAD_MARK.repeat(8) + SI_MARK, eitherDbcsOn: true }]);
  });

  it("**全角の状態なのに画面に SO の無い E（空のまま全角の状態を持ち越した欄）は full**", async () => {
    const s = snap("either", []);
    (s.fields[0] as { eitherDbcsOn?: boolean }).eitherDbcsOn = true;
    const { el } = await pane(s);
    await key(el, "あ");
    await key(el, "Enter");
    expect(sent()).toEqual([{ field: 1, value: SO_MARK + "あ" + DEAD_MARK.repeat(8) + SI_MARK, eitherDbcsOn: true }]);
  });
});
