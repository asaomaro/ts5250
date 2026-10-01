import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { SO_MARK, SI_MARK } from "../src/composables/fieldValidate.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **SI の無い E（open）への打鍵**（`20260930-open-e`。実機 `scripts/acs-probe/open-e-typing.txt`）: compact の E を SO の次から Erase EOF して open にすると、
 * 先頭の字は SO の次・2 字目以降は新しい `SO 字… SI` の組で送る（`いう` → `0e 4482 0e 4483 0f`）。ホストが `SO 字` と書いた open の E は従来どおり（`je-field-shape.test.ts` の J3）
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});

/** (5,10) の E 欄 12 桁。compact の `SO あ SI` */
function snapshot(): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const r = cells[4]!;
  r[9] = cell(" ", "so");
  r[10] = cell("あ", "dbcs-lead");
  r[11] = cell("", "dbcs-tail");
  r[12] = cell(" ", "si");
  const f = { index: 1, row: 5, col: 10, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "あ", dbcsType: "either", eitherDbcsOn: true } as unknown as Field;
  return { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 10 }, keyboardLocked: false, cells, fields: [f] } as unknown as ScreenSnapshot;
}

async function openErased() {
  const wires = new Map<number, string | undefined>();
  const w = mount(ScreenGrid, {
    props: { snapshot: snapshot(), edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 }, onEdit: (i: number, _v: string, meta?: { wire?: string }) => void wires.set(i, meta?.wire) },
    attachTo: document.body
  });
  mounted.push(w as never);
  await nextTick();
  const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  el.focus();
  await nextTick();
  el.setSelectionRange(1, 1);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await nextTick();
  (w.vm as unknown as { eraseEof: () => void }).eraseEof();
  await nextTick();
  const key = async (k: string) => {
    (document.activeElement as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await nextTick();
  };
  return { wires, key };
}

describe("Erase で SI も中身も消えた E に打つ", () => {
  it("1 字だけなら `SO 字`（SI は足さない）", async () => {
    const t = await openErased();
    await t.key("い");
    expect(t.wires.get(1)).toBe(SO_MARK + "い");
  });
  it("2 字目から新しい `SO 字… SI` の組（`いう` → `SO い SO う SI`）", async () => {
    const t = await openErased();
    await t.key("い");
    await t.key("う");
    expect(t.wires.get(1)).toBe(SO_MARK + "い" + SO_MARK + "う" + SI_MARK);
  });
  it("3 字目は 2 字目の組の中（`いうえ` → `SO い SO う え SI`）", async () => {
    const t = await openErased();
    for (const ch of "いうえ") await t.key(ch);
    expect(t.wires.get(1)).toBe(SO_MARK + "い" + SO_MARK + "うえ" + SI_MARK);
  });
  it("欄の長さは新しい組の SO・SI を数える（12 桁に 4 字まで。5 字目の か は入らない）", async () => {
    const t = await openErased();
    for (const ch of "いうえおか") await t.key(ch);
    expect(t.wires.get(1)).toBe(SO_MARK + "い" + SO_MARK + "うえお" + SI_MARK);
  });
  it("先頭の Space（全角空白）も字として数える（`Space い` → `SO 　 SO い SI`）", async () => {
    const t = await openErased();
    await t.key(" ");
    await t.key("い");
    expect(t.wires.get(1)).toBe(SO_MARK + "　" + SO_MARK + "い" + SI_MARK);
  });
});
