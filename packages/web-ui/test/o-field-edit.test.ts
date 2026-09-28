import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { MSG_NO_ROOM, MSG_PROTECTED, MSG_SHIFT_POSITION, isOperatorError } from "../src/composables/opMessages.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import { o } from "./helpers/oMarks.js";

/**
 * **O 欄の編集を画面の操作で確かめる**（`20260928-o-field-cells`）。規則は `composables/oFieldCells.ts`（ACS の表。実機の ACS のコアで 24 通りを測った
 * `scripts/acs-probe/o-field-edit.txt`）。ここでは ScreenGrid の配線——打鍵・Insert・Delete・Backspace・Field Exit がその規則へ回り、止まった理由が
 * 操作員メッセージになり、値もカーソルも変えないこと——を見る。欄は (5,20) から 12 桁の O 欄。期待値はセルの記法（`{`＝SO・`}`＝SI）
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

/**
 * O 欄（5,20 から 12 桁）。`parts` を欄の先頭から置く——文字列は半角の並び、配列は全角の並び（前後に SO・SI の桁を置く）。
 * 例: `["A", ["あ", "い", "う"], "B"]` → `A`・SO・`あいう`・SI・`B`（10 桁）
 */
function openSnapshot(parts: (string | string[])[], opts: { continued?: boolean; type?: "open" | "only" } = {}): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const r = cells[4]!;
  let c = 19;
  let value = "";
  for (const p of parts) {
    if (typeof p === "string") {
      for (const ch of p) r[c++] = cell(ch);
      value += p;
    } else {
      r[c++] = cell(" ", "so");
      for (const ch of p) {
        r[c++] = cell(ch, "dbcs-lead");
        r[c++] = cell("", "dbcs-tail");
      }
      r[c++] = cell(" ", "si");
      value += p.join("");
    }
  }
  const field = {
    index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value, dbcsType: opts.type ?? "open",
    ...(opts.continued ? { continued: "first" } : {})
  } as Field;
  // 継続欄は区間の並び（first … last）で成り立つので、次の欄を last にする（`ContinuedPart`。`packages/tn5250/src/screen/types.ts:45`）
  const next = {
    index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "",
    ...(opts.continued ? { continued: "last", dbcsType: "open" } : {})
  } as Field;
  return { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [field, next] } as unknown as ScreenSnapshot;
}

async function open(snapshot: ScreenSnapshot) {
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
  const key = async (k: string) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await nextTick();
  };
  // 入力欄の桁（view の添字）。O 欄の view は SO・SI の印を 1 桁ずつ含む
  const at = async (caret: number) => {
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };
  const select = async (from: number, to: number) => {
    el.setSelectionRange(from, to);
    await nextTick();
  };
  const insert = async (caret: number, ch: string) => {
    await at(caret);
    await key("Insert");
    await key(ch);
  };
  const paste = async (text: string) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => text };
    el.dispatchEvent(ev);
    await nextTick();
  };
  const compose = async (text: string) => {
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    const at = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, at) + text + el.value.slice(el.selectionEnd ?? at); // 確定した字を合成開始桁に差し込む
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
  };
  const pasteAt = (r: number, c: number, t: string): void => (w.vm as unknown as { pasteAt: (r: number, c: number, t: string) => void }).pasteAt(r, c, t);
  return { key, at, select, insert, paste, compose, pasteAt, value: () => edits.get(1), notices: () => ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0]) };
}

// view の添字: A=0・SO=1・あ=2・い=3・う=4・SI=5・B=6

