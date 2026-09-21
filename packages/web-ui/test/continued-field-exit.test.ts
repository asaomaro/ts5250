import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { DUP_BYTE } from "../src/composables/fieldEdit.js";
import { rawSentinel } from "@ts5250/tn5250/browser";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **継続欄（EDTMSK で割られた欄）の Erase EOF・Field Exit・Field±・Dup は、続く区間まで届く。欄を出る行き先は鎖の後ろ。**
 *
 * 実機の ACS のコア（社内機・日付欄 4/2/2 の 3 区間。`scripts/acs-probe/continued-field-erase-exit.txt`。`20260922-continued-field-exit`）:
 * - 最初の区間の 2 桁目で Erase EOF → `1234/56/78` が `1   /  /  `（続く区間は全桁消える）。2 区間目の途中なら `1234/5 /  `
 * - Field Exit も同じ消去をして、カーソルは**鎖の後ろ**（次の欄。無ければ画面の最初の入力欄）へ移る——次の区間ではない。最後の区間からも同じ
 * - DUP 可の継続欄で Dup → カーソルの区間はカーソルから、続く区間は全桁が Dup 文字（0x1C）になり、カーソルは鎖の後ろの欄へ
 * 当 PJ は現在の区間だけを消し・埋め、行き先は次の区間だった。
 */
const COLS = 80;
const ROW = 5;
const DUP = rawSentinel(DUP_BYTE);

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; col: number; length: number }): Field {
  return { row: ROW, protected: false, hidden: false, numeric: true, mdt: false, value: "", ...over } as Field;
}
function snapOf(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  return { sessionId: "s1", rows: 24, cols: COLS, cursor: { row: ROW, col: 24 }, keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}
/** `9999/99/99`（4 ＋ 2 ＋ 2 の 3 区間）。DUP 可にできる */
const chain = (over: Partial<Field> = {}, value = ["1234", "56", "78"]): Field[] => [
  fld({ index: 1, col: 24, length: 4, continued: "first", value: value[0]!, ...over }),
  fld({ index: 2, col: 29, length: 2, continued: "middle", value: value[1]!, ...over }),
  fld({ index: 3, col: 32, length: 2, continued: "last", value: value[2]!, ...over })
];

describe("継続欄の Erase EOF・Field Exit・Field±・Dup（ScreenGrid）", () => {
  beforeEach(() => document.body.replaceChildren());

  const mountGrid = (fields: Field[]) =>
    mount(ScreenGrid, { props: { snapshot: snapOf(fields), edits: new Map(), focused: true, busy: false, cursor: { row: ROW, col: 24 } }, attachTo: document.body });
  const inputs = (w: ReturnType<typeof mountGrid>) =>
    Array.from(w.element.querySelectorAll('input.grid-input:not([readonly])[data-slice="0"]')) as HTMLInputElement[];
  /** 区間 `seg` の桁 `caret` にカーソルを置く（編集モデルへは、修飾キーだけの keydown で native の caret を写す） */
  async function place(w: ReturnType<typeof mountGrid>, seg: number, caret: number) {
    const el = inputs(w)[seg]!;
    el.focus();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }));
    await nextTick();
  }
  const values = (w: ReturnType<typeof mountGrid>, fields: Field[]) => {
    const last = new Map<number, string>();
    for (const [idx, val] of (w.emitted("edit") as unknown[][] | undefined) ?? []) last.set(idx as number, val as string);
    return fields.map((f) => last.get(f.index) ?? f.value);
  };
  const call = (w: ReturnType<typeof mountGrid>, name: "eraseEof" | "fieldExit" | "fieldPlus" | "dup") =>
    (w.vm as unknown as Record<string, () => void>)[name]!();

  it("**Erase EOF: 最初の区間の 2 桁目から → 1 桁だけ残り、続く区間は全桁消える**（実機 B1: `1   /  /  `）", async () => {
    const fields = chain();
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 0, 1);
    call(w, "eraseEof");
    await nextTick();
    expect(values(w, fields)).toEqual(["1", "", ""]);
    // カーソルの区間へ、途中の値（全桁を消した `""`）を出さない——続く区間だけを直接埋める
    const forFirst = ((w.emitted("edit") as unknown[][]) ?? []).filter((e) => e[0] === 1).map((e) => e[1]);
    expect(forFirst).toEqual(["1"]);
  });

  it("**Erase EOF: 2 区間目の途中から → 1 区間目は変わらず、2 区間目の残りと 3 区間目が消える**（実機 B1b: `1234/5 /  `）", async () => {
    const fields = chain();
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 1, 1);
    call(w, "eraseEof");
    await nextTick();
    expect(values(w, fields)).toEqual(["1234", "5", ""]);
  });

  it("**Erase EOF: 最後の区間なら、その区間だけ**（続く区間が無い）", async () => {
    const fields = chain();
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 2, 1);
    call(w, "eraseEof");
    await nextTick();
    expect(values(w, fields)).toEqual(["1234", "56", "7"]);
  });

  it.each(["fieldExit", "fieldPlus"] as const)("**%s: 続く区間まで消え、欄を出る印（`leaving`）つきで field-full を出す**（実機 B2・B4・B5）", async (name) => {
    const fields = chain();
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 0, 1);
    call(w, name);
    await nextTick();
    expect(values(w, fields)).toEqual(["1", "", ""]);
    // [欄の index, viaFieldExit, leaving]
    expect((w.emitted("field-full") as unknown[][])[0]).toEqual([1, true, true]);
  });

  it("**Field Exit: 2 区間目の途中から → 3 区間目が消える**（実機 B4: `1234/5 /  `）", async () => {
    const fields = chain();
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 1, 1);
    call(w, "fieldExit");
    await nextTick();
    expect(values(w, fields)).toEqual(["1234", "5", ""]);
    expect((w.emitted("field-full") as unknown[][])[0]![0]).toBe(2);
  });

  it("**Dup: カーソルの区間はカーソルから、続く区間は全桁が Dup 文字になり、欄を出る**（実機 B3: `1^\\^\\^\\/^\\^\\/^\\^\\`）", async () => {
    const fields = chain({ dupEnable: true });
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 0, 1);
    call(w, "dup");
    await nextTick();
    expect(values(w, fields)).toEqual(["1" + DUP.repeat(3), DUP.repeat(2), DUP.repeat(2)]);
    expect((w.emitted("field-full") as unknown[][])[0]).toEqual([1, false, true]); // 出た後の検査は掛ける（従来どおり）
  });

  it("**Dup: 2 区間目の途中から**（実機 B3b: `1234/5^\\/^\\^\\`）", async () => {
    const fields = chain({ dupEnable: true });
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 1, 1);
    call(w, "dup");
    await nextTick();
    expect(values(w, fields)).toEqual(["1234", "5" + DUP, DUP.repeat(2)]);
  });

  it("継続欄でない欄は、ほかの欄に触れない（退行防止）", async () => {
    const fields = [fld({ index: 1, col: 10, length: 6, value: "123456" }), fld({ index: 2, col: 24, length: 4, value: "9999" })];
    const w = mountGrid(fields);
    await nextTick();
    await place(w, 0, 2);
    call(w, "fieldExit");
    await nextTick();
    expect(values(w, fields)).toEqual(["12", "9999"]);
    expect((w.emitted("field-full") as unknown[][])[0]).toEqual([1, true, true]);
  });
});

