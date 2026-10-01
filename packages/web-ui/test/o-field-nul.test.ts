import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { mandatoryFillViolated } from "../src/composables/mandatoryCheck.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import { o } from "./helpers/oMarks.js";

/**
 * **継続でない O 欄の空き（NUL）と空白**（`20260930-nul-typed-space`）。ACS は O 欄の空き（0x00）と空白（0x40）を区別し、末尾に打った空白も送る
 * （実機の ACS のコア `scripts/acs-probe/space-typed.txt`: O 欄に `A` と空白を打つと `c1 40`）。値の文字は U+0000＝空き、U+0020＝空白（中身）。
 * ここでは ScreenGrid の配線（打鍵が値へ空きと空白を分けて出す・ホストが書いた空白は中身）と、必須埋めの判定（空きがあれば満杯でない）を見る
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

/** (5,10) に O 欄 8 桁。`hostSpaces` の桁だけホストが書いた空白（生バイト 0x40。空きは生バイトを持たない） */
function snapshot(hostSpaces: number[] = [], dbcsType: "open" | "either" | undefined = "open", extra: Partial<Field> = {}): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  for (const c of hostSpaces) (cells[4]![9 + c] as Cell).rawByte = 0x40;
  const f = { index: 1, row: 5, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "", ...(dbcsType ? { dbcsType } : {}), ...extra } as unknown as Field;
  return { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 10 }, keyboardLocked: false, cells, fields: [f] } as unknown as ScreenSnapshot;
}

