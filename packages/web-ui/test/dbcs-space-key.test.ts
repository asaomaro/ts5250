import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **J・G・E（DBCS 中）の欄で打った Space は全角空白（U+3000）になる**（ACS `processCharKeyStroke` の `convertSBCSCharToDBCS`。
 * `20260921-dbcs-space-key`）。実機の ACS のコアで測った（`scripts/acs-probe/dbcs-space-key.txt`。DBCSFE の画面・930）:
 * G・J は `あ`＋Space＋`い` が `あ　い`（間が全角空白）、先頭の Space も全角空白。O は SBCS の空白のまま。
 * E は空の欄・SBCS の字の後の Space が SBCS の空白で、`あ` の後は全角空白（E は最初の字で SBCS か DBCS かが決まる）
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const fld = (dbcsType: Field["dbcsType"], extra: Partial<Field> = {}): Field =>
  ({ index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...(dbcsType ? { dbcsType } : {}), ...extra }) as Field;

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});

async function grid(f: Field) {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const next = { index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
  const snapshot = { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: f.row, col: f.col }, keyboardLocked: false, cells, fields: [f, next] } as unknown as ScreenSnapshot;
  const edits = new Map<number, string>();
  const w = mount(ScreenGrid, {
    props: { snapshot, edits, focused: true, busy: false, cursor: snapshot.cursor, onEdit: (i: number, v: string) => void edits.set(i, v) },
    attachTo: document.body
  });
  mounted.push(w as never);
  await nextTick();
  const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  el.focus();
  await nextTick();
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      await nextTick();
    }
  };
  return { type, value: () => edits.get(1), notices: () => ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0]) };
}

describe("DBCS の欄の Space キー", () => {
  it("**J（全角専用）: Space は全角空白**（`あ`＋Space＋`い` → `あ　い`。先頭の Space も。「全角のみ」と拒否しない）", async () => {
    const { type, value, notices } = await grid(fld("only"));
    await type("あ", " ", "い");
    expect(value()).toBe("あ　い");
    expect(notices()).toEqual([]);
    const lead = await grid(fld("only"));
    await lead.type(" ", "あ");
    expect(lead.value()).toBe("　あ");
  });

  it("**G（純 DBCS）: Space は全角空白**", async () => {
    const { type, value, notices } = await grid(fld("pure"));
    await type("あ", " ", "い");
    expect(value()).toBe("あ　い");
    expect(notices()).toEqual([]);
    const lead = await grid(fld("pure"));
    await lead.type(" ", "あ");
    expect(lead.value()).toBe("　あ");
  });

  it("**E（either）: DBCS の状態（全角の字が入っている）のときだけ全角空白**。空の欄・SBCS の字の後は SBCS の空白のまま", async () => {
    const dbcs = await grid(fld("either"));
    await dbcs.type("あ", " ");
    expect(dbcs.value(), "あ の後の Space は全角空白").toBe("あ　");
    const sbcs = await grid(fld("either"));
    await sbcs.type("X", " ", "Y");
    expect(sbcs.value(), "SBCS の字の後の Space は SBCS の空白").toBe("X Y");
    const lead = await grid(fld("either"));
    await lead.type(" ", "X");
    expect(lead.value(), "空の欄の先頭の Space は SBCS の空白").toBe(" X");
  });

  it("**O（open）: Space は SBCS の空白のまま**（対象外）", async () => {
    const { type, value } = await grid(fld("open"));
    await type("あ", " ", "い");
    expect(value()).toBe("あ い");
  });
});
