import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { MSG_NO_ROOM, MSG_PROTECTED } from "../src/composables/opMessages.js";
import { DEAD_MARK } from "../src/composables/fieldValidate.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import { o } from "./helpers/oMarks.js";

/**
 * **継続した O 欄の編集を画面の操作で確かめる**（`20260928-cont-o-cells`）。規則は `composables/oChainCells.ts`（ACS の手順。実機の ACS のコアの
 * CONTOX・`scripts/acs-probe/cont-o-edit.txt`）。ここでは ScreenGrid の配線——打鍵・Insert・Delete・Backspace が鎖の操作へ回り、ほかの区間の値が
 * 出て、カーソルの着いた区間へフォーカスが移ること——を見る。鎖は (5,10)・(6,10)・(7,10) の 8 桁ずつ。先頭 `SO い え SI X`・中間 `YZ`・最終 空き
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;
const D = DEAD_MARK;

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});

function chainSnapshot(): ScreenSnapshot {
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
    sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 10 }, keyboardLocked: false, cells,
    fields: [seg(1, 5, "first", "いえX"), seg(2, 6, "middle", "YZ"), seg(3, 7, "last", "")]
  } as unknown as ScreenSnapshot;
}

/** ホストが区間をまたぐ並びを書いた鎖（先頭 `SO い え` の後ろに SI が無く、中間の頭が後半の続き——`SO い え`・`お SI`） */
function straddleSnapshot(): ScreenSnapshot {
  const snap = chainSnapshot();
  const r5 = snap.cells[4]!;
  r5[14] = cell("お", "dbcs-lead");
  r5[15] = cell("", "dbcs-tail");
  snap.cells[5]![9] = cell("か", "dbcs-lead");
  snap.cells[5]![10] = cell("", "dbcs-tail");
  snap.cells[5]![11] = cell(" ", "si");
  return snap;
}

async function open(snapshot: ScreenSnapshot = chainSnapshot()) {
  const edits = new Map<number, string>();
  const notices: string[] = [];
  const w = mount(ScreenGrid, {
    props: {
      snapshot, edits, focused: true, busy: false, cursor: { row: 5, col: 10 },
      onEdit: (i: number, v: string) => void edits.set(i, v),
      onNotice: (m: string) => void notices.push(m)
    },
    attachTo: document.body
  });
  mounted.push(w as never);
  await nextTick();
  const inputs = [...w.element.querySelectorAll("input.grid-input:not([readonly])")] as HTMLInputElement[];
  const active = (): HTMLInputElement => document.activeElement as HTMLInputElement;
  /** 区間 seg の view の caret へ置く（view は SO・SI の印を 1 桁ずつ、全角を 1 字で持つ） */
  const at = async (seg: number, caret: number) => {
    const el = inputs[seg]!;
    el.focus();
    await nextTick();
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };
  const key = async (k: string) => {
    active().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await nextTick();
  };
  /** IME の確定（合成の始め → 確定した字を差し込む → 合成の終わり） */
  const compose = async (text: string) => {
    const el = active();
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    const p = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, p) + text + el.value.slice(el.selectionEnd ?? p);
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
  };
  const fieldFull = (): number[] => ((w.emitted("field-full") as unknown[][] | undefined) ?? []).map((a) => a[0] as number);
  return { edits, notices, inputs, active, at, key, compose, fieldFull };
}