async function open(snap: ScreenSnapshot) {
  const edits = new Map<number, string>();
  const w = mount(ScreenGrid, {
    props: { snapshot: snap, edits, focused: true, busy: false, cursor: { row: 5, col: 10 }, onEdit: (i: number, v: string) => void edits.set(i, v) },
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
  return { edits, at, key };
}

describe("継続でない O 欄の値の空き（NUL）と空白", () => {
  it("打った末尾の空白は落とさない（`A` ＋空白 → `A `）。ACS は c1 40 で送る", async () => {
    const t = await open(snapshot());
    await t.at(0);
    await t.key("A");
    await t.key(" ");
    expect(t.edits.get(1)).toBe("A ");
  });

  it("手前の空きは NUL のまま（何も書かなかった桁を空白として送らない）", async () => {
    const t = await open(snapshot());
    await t.at(3);
    await t.key("B");
    expect(t.edits.get(1)).toBe("\u0000\u0000\u0000B");
  });

  it("ホストが書いた空白は中身、書かなかった桁は空き", async () => {
    const t = await open(snapshot([1]));
    await t.at(3);
    await t.key("B");
    expect(t.edits.get(1)).toBe("\u0000 \u0000B");
  });

  it("末尾の空きだけを値から落とす（`A` の後ろは何も付かない）", async () => {
    const t = await open(snapshot());
    await t.at(0);
    await t.key("A");
    expect(t.edits.get(1)).toBe("A");
  });

  it("全角の後ろに打った空白も残る（`SO あ SI` ＋空白）", async () => {
    const t = await open(snapshot());
    await t.at(0);
    (document.activeElement as HTMLInputElement).dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    const el = document.activeElement as HTMLInputElement;
    el.value = "あ";
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
    await t.key(" ");
    expect(t.edits.get(1)).toBe(o("{あ}") + " ");
  });
});

describe("半角の状態の E 欄の空き（NUL）と空白（`20260930-either-half-space`。実機の ACS: E に `A`＋空白を打つと `c1 40`）", () => {
  it("打った末尾の空白は落とさない", async () => {
    const t = await open(snapshot([], "either"));
    await t.at(0);
    await t.key("A");
    await t.key(" ");
    expect(t.edits.get(1)).toBe("A ");
  });
  it("手前の空きは NUL のまま・末尾の空きは値から落とす", async () => {
    const t = await open(snapshot([], "either"));
    await t.at(2);
    await t.key("B");
    expect(t.edits.get(1)).toBe("\u0000\u0000B");
  });
  it("End は末尾の空きの上に止まらず、中身の直後へ行く（続けて打つと中身の後ろに付く）", async () => {
    const t = await open(snapshot([], "either"));
    await t.at(0);
    await t.key("A");
    await t.key("Home");
    await t.key("End");
    await t.key("B");
    expect(t.edits.get(1)).toBe("AB");
  });
  it("挿入モードは末尾の空きを押し出して入る（`ABC` の先頭へ `X` → `XABC`）", async () => {
    const t = await open(snapshot([], "either"));
    await t.at(0);
    for (const ch of "ABC") await t.key(ch);
    await t.at(0);
    await t.key("Insert");
    await t.key("X");
    expect(t.edits.get(1)).toBe("XABC");
  });
  it("必須埋め: 空きがあれば満杯でない・打った空白は埋まっている", () => {
    const f = { index: 1, row: 5, col: 10, length: 4, protected: false, hidden: false, numeric: false, mdt: true, value: "", dbcsType: "either", adjust: "mandatory-fill" } as unknown as Field;
    const check = (v: string): boolean => mandatoryFillViolated(f, new Map([[1, v]]));
    expect([check("A\u0000CD"), check("ABC "), check("ABC")]).toEqual([true, false, true]);
  });
});

describe("通常の文字欄の空き（NUL）と空白（`20260930-sbcs-nul`。実機の ACS: 通常の欄に `A`＋空白を打つと `c1 40`）", () => {
  it("打った末尾の空白は落とさない", async () => {
    const t = await open(snapshot([], undefined));
    await t.at(0);
    await t.key("A");
    await t.key(" ");
    expect(t.edits.get(1)).toBe("A ");
  });
  it("手前の書かなかった桁は NUL のまま・末尾の空きは値から落とす", async () => {
    const t = await open(snapshot([], undefined));
    await t.at(2);
    await t.key("B");
    expect(t.edits.get(1)).toBe("\u0000\u0000B");
  });
});

describe("O 欄の編集が残す桁は空き（NUL）", () => {
  /** (5,10) の 8 桁に host が `ABC` を書いた欄（文字は生バイトを持つ） */
  function withText(text: string): ScreenSnapshot {
    const snap = snapshot();
    [...text].forEach((ch, i) => {
      const c = (snap.cells[4]![9 + i] = cell(ch));
      c.rawByte = ch === " " ? 0x40 : 0xc1;
    });
    return snap;
  }

  it("Delete で詰めた後ろは空きになる（空白なら末尾の空白として送られてしまう）", async () => {
    const t = await open(withText("ABC"));
    await t.at(0);
    await t.key("Delete");
    expect(t.edits.get(1)).toBe("BC");
  });

  it("選択を消して SO/SI が崩れた並びの組み直しも、詰め物は空き", async () => {
    const snap = snapshot();
    const r = snap.cells[4]!;
    r[9] = cell(" ", "so");
    r[10] = cell("あ", "dbcs-lead");
    r[11] = cell("", "dbcs-tail");
    r[12] = cell("い", "dbcs-lead");
    r[13] = cell("", "dbcs-tail");
    r[14] = cell(" ", "si");
    const t = await open(snap);
    await t.at(0);
    const el = document.activeElement as HTMLInputElement;
    el.setSelectionRange(0, 2); // 列ビュー: SO あ い SI → SO と あ を選ぶ（並びが崩れる）
    await t.key("Backspace");
    expect(t.edits.get(1)).toBe(o("{い}"));
  });
});

describe("O 欄の必須埋め（MF）は空きがあれば満杯でない", () => {
  const mf = (length: number): Field => ({ index: 1, row: 5, col: 10, length, protected: false, hidden: false, numeric: false, mdt: true, value: "", dbcsType: "open", adjust: "mandatory-fill" }) as unknown as Field;
  const check = (f: Field, value: string): boolean => mandatoryFillViolated(f, new Map([[f.index, value]]));

  it("桁を全部字で埋めれば満杯（違反でない）", () => {
    expect(check(mf(4), "ABCD")).toBe(false);
  });
  it("途中に空き（NUL）があれば、長さが欄長でも満杯でない（部分入力）", () => {
    expect(check(mf(4), "A\u0000CD")).toBe(true);
  });
  it("打った空白は埋まっている（ACS `isFieldFull` は NUL の有無だけを見る）", () => {
    expect(check(mf(4), "ABC ")).toBe(false);
  });
  it("末尾に空きが残れば部分入力", () => {
    expect(check(mf(4), "ABC")).toBe(true);
  });
});