describe("欄を出る行き先は継続欄の鎖の後ろ（EmulatorPane）", () => {
  const SID = "s1";
  /** 単独欄（前） / `9999/99/99` の 3 区間 / 単独欄（後） */
  const screen = (dup = false): Field[] => [
    fld({ index: 1, row: 3, col: 10, length: 5, numeric: false }),
    ...chain(dup ? { dupEnable: true } : {}).map((f, i) => ({ ...f, index: i + 2 })),
    fld({ index: 5, row: 7, col: 10, length: 5, numeric: false })
  ];
  function seed(fields: Field[]): void {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID, label: "t", snapshot: snapOf(fields), edits: new Map(),
      cursor: { row: 1, col: 1 }, link: { state: "connected" }, resumability: "resumable", readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
  }
  const mountPane = () => mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  const inputByIndex = (w: ReturnType<typeof mountPane>, index: number) =>
    w.element.querySelector(`input.grid-input[data-field-index="${index}"][data-slice="0"]`) as HTMLInputElement;
  const grid = (w: ReturnType<typeof mountPane>) => w.findComponent(ScreenGrid).vm as unknown as Record<string, () => void>;
  async function start(w: ReturnType<typeof mountPane>, index: number, caret = 0) {
    const el = inputByIndex(w, index);
    el.focus();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }));
    await nextTick();
  }

  beforeEach(() => document.body.replaceChildren());

  it.each([2, 3, 4])("**Field Exit: 区間 %i（先頭・中間・最終）から出ると、鎖の後ろの欄へ**（次の区間ではない。実機 B2・B4・B5・B6・B7）", async (idx) => {
    seed(screen());
    const w = mountPane();
    await nextTick();
    await start(w, idx);
    grid(w).fieldExit!();
    await nextTick();
    expect(document.activeElement).toBe(inputByIndex(w, 5));
    w.unmount();
  });

  it("**Field＋ も同じ**", async () => {
    seed(screen());
    const w = mountPane();
    await nextTick();
    await start(w, 3);
    grid(w).fieldPlus!();
    await nextTick();
    expect(document.activeElement).toBe(inputByIndex(w, 5));
    w.unmount();
  });

  it("**Dup も同じ**（実機 B3: DUP 可の継続欄で Dup → 後ろの欄）", async () => {
    seed(screen(true));
    const w = mountPane();
    await nextTick();
    await start(w, 2, 1);
    grid(w).dup!();
    await nextTick();
    expect(document.activeElement).toBe(inputByIndex(w, 5));
    w.unmount();
  });

  it("**鎖が画面の最後の欄なら、画面の最初の入力欄へ巡回**（実機 B2・B4・B5: D8U は最後の欄で、カーソルは最初の入力欄）", async () => {
    seed(screen().slice(0, 4));
    const w = mountPane();
    await nextTick();
    await start(w, 3);
    grid(w).fieldExit!();
    await nextTick();
    expect(document.activeElement).toBe(inputByIndex(w, 1));
    w.unmount();
  });

  it("継続欄でない欄からの Field Exit は、従来どおり次の欄（退行防止）", async () => {
    seed(screen());
    const w = mountPane();
    await nextTick();
    await start(w, 1);
    grid(w).fieldExit!();
    await nextTick();
    expect(document.activeElement, "次の欄＝鎖の先頭区間").toBe(inputByIndex(w, 2));
    w.unmount();
  });
});