describe("O 欄の打鍵（ScreenGrid）", () => {
  it("**(i) 並びの直後の半角へ全角を挿入 → 別の並び**（ACS の実測 O2-2 と同じ）", async () => {
    const { insert, value } = await open(openSnapshot([["あ"], "B"]));
    await insert(3, "い"); // view: SO あ SI B → B は 3
    expect(value()).toBe(o("{あ}{い}B"));
  });

  it("**(ii) 並びの最初の全角へ半角を挿入 → 空の SO/SI**（O2-3）", async () => {
    const { insert, value } = await open(openSnapshot([["あ", "い"]]));
    await insert(1, "X");
    expect(value()).toBe(o("{}X{あい}"));
  });

  it("**全角を Delete しても空の SO/SI が残る**（O3-1）", async () => {
    const { at, key, value } = await open(openSnapshot([["あ"]]));
    await at(1);
    await key("Delete");
    expect(value()).toBe(o("{}"));
  });

  it("**単独の SO で Delete → 0065・値は変わらない**（O3-2）", async () => {
    const { at, key, value, notices } = await open(openSnapshot([["あ"]]));
    await at(0);
    await key("Delete");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_SHIFT_POSITION);
    expect(isOperatorError(MSG_SHIFT_POSITION)).toBe(true); // エラー状態に入る（挿入モードも解く）
  });

  it("**単独の SI の直後で Backspace → 0065**（O3-3）", async () => {
    const { at, key, value, notices } = await open(openSnapshot([["あ"], "X"]));
    await at(3); // X の上（view: SO あ SI X）
    await key("Backspace");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_SHIFT_POSITION);
  });

  it("**11 桁目への全角の上書きは 0005**（O1-7）", async () => {
    const { at, key, value, notices } = await open(openSnapshot(["ABCDEFGHIJK"]));
    await at(10);
    await key("あ");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_PROTECTED);
  });

  it("**満杯の欄への挿入は 0012**（O2-7）", async () => {
    const { insert, value, notices } = await open(openSnapshot(["ABCDEFGHIJKL"]));
    await insert(1, "X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**ホストが書いた空の SO/SI をそのまま持つ**（セルから印を拾う。SO で Delete すると組が消える）", async () => {
    const { at, key, value } = await open(openSnapshot(["A", [], "B"]));
    await at(1);
    await key("Delete");
    expect(value()).toBe("AB");
  });

  it("**選択の削除で崩れた並びは組み直す**（SO と全角を選んで消すと、残った SI は外れる）", async () => {
    const { select, key, value } = await open(openSnapshot([["あ"], "B"]));
    await select(0, 2);
    await key("Delete");
    expect(value()).toBe("B");
  });

  it("**フォーカスしていない欄への貼り付けも 1 字ずつの打鍵**（ACS `pasteRect`。B の桁へ全角 → SO 字 SI）", async () => {
    const { value, pasteAt } = await open(openSnapshot(["AB"]));
    pasteAt(5, 21, "あ");
    await nextTick();
    expect(value()).toBe(o("A{あ}"));
  });

  it("**貼り付けで後ろの字の桁は動かない**（全角を潰して半角を貼る——ACS の表で 1 字ずつ。組み直しだと SO/SI の分ずれた）", async () => {
    const { value, pasteAt } = await open(openSnapshot([["あ"], "CD"]));
    pasteAt(5, 20, "XY");
    await nextTick();
    // X は SO の上（O、次が全角 → X 空白 SO）、Y は空白の上 → XY{}CD（C・D は元の桁 4・5 のまま）
    expect(value()).toBe(o("XY{}CD"));
  });

  it("**挿入の貼り付けも 1 字ずつ**（並びの直後の半角の桁へ全角 → 別の並び。ACS の挿入の表 (i)）", async () => {
    const { key, at, value, pasteAt } = await open(openSnapshot([["あ"], "B"]));
    await at(0);
    await key("Insert");
    pasteAt(5, 24, "い");
    await nextTick();
    expect(value()).toBe(o("{あ}{い}B"));
  });

  it("**挿入の貼り付けは 1 字でも止まれば何も貼らない**（0012）", async () => {
    const { key, at, value, notices, pasteAt } = await open(openSnapshot(["ABCDEFGHIJK"]));
    await at(0);
    await key("Insert");
    pasteAt(5, 20, "XY");
    await nextTick();
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**SI の上に全角を上書き → 並びが延びる**（O1-2。カーソルは次の SI の上）", async () => {
    const { at, key, value } = await open(openSnapshot([["あ"]]));
    await at(2);
    await key("い");
    await key("う");
    expect(value()).toBe(o("{あいう}"));
  });
});
