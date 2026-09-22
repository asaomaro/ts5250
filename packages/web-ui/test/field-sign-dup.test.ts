import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { fieldSign, dupFill, DUP_BYTE, type EditState } from "../src/composables/fieldEdit.js";
import { MSG_DUP_DISALLOWED, MSG_FIELD_MINUS_INVALID } from "../src/composables/opMessages.js";
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

  it("**符号付き＋RZ は '0' 埋め・符号付き＋RB は空白埋め**（実機の ACS のコア: `CHECK(RZ) 6 0` に `12` → Field− は `000012-`。`20260921-signed-rz-fill`）", () => {
    expect(fieldSign(state("12     ", 2), { signedNumeric: true, adjust: "right-zero" }, true).chars.join("")).toBe("000012-");
    expect(fieldSign(state("12     ", 2), { signedNumeric: true, adjust: "right-zero" }, false).chars.join("")).toBe("000012 ");
    expect(fieldSign(state("12     ", 2), { signedNumeric: true, adjust: "right-blank" }, true).chars.join("")).toBe("    12-");
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

  it("**符号付きでも数値専用でもない欄では符号を置かない**（Field Exit と同じ）", () => {
    // ~~実機の数値入力欄はすべて signed-num で、num-only の符号処理は確かめられない~~ → DDS のシフト M の欄で ACS のコアを測った
    // （`20260921-field-minus-zone-d`。下の「数値専用の欄」）
    const r = fieldSign(state("12    ", 2), { adjust: "right-zero" }, true);
    expect(r.chars.join("")).toBe("000012");
  });

  // `20260921-field-minus-zone-d`: ACS `processFieldPlusMinusAndExit` は数値専用の欄の Field− で最終桁のバイトのゾーンを D にする。
  // 実機の ACS のコア（社内機・FFWPGM のシフト M の欄）: `12` → `12   }`・`5` → `5    }`（最終桁が空でも 0xD0）
  it("**数値専用の欄の Field− は最終桁のゾーンを D にする**（空なら 0xD0＝`}`、数字なら 0xDn）", () => {
    const empty = fieldSign(state("12    ", 2), { numericOnly: true }, true);
    expect(empty.chars.slice(0, 5).join("")).toBe("12   ");
    expect(isRawSentinel(empty.chars[5]!) && sentinelByte(empty.chars[5]!)).toBe(0xd0);
    const digit = fieldSign(state("000125", 6), { adjust: "right-zero", numericOnly: true }, true);
    expect(sentinelByte(digit.chars[5]!)).toBe(0xd5);
    expect(fieldSign(state("12    ", 2), { numericOnly: true }, false).chars.join(""), "Field+ は変えない").toBe("12    ");
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

/**
 * ~~**数値欄の `-` / `+` は Field− / Field+ へ横流しされる**~~ → 撤去した（`20260921-numpad-field-sign`）。
 * ACS はメイン行の `-` `+` を文字として扱い（符号付き数値欄ではエラー 0016）、Field− / Field+ はテンキーの − / ＋
 * （`AcsMapFunctions.MAP_5250` の `B109` / `B107`）。Field− は符号付き数値・数値専用の欄でだけ（他はエラー 0022）。
 * 実機の ACS のコア（`scripts/acs-probe/field-minus-keys.txt`）: 英数字欄で Field− → エラー・値もカーソルもそのまま、
 * Field+ → 次の欄へ、6S0 で `12-` → `-` でエラー、Field− → `    12-`。
 * ここでは ScreenGrid の公開メソッド（ペインの `local:field-minus` / `field-plus` が呼ぶもの）で押す。
 */
describe("ScreenGrid: Field− / Field+", () => {
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
  const notices = (w: ReturnType<typeof mountGrid>) =>
    ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0] as string);
  type Keys = { fieldMinus: () => void; fieldPlus: () => void };
  async function typed(fields: Field[], text: string) {
    const w = mountGrid(fields);
    await nextTick();
    const el = firstInput(w);
    el.focus();
    el.setSelectionRange(0, 0);
    await type(el, text);
    return { w, keys: w.vm as unknown as Keys };
  }
  const signed = (over: Partial<Field> = {}) =>
    fld({ index: 1, row: 5, col: 10, length: 7, numeric: true, signedNumeric: true, ...over });

  it("符号付き数値欄: Field− で右寄せして符号桁が `-`（F4: `    12-`）", async () => {
    const { w, keys } = await typed([signed()], "12");
    keys.fieldMinus();
    await nextTick();
    expect(lastEdit(w)).toBe("    12-");
    w.unmount();
  });

  it("Field+ では符号桁が空白のまま（値は右寄せされる）", async () => {
    const { w, keys } = await typed([signed()], "12");
    keys.fieldPlus();
    await nextTick();
    expect(lastEdit(w)).toBe("    12"); // 末尾空白は emit 時に落ちる
    w.unmount();
  });

  it("**数値専用の欄（シフト M / Y）で Field− → 最終桁が 0xD0 の生バイト**（ACS のコアと同じ）", async () => {
    const { w, keys } = await typed([fld({ index: 1, row: 5, col: 10, length: 6, numeric: true })], "12");
    keys.fieldMinus();
    await nextTick();
    const v = lastEdit(w)!;
    expect(v.slice(0, 2)).toBe("12");
    expect(sentinelByte([...v].at(-1)!)).toBe(0xd0);
    w.unmount();
  });

  it("**非数値欄では `-` は普通の文字**（回帰）", async () => {
    const { w } = await typed([fld({ index: 1, row: 5, col: 10, length: 7 })], "A-B");
    expect(lastEdit(w)).toBe("A-B");
    w.unmount();
  });

  it("符号確定のあとは次の欄へ送る（field-full）", async () => {
    const { w, keys } = await typed([signed(), signed({ index: 2, row: 6 })], "12");
    keys.fieldMinus();
    await nextTick();
    expect(w.emitted("field-full")).toBeTruthy();
    w.unmount();
  });

  it("AUTO_ENTER 欄では符号確定のあと Enter を送る", async () => {
    const { w, keys } = await typed([signed({ autoEnter: true })], "12");
    keys.fieldMinus();
    await nextTick();
    expect(w.emitted("aid")).toEqual([["Enter"]]);
    w.unmount();
  });

  it("**英数字欄で Field− はエラー 0022、値もカーソルもそのまま**（F1）", async () => {
    const { w, keys } = await typed([fld({ index: 1, row: 5, col: 10, length: 6 }), fld({ index: 2, row: 6, col: 10, length: 6 })], "AB");
    keys.fieldMinus();
    await nextTick();
    expect(notices(w)).toContain(MSG_FIELD_MINUS_INVALID);
    expect(lastEdit(w)).toBe("AB");
    expect(w.emitted("field-full")).toBeUndefined();
    w.unmount();
  });

  it("英数字欄で Field+ は Field Exit と同じく次の欄へ（F2）", async () => {
    const { w, keys } = await typed([fld({ index: 1, row: 5, col: 10, length: 6 }), fld({ index: 2, row: 6, col: 10, length: 6 })], "AB");
    keys.fieldPlus();
    await nextTick();
    expect(notices(w)).not.toContain(MSG_FIELD_MINUS_INVALID);
    expect(w.emitted("field-full")).toBeTruthy();
    w.unmount();
  });

  it("数字専用（0x0500）の欄と継続欄でも Field− はエラー（ACS が許すのは符号付き数値・数値専用だけ）", async () => {
    for (const f of [
      fld({ index: 1, row: 5, col: 10, length: 6, numeric: true, digitsOnly: true }),
      fld({ index: 1, row: 5, col: 10, length: 4, numeric: true, continued: "first" })
    ]) {
      const { w, keys } = await typed([f], "12");
      keys.fieldMinus();
      await nextTick();
      expect(notices(w)).toContain(MSG_FIELD_MINUS_INVALID);
      w.unmount();
    }
  });

  it("数値専用（0x0300）の欄では Field− が通る（次の欄へ）", async () => {
    const { w, keys } = await typed([fld({ index: 1, row: 5, col: 10, length: 6, numeric: true }), fld({ index: 2, row: 6, col: 10, length: 6 })], "12");
    keys.fieldMinus();
    await nextTick();
    expect(notices(w)).not.toContain(MSG_FIELD_MINUS_INVALID);
    expect(w.emitted("field-full")).toBeTruthy();
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

  // ~~FER 欄では Dup のあとも欄に留まる~~（GNU tn5250 由来の分岐で、ACS と逆だった）。
  // ACS `PS5250.processDupFM` は FER も `isFieldExitRequired` も見ない。実機の ACS でも CHECK(RZ) DUP の欄で
  // Dup → 次の欄へ移った（`scripts/acs-probe/field-exit-full.txt` の場合 G。`20260921-field-exit-required-types`）
  it.each([
    ["FER", { fieldExitRequired: true }],
    ["CHECK(RZ)", { adjust: "right-zero" as const }],
    ["符号付き数値", { signedNumeric: true, numeric: true }]
  ])("**%s 欄でも Dup のあとは次の欄へ送る**（ACS は Field Exit 必須を見ない）", async (_l, extra) => {
    const w = mountGrid([fld({ index: 1, row: 5, col: 10, length: 4, dupEnable: true, ...extra })]);
    await nextTick();
    firstInput(w).focus();
    (w.vm as unknown as { dup: () => void }).dup();
    await nextTick();
    expect((w.emitted("field-full") as unknown[][])?.[0]?.[0]).toBe(1);
    w.unmount();
  });
});