describe("継続した O 欄の打鍵（ScreenGrid）", () => {
  it("C01: SI の上に全角を挿入 → 先頭の区間が埋まり X が中間へ。フォーカスは中間の区間へ", async () => {
    const t = await open();
    await t.at(0, 3); // SI
    await t.key("Insert");
    await t.key("う");
    expect(t.edits.get(1)).toBe(o("{いえう}"));
    expect(t.edits.get(2)).toBe("X YZ");
    expect(t.edits.has(3)).toBe(false);
    expect(t.active()).toBe(t.inputs[1]);
    expect(t.active().selectionStart).toBe(0);
  });

  it("C02: 並びの直後の X に全角を挿入 → 並びごと中間へ送り、先頭の区間の残りは死んだ桁", async () => {
    const t = await open();
    await t.at(0, 4); // X
    await t.key("Insert");
    await t.key("え");
    expect(t.edits.get(1)).toBe(o("{いえ}") + D + D);
    expect(t.edits.get(2)).toBe(o("{え}X YZ"));
    expect(t.active()).toBe(t.inputs[1]);
    expect(t.active().selectionStart).toBe(2); // 中間の SI の上（view は SO・え・SI——全角は 1 字）
  });

  it("C05: X に全角を上書き → X の後ろを死んだ桁にして中間の頭へ", async () => {
    const t = await open();
    await t.at(0, 4);
    await t.key("か");
    expect(t.edits.get(1)).toBe(o("{いえ}X") + D);
    expect(t.edits.get(2)).toBe(o("{か}"));
  });

  it("C06: 全角で Delete → 鎖全体が 2 桁詰まる", async () => {
    const t = await open();
    await t.at(0, 1); // い
    await t.key("Delete");
    expect(t.edits.get(1)).toBe(o("{え}X YZ"));
    expect(t.edits.get(2)).toBe("");
  });

  it("C07: 中間の頭で Backspace → 前の区間の最後の桁を消す。フォーカスは先頭の区間へ", async () => {
    const t = await open();
    await t.at(1, 0);
    await t.key("Backspace");
    expect(t.edits.get(1)).toBe(o("{いえ}XY"));
    expect(t.edits.get(2)).toBe("Z");
    expect(t.active()).toBe(t.inputs[0]);
  });

  it("C12: IME で 2 字を確定 → 1 字ずつ鎖の挿入（2 字目で え が中間へ押し出され、先頭の区間の最後の SI・中間の SO）", async () => {
    const t = await open();
    await t.at(0, 2); // え
    await t.key("Insert");
    await t.compose("きく");
    expect(t.edits.get(1)).toBe(o("{いきく}"));
    expect(t.edits.get(2)).toBe(o("{え}X YZ"));
    expect(t.active()).toBe(t.inputs[1]);
    expect(t.active().selectionStart).toBe(0);
  });

  it("C11: IME の確定を上書きで（SO の上の全角は上書きの表——SO の直後に置き、X の後ろの桁を食わない）", async () => {
    const t = await open();
    await t.at(0, 0);
    await t.compose("き");
    // 上書きの表: SO の上・次が並びの中の全角 → SO＋字（い を上書き）
    expect(t.edits.get(1)).toBe(o("{きえ}X"));
  });

  it("選択して Delete は選択だけを消す（1 回だけ。鎖の Delete は重ねない）", async () => {
    const t = await open();
    await t.at(0, 1);
    t.active().setSelectionRange(1, 2); // い
    await t.key("Delete");
    expect(t.edits.get(1)).toBe(o("{え}X"));
    expect(t.edits.has(2)).toBe(false);
  });

  it("上書きで鎖の終わりに着いたら、IME の確定の余りで止まらず次の欄へ送る", async () => {
    const t = await open();
    await t.at(2, 0);
    await t.compose("ABCDEFGHIJ");
    expect(t.edits.get(3)).toBe("ABCDEFGH");
    expect(t.fieldFull()).toContain(3);
    // 満杯の鎖の終わりから確定しても（1 字も置けない）次の欄へ送る
    const before = t.fieldFull().length;
    await t.at(2, 8);
    await t.compose("XY");
    expect(t.fieldFull().length).toBe(before + 1);
    expect(t.edits.get(3)).toBe("ABCDEFGH");
  });

  it("カーソルを動かすだけでは組み直さない（区間をまたぐ並びをホストが書いた鎖に、打っていないのに MDT を立てない）", async () => {
    const t = await open(straddleSnapshot());
    await t.at(0, 1);
    await t.key("ArrowRight");
    await t.key("ArrowLeft");
    expect(t.edits.size).toBe(0);
  });

  it("鎖の頭の Backspace は 0005、収まらない挿入は 0012（値は変えない）", async () => {
    const t = await open();
    await t.at(0, 0);
    await t.key("Backspace");
    expect(t.notices).toEqual([MSG_PROTECTED]);
    // 半角で鎖を埋める: 先頭 X の後ろと中間・最終の残り（2＋6＋8 桁）
    await t.at(1, 2);
    await t.key("Insert");
    for (const ch of "ABCDEF") await t.key(ch);
    for (const ch of "GHIJKLMN") await t.key(ch);
    await t.at(0, 5);
    await t.key("P");
    await t.key("Q");
    t.notices.length = 0;
    const before = [t.edits.get(1), t.edits.get(2), t.edits.get(3)];
    await t.at(0, 4);
    await t.key("R");
    expect(t.notices).toEqual([MSG_NO_ROOM]);
    expect([t.edits.get(1), t.edits.get(2), t.edits.get(3)]).toEqual(before);
  });
});
