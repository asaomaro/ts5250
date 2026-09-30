import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { mandatoryFillViolated } from "../src/composables/mandatoryCheck.js";
import { SO_MARK, SI_MARK, DEAD_MARK, WIDE_NUL } from "../src/composables/fieldValidate.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **J・G・全角の E の全角 1 桁の空き（NUL の組）と、打った全角空白（中身）の区別**（`20260930-wide-nul`）。実機の ACS のコア（`scripts/acs-probe/space-typed.txt` の f0・f1・f5）:
 * J に `あ` と全角空白を打つと READ MDT は空きの NUL の組も `40 40` で見分けがつかないが、ALT は打った全角空白が `4040`・詰め物が `0000`（`0e 4481 4040 0000… 0f`）。
 * ここでは ScreenGrid が値（edits）と送る形（wire）へ、空きと全角空白を分けて出すことを見る
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

/** (5,10) に 12 桁の空の欄（書かなかった桁＝生バイトの無い空白）。J は SO を先頭に・SI を最後の桁に持つ */
function snapshot(dbcsType: "only" | "pure"): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  if (dbcsType === "only") {
    cells[4]![9] = cell(" ", "so");
    cells[4]![20] = cell(" ", "si");
  }
  const f = { index: 1, row: 5, col: 10, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", dbcsType } as unknown as Field;
  return { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 10 }, keyboardLocked: false, cells, fields: [f] } as unknown as ScreenSnapshot;
}

async function open(snap: ScreenSnapshot) {
  const edits = new Map<number, string>();
  const wires = new Map<number, string | undefined>();
  const w = mount(ScreenGrid, {
    props: {
      snapshot: snap, edits, focused: true, busy: false, cursor: { row: 5, col: 10 },
      onEdit: (i: number, v: string, meta?: { wire?: string }) => {
        edits.set(i, v);
        wires.set(i, meta?.wire);
      }
    },
    attachTo: document.body
  });
  mounted.push(w as never);
  await nextTick();
  const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  const at = async (caret: number) => {
    el.focus();
    await nextTick();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };
  const key = async (k: string) => {
    (document.activeElement as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await nextTick();
  };
  return { edits, wires, at, key, el };
}

describe("J の欄の打った全角空白と空き", () => {
  it("打った末尾の全角空白は中身として送る形に残り、詰め物は NUL の組（`SO あ 　 NUL×6 SI`）", async () => {
    const t = await open(snapshot("only"));
    await t.at(1);
    await t.key("あ");
    await t.key(" "); // J の Space は全角空白
    expect(t.edits.get(1)).toBe("あ　");
    expect(t.wires.get(1)).toBe(SO_MARK + "あ　" + DEAD_MARK.repeat(6) + SI_MARK);
  });

  it("先頭に打った全角空白だけでも中身（`SO 　 NUL×8 SI`）", async () => {
    const t = await open(snapshot("only"));
    await t.at(1);
    await t.key(" ");
    expect(t.wires.get(1)).toBe(SO_MARK + "　" + DEAD_MARK.repeat(8) + SI_MARK);
  });

  it("離れた桁に打つと、手前の書かなかった桁は NUL の組（全角空白として送らない）", async () => {
    const t = await open(snapshot("only"));
    await t.at(3);
    await t.key("い");
    expect(t.edits.get(1)).toBe("　　い"); // 画面の値は全角空白（G と同じ詰め方）
    expect(t.wires.get(1)).toBe(SO_MARK + DEAD_MARK.repeat(4) + "い" + DEAD_MARK.repeat(4) + SI_MARK);
  });
});

describe("ホストが書いた J の欄の空き（生バイトの無い桁）は全角 1 桁の空きとして読み戻る", () => {
  it("`あ`・書かなかった 1 桁・`い` の欄に続けて打つと、途中の空きは NUL の組のまま送る", async () => {
    const snap = snapshot("only");
    const r = snap.cells[4]!;
    // SO あ(10-11) 空き(12-13) い(14-15) … SI
    r[10] = cell("あ", "dbcs-lead");
    r[11] = cell("", "dbcs-tail");
    r[14] = cell("い", "dbcs-lead");
    r[15] = cell("", "dbcs-tail");
    const t = await open(snap);
    await t.at(4); // view: SO あ 空き い ← 4 は い の次
    await t.key("う");
    expect(t.wires.get(1)).toBe(SO_MARK + "あ" + DEAD_MARK.repeat(2) + "いう" + DEAD_MARK.repeat(2) + SI_MARK);
  });
});

describe("G の欄", () => {
  it("打った末尾の全角空白は残り、詰め物は値から落ちる", async () => {
    const t = await open(snapshot("pure"));
    await t.at(0);
    await t.key("あ");
    await t.key(" ");
    expect(t.edits.get(1)).toBe("あ　");
  });
});

describe("必須埋め: 全角 1 桁の空きがあれば満杯でない", () => {
  const mf = (dbcsType: "only" | "pure"): Field =>
    ({ index: 1, row: 5, col: 10, length: 6, protected: false, hidden: false, numeric: false, mdt: true, value: "", dbcsType, adjust: "mandatory-fill" }) as unknown as Field;
  it("空き（WIDE_NUL）があれば部分入力、打った全角空白は埋まっている", () => {
    const f = mf("pure");
    const check = (v: string): boolean => mandatoryFillViolated(f, new Map([[1, v]]));
    expect([check(`あ${WIDE_NUL}う`), check("あ　う")]).toEqual([true, false]);
  });
});
