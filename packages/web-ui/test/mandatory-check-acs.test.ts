import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_MANDATORY_ENTER, MSG_MANDATORY_FILL, MSG_SELF_CHECK, isOperatorError } from "../src/composables/opMessages.js";
import { sendKey } from "../src/session-controller.js";

/**
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
/** 5=MF / 7=素 / 9=ME / 11=自己点検（mod10） */
const FIELDS = (): Field[] => [
  fld(1, 5, { adjust: "mandatory-fill" }),
  fld(2, 7),
  fld(3, 9, { mandatoryEnter: true }),
  fld(4, 11, { selfCheck: "mod10" })
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

describe("欄を出るときの MF・自己点検", () => {
  it("**MF に途中まで打って Tab で出ると、エラーにして欄の先頭へ戻す**（実機の ACS の場合 6）", async () => {
    const { w, el } = await mountAt(0);
    await typeText("AB");
    await press("Tab");
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_FILL));
    expect(document.activeElement, "MF 欄へ戻っていない").toBe(el);
    expect(el.selectionStart, "欄の先頭へ戻っていない").toBe(0);
  });

  it("**エラー状態に入る**（次の文字は入らない）", async () => {
    const { el } = await mountAt(0);
    await typeText("AB");
    await press("Tab");
    await press("Z");
    expect(el.value.trim()).toBe("AB");
  });

  it("MF を満杯まで打てば出られる", async () => {
    const { w } = await mountAt(0);
    await typeText("ABCDEF"); // 満杯で次の欄へ自動送り
    await press("Tab");
    expect(opmsg(w)).toBe("");
  });

  it("MF に何も打たずに出るのは通る（空は ME の役目）", async () => {
    const { w, inputs } = await mountAt(0);
    await press("Tab");
    expect(opmsg(w)).toBe("");
    expect(document.activeElement).toBe(inputs[1]!.element);
  });

  it("**クリックで別の欄へ移っても同じく止める**（ACS `canCursorMoveByMouse`）", async () => {
    const { w, inputs, el } = await mountAt(0);
    await typeText("AB");
    (inputs[1]!.element as HTMLInputElement).focus(); // クリックで別の欄へ
    await nextTick();
    await nextTick();
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_FILL));
    expect(document.activeElement).toBe(el);
  });

  it("**自己点検の検査桁が合わないまま出ると止める**", async () => {
    const { w } = await mountAt(3, { row: 11, col: 20 });
    await typeText("1234"); // mod10 で合わない
    await press("Tab");
    expect(opmsg(w)).toBe(norm(MSG_SELF_CHECK));
  });

  it("新しい画面が来たときのカーソル移動では検査しない（打ちかけは捨てられている）", async () => {
    const { w } = await mountAt(0);
    await typeText("AB");
    sessionsStore.updateScreen(SID, snap({ row: 7, col: 20 }));
    await nextTick();
    await nextTick();
    expect(opmsg(w)).toBe("");
  });
});

describe("独立点検の指摘（欄を出るときの検査）", () => {
  it("**違反のある欄が隣り合っても、戻す移動を「欄を出た」と数えない**（往復し続けない）", async () => {
    // MF 欄 A（5 行目）と自己点検欄 B（11 行目）の両方を違反にしておき、A から B へ移る
    seed({ row: 5, col: 20 });
    sessionsStore.get(SID)!.edits.set(1, "AB"); // A: MF の部分入力
    sessionsStore.get(SID)!.edits.set(4, "1234"); // B: 検査桁が合わない
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    const inputs = w.findAll("input.grid-input");
    const a = inputs[0]!.element as HTMLInputElement;
    a.focus();
    await nextTick();
    (inputs[3]!.element as HTMLInputElement).focus(); // B へ（クリック相当）
    for (let i = 0; i < 10; i++) await nextTick();
    expect(document.activeElement, "A へ戻っていない").toBe(a);
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_FILL));
  });

  it("**新しい画面が来たとき、前のカーソル位置にある新しい画面の欄を検査しない**", async () => {
    const { w } = await mountAt(1, { row: 7, col: 20 });
    await typeText("X");
    // 新しい画面: 前のカーソル位置（7,20）に、ホストが MDT を立てた部分入力の MF 欄がある
    const next = snap({ row: 5, col: 20 });
    next.fields = next.fields.map((f) => (f.index === 2 ? { ...f, adjust: "mandatory-fill", mdt: true, value: "AB" } : f));
    sessionsStore.updateScreen(SID, next);
    for (let i = 0; i < 6; i++) await nextTick();
    expect(opmsg(w), "新しい画面の欄を「出た」と検査した").toBe("");
  });

  it("**FER の欄を満杯まで打った瞬間は「欄を出た」ではない**（右端の境界）", async () => {
    seed({ row: 11, col: 20 });
    const s = sessionsStore.get(SID)!;
    s.snapshot = { ...s.snapshot!, fields: s.snapshot!.fields.map((f) => (f.index === 4 ? { ...f, fieldExitRequired: true } : f)) };
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    (w.findAll("input.grid-input")[3]!.element as HTMLInputElement).focus();
    await nextTick();
    await typeText("123456"); // 検査桁の合わない 6 桁で満杯（FER なので自動送りしない）
    expect(opmsg(w), "満杯にしただけでエラーにした").toBe("");
  });
});

describe("AID の前の検査とエラー状態", () => {
  it("**ME で止めたらエラー状態に入り、ME 欄へ移る**", async () => {
    const { inputs } = await mountAt(1, { row: 7, col: 20 });
    await typeText("X"); // 画面を変更する
    await press("Enter");
    expect(keysSent()).toEqual([]);
    const me = inputs[2]!.element as HTMLInputElement;
    expect(document.activeElement, "ME 欄へ移っていない").toBe(me);
    await press("Q");
    expect(me.value.trim(), "エラー中に文字が入った").toBe("");
  });

  it("**ステータスバーのボタンは、ペインのカーソル（動かした後の位置）で検査・送信する**", async () => {
    // ホストのカーソルは素の欄（7 行目）。利用者が MF 欄へ移って途中まで打ち、ボタンで F3
    const { w } = await mountAt(0, { row: 7, col: 20 });
    await typeText("AB");
    const f3 = w.findAll("button.fk").find((b) => b.text().includes("F3"))!;
    await f3.trigger("click");
    await nextTick();
    expect(keysSent(), "ホストのカーソル位置で検査して送った").toEqual([]);
    expect(opmsg(w)).toBe(norm(MSG_MANDATORY_FILL));
    // キーボードの AID と同じく、止めた欄の先頭へ移る（ACS の場合 5）
    const mf = w.findAll("input.grid-input")[0]!.element as HTMLInputElement;
    expect(document.activeElement).toBe(mf);
    expect(mf.selectionStart).toBe(0);
  });

  it("ME / MF / 自己点検のメッセージは操作員エラー（ACS は `setErrorCode` でエラー状態に入る）", () => {
    for (const m of [MSG_MANDATORY_ENTER, MSG_MANDATORY_FILL, MSG_SELF_CHECK]) expect(isOperatorError(m), m).toBe(true);
  });

  it("**カーソルの無い欄の MF 部分入力は、AID では見ない**（実機の ACS の場合 7: 送れた）", async () => {
    seed({ row: 7, col: 20 });
    sessionsStore.get(SID)!.edits.set(1, "AB"); // MF 欄は部分入力、カーソルは素の欄
    sessionsStore.get(SID)!.edits.set(3, "M"); // ME は埋める
    sendKey(SID, "Enter", { row: 7, col: 20 });
    expect(keysSent()).toEqual(["Enter"]);
  });
});
