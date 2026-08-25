import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { fieldSign, dupFill, DUP_BYTE, type EditState } from "../src/composables/fieldEdit.js";
import { MSG_DUP_DISALLOWED } from "../src/composables/opMessages.js";
import { rawSentinel, isRawSentinel, sentinelByte } from "@ts5250/tn5250/browser";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **負値入力（Field− / Field+）と Dup。**
 *
 * 実機の符号付き数値欄はワイヤ上 `桁数 + 1` バイトで、最終桁が符号桁。
 * 送信変換は core（`read-response.ts`）が行い、ここは**符号桁に何を置くか**だけを見る。
 *
 * 【実機で分かった不具合】`-12` と打つと**そのまま送れてしまい、ホストは `12` を受け取る**
 * （実機実測。エラーも出ない）。数値欄の `-` / `+` を Field− / Field+ へ横流しすることで、
 * 「打った通りに送れない形」を打てなくする。
 */

const COLS = 80;
const state = (chars: string, cursor: number): EditState =>
  ({ chars: [...chars], cursor, insertMode: false }) as EditState;

describe("Field− / Field+（純ロジック）", () => {
  const signed = { signedNumeric: true } as const;

  it("符号付き数値欄: 右寄せしてから最終桁へ `-` を置く", () => {
    // 欄長 7（6 桁＋符号桁）。"12" → 右寄せ（符号桁は動かさない）→ "    12" ＋ 符号桁
    const r = fieldSign(state("12     ", 2), signed, true);
    expect(r.chars.join("")).toBe("    12-");
  });

  it("Field+ は符号桁を空白にする", () => {
    expect(fieldSign(state("12     ", 2), signed, false).chars.join("")).toBe("    12 ");
  });

  it("既に `-` の欄で Field+ を押すと正に戻る", () => {
    expect(fieldSign(state("    12-", 7), signed, false).chars.join("")).toBe("    12 ");
  });

  it("カーソル以降は消える（Field Exit と同じ①）", () => {
    expect(fieldSign(state("123456 ", 2), signed, true).chars.join("")).toBe("    12-");
  });

  it("**符号付きでない欄では符号を置かない**（Field Exit と同じ）", () => {
    // 実機の数値入力欄はすべて signed-num で、num-only の符号処理は確かめられない。
    // 確かめられないものを実装しない側へ倒した（decisions）
    const r = fieldSign(state("12    ", 2), { adjust: "right-zero" }, true);
    expect(r.chars.join("")).toBe("000012");
  });

  it("指定の無い欄は消去だけ（右寄せも符号も無し）", () => {
    expect(fieldSign(state("123456", 2), {}, true).chars.join("")).toBe("12    ");
  });
});

describe("Dup（純ロジック）", () => {
  it("カーソルから欄末尾までを複写文字で埋める", () => {
    const d = rawSentinel(DUP_BYTE);
    const r = dupFill(state("AB    ", 2), d);
    expect(r.chars.join("")).toBe("AB" + d.repeat(4));
    expect(r.cursor).toBe(6);
  });

  it("カーソルが先頭なら全桁が複写文字になる", () => {
    const d = rawSentinel(DUP_BYTE);
    expect(dupFill(state("ABCDEF", 0), d).chars.join("")).toBe(d.repeat(6));
  });

  it("複写文字は 0x1C を運ぶセンチネル", () => {
    expect(DUP_BYTE).toBe(0x1c);
    // **基点は決め打ちしない**（外字と衝突するので第 15 面へ移した）。
    // 見るのは「生バイト 0x1C を運ぶセンチネルである」ことだけ。
    expect(isRawSentinel(rawSentinel(DUP_BYTE))).toBe(true);
    expect(sentinelByte(rawSentinel(DUP_BYTE))).toBe(0x1c);
  });
});

// ---------------------------------------------------------------------------
// ScreenGrid（打鍵とキー）
// ---------------------------------------------------------------------------

