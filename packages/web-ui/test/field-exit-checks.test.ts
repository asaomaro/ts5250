import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_MANDATORY_ENTER_EXIT, MSG_MANDATORY_FILL, MSG_BY_REASON, isOperatorError } from "../src/composables/opMessages.js";
import { fieldExitRejection } from "../src/composables/mandatoryCheck.js";

/**
 * **Field Exit・Field± で欄を出る前の検査**（ACS `PS5250.processFieldPlusMinusAndExit`。`20260921-field-exit-checks`）。
 * 実機の ACS のコア（`scripts/acs-probe/field-exit-checks.txt`）: ME の欄の先頭で Field Exit・MDT の無い ME の欄で Field Exit・打ってから先頭へ戻って
 * Field+ はエラー（0021）でカーソルも値もそのまま、打ってそのまま Field Exit は次の欄へ。入力不可（DDS の I）の欄では Field Exit・Field+ ともエラー（0004）。
 *
 * （以下は `mandatory-check-acs.test.ts` の補助をそのまま使う）
 * **ME / MF / 自己点検を ACS のタイミングで**（`20260921-mandatory-check-acs`）。
 *
 * 実機の ACS（ADJPGM・research F2）:
 *  - MF・自己点検は**欄を出るときにも**見る（MF に `AB` と打って Tab → 欄の先頭でエラー）
 *  - ME / MF / 自己点検のエラーは操作員エラー（エラー状態に入る）
 * ここではペインを通した振る舞い（欄を出る・エラー状態・ボタンのカーソル）を固定する。
 * 判定そのものは `ffw-behavior-bits.test.ts` / `self-check-field.test.ts`。
 */
const SID = "mc1";
function cell(): Cell {
  return {
    char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  };
}
function fld(index: number, row: number, extra: Partial<Field> = {}): Field {
  return {
    index, row, col: 20, length: 6,
    protected: false, hidden: false, numeric: false, mdt: false, value: "", ...extra
  } as Field;
}
/** 5=MF / 7=素 / 9=ME / 11=入力不可（DDS の I） */
const FIELDS = (): Field[] => [
  fld(1, 5, { adjust: "mandatory-fill" }),
  fld(2, 7),
  fld(3, 9, { mandatoryEnter: true }),
  fld(4, 11, { keyboardInhibited: true })
];
function snap(cursor = { row: 5, col: 20 }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: SID, rows: 24, cols: 80, cursor, keyboardLocked: false, cells, fields: FIELDS() };
}
let send: Mock<(m: unknown) => void>;
function seed(cursor?: { row: number; col: number }): void {
  send = vi.fn<(m: unknown) => void>();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const s = snap(cursor);
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send } as unknown as WsClient
  });
}
const keysSent = () =>
  send.mock.calls.map((c) => c[0] as { type: string; key: string }).filter((m) => m.type === "key").map((m) => m.key);

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
beforeEach(() => seed());

async function mountAt(idx: number, cursor = { row: 5, col: 20 }) {
  seed(cursor);
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const inputs = w.findAll("input.grid-input");
  const el = inputs[idx]!.element as HTMLInputElement;
  el.focus();
  await nextTick();
  return { w, inputs, el };
}
async function press(key: string, opts: KeyboardEventInit = {}) {
  (document.activeElement as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts })
  );
  await nextTick();
  await nextTick();
}
async function typeText(t: string) {
  for (const ch of t) await press(ch);
}
const opmsg = (w: ReturnType<typeof mount>) =>
  w.find(".opmsg").exists() ? w.find(".opmsg").text().replace(/\s/g, "") : "";
const norm = (s: string) => s.replace(/\s/g, "");


const fieldExit = () => press("Enter", { ctrlKey: true });
const fieldPlus = () => press("+", { ctrlKey: true });

describe("純ロジック", () => {
  const e = new Map<number, string>();
  it("入力不可 → kbd-inhibited、ME は先頭か MDT 無し、MF は先頭以外で部分入力", () => {
    expect(fieldExitRejection(fld(1, 1, { keyboardInhibited: true }), e, false)).toBe("kbd-inhibited");
    expect(fieldExitRejection(fld(1, 1, { mandatoryEnter: true }), e, false)).toBe("mandatory-enter");
    expect(fieldExitRejection(fld(1, 1, { mandatoryEnter: true }), new Map([[1, "AB"]]), true)).toBe("mandatory-enter");
    expect(fieldExitRejection(fld(1, 1, { mandatoryEnter: true }), new Map([[1, "AB"]]), false)).toBeUndefined();
    expect(fieldExitRejection(fld(1, 1, { adjust: "mandatory-fill" }), new Map([[1, "AB"]]), false)).toBe("mandatory-fill");
    expect(fieldExitRejection(fld(1, 1, { adjust: "mandatory-fill" }), new Map([[1, "AB"]]), true), "先頭なら通す（消去で空になる）").toBeUndefined();
    expect(fieldExitRejection(fld(1, 1, { adjust: "mandatory-fill", signedNumeric: true }), new Map([[1, "12"]]), false), "符号付き数値の MF は見ない").toBeUndefined();
  });
});

describe("ME の欄", () => {
  it("**先頭で Field Exit → 0021 で止まる**（値もカーソルもそのまま・エラー状態）", async () => {
    const { w, el } = await mountAt(2, { row: 9, col: 20 });
    await fieldExit();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_ENTER_EXIT));
    expect(isOperatorError(MSG_MANDATORY_ENTER_EXIT)).toBe(true);
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
  });
  it("打ってそのまま Field Exit → 次の欄へ（実機の E3）", async () => {
    const { w, inputs } = await mountAt(2, { row: 9, col: 20 });
    await typeText("AB");
    await fieldExit();
    expect(opmsg(w)).toBe("");
    expect(document.activeElement).toBe(inputs[3]!.element);
  });
  it("**打ってから先頭へ戻って Field+ → 止まる**（実機の E4）", async () => {
    const { w, el } = await mountAt(2, { row: 9, col: 20 });
    await typeText("AB");
    await press("ArrowLeft");
    await press("ArrowLeft"); // 欄の先頭へ戻る
    await fieldPlus();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_ENTER_EXIT));
    expect(el.value.trim()).toBe("AB");
  });
});

describe("入力不可（DDS の I）の欄", () => {
  it("**Field Exit・Field+ とも 0004 で止まる**（欄を出ない）", async () => {
    const { w, el } = await mountAt(3, { row: 11, col: 20 });
    await fieldExit();
    expect(opmsg(w)).toBe(norm(MSG_BY_REASON["kbd-inhibited"]));
    expect(document.activeElement).toBe(el);
  });
});

describe("MF の欄", () => {
  it("**先頭以外で部分入力のまま Field Exit → 欄の先頭へ戻して止める（消さない）**", async () => {
    const { w, el } = await mountAt(0);
    await typeText("ABC");
    el.setSelectionRange(1, 1);
    await press("ArrowLeft");
    await press("ArrowRight"); // 編集モデルのカーソルを 1 桁目へ
    await fieldExit();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_FILL));
    expect(el.value.trim(), "カーソル以降を消していない").toBe("ABC");
    expect(el.selectionStart).toBe(0);
  });
});