function cell(char = " "): Cell {
  return { char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false } as Cell;
}
function fld(over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field {
  return { protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over } as Field;
}
function snapOf(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  for (const f of fields) [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
  return { sessionId: "s", rows: 24, cols: COLS, cursor: { row: 5, col: 10 },
    keyboardLocked: false, cells, fields } as unknown as ScreenSnapshot;
}

describe("ScreenGrid: 数値欄の `-` / `+` は Field− / Field+ へ横流しされる", () => {
  beforeEach(() => document.body.replaceChildren());

  function mountGrid(fields: Field[]) {
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 } },
      attachTo: document.body
    });
  }
  const firstInput = (w: ReturnType<typeof mountGrid>) =>
    w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  async function type(el: HTMLInputElement, s: string) {
    for (const ch of s) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      await nextTick();
    }
  }
  const lastEdit = (w: ReturnType<typeof mountGrid>) => {
    const e = w.emitted("edit") as unknown[][] | undefined;
    return e ? (e[e.length - 1]![1] as string) : undefined;
  };

  it("符号付き数値欄で `-` を打つと**文字として入らず**符号桁が `-` になる", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "12-");
    // "-12" ではなく "    12-"（送信時に core が符号桁を落としてゾーンを D にする）
    expect(lastEdit(w)).toBe("    12-");
    w.unmount();
  });

  it("`+` では符号桁が空白のまま（値は右寄せされる）", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "12+");
    expect(lastEdit(w)).toBe("    12"); // 末尾空白は emit 時に落ちる
    w.unmount();
  });

  it("**非数値欄では `-` は普通の文字**（横流ししない・回帰）", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 7 })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "A-B");
    expect(lastEdit(w)).toBe("A-B");
    w.unmount();
  });

  it("符号確定のあとは次の欄へ送る（field-full）", async () => {
    const w = mountGrid([
      fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true }),
      fld({ index: 2, row: 6, col: 10, length: 7, numeric: true, signedNumeric: true })
    ]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "12-");
    expect(w.emitted("field-full")).toBeTruthy();
    w.unmount();
  });

  it("AUTO_ENTER 欄では符号確定のあと Enter を送る", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true, autoEnter: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, "12-");
    expect(w.emitted("aid")).toEqual([["Enter"]]);
    w.unmount();
  });
});

describe("ScreenGrid: Dup キー", () => {
  beforeEach(() => document.body.replaceChildren());

  function mountGrid(fields: Field[]) {
    return mount(ScreenGrid, {
      props: { snapshot: snapOf(fields), edits: new Map(), focused: true, busy: false, cursor: { row: 5, col: 10 } },
      attachTo: document.body
    });
  }
  const firstInput = (w: ReturnType<typeof mountGrid>) =>
    w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;

  it("DUP_ENABLE の欄ではカーソル以降が複写文字で埋まる", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 4, dupEnable: true })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    (w.vm as unknown as { dup: () => void }).dup();
    await nextTick();
    const e = w.emitted("edit") as unknown[][];
    expect(e[e.length - 1]![1]).toBe(rawSentinel(DUP_BYTE).repeat(4));
    w.unmount();
  });

  it("**DUP_ENABLE でない欄では何も変えずメッセージ**", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 4, value: "AB" })]);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    (w.vm as unknown as { dup: () => void }).dup();
    await nextTick();
    expect(w.emitted("edit")).toBeUndefined();
    expect((w.emitted("notice") as unknown[][])?.[0]?.[0]).toBe(MSG_DUP_DISALLOWED);
    w.unmount();
  });

  it("Dup のあとは次の欄へ送る", async () => {
    const w = mountGrid([
      fld({ index: 1, row: 5, col: 10, length: 4, dupEnable: true }),
      fld({ index: 2, row: 6, col: 10, length: 4 })
    ]);
    await nextTick();
    firstInput(w).focus();
    (w.vm as unknown as { dup: () => void }).dup();
    await nextTick();
    expect(w.emitted("field-full")).toBeTruthy();
    w.unmount();
  });

  it("FER 欄では Dup のあとも欄に留まる", async () => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 4, dupEnable: true, fieldExitRequired: true })]);
    await nextTick();
    firstInput(w).focus();
    (w.vm as unknown as { dup: () => void }).dup();
    await nextTick();
    expect(w.emitted("field-full")).toBeUndefined();
    w.unmount();
  });
});
