import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { sendKey } from "../src/session-controller.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_FIELD_EXIT_REQUIRED } from "../src/composables/opMessages.js";

/**
 * **欄を出ないまま AID を押したとき**（ACS のエラー 0020。`20260921-aid-without-field-exit`）。
 *
 * 実機の ACS（ADJPGM・research F2）:
 *  - RZ / RB / 符号付き数値の欄に打って、欄を出ずに Enter・F3・Roll → **送らずにエラー**
 *  - Field Exit で出る・Tab で出て戻る・別の欄へカーソルを移す → 送れる
 *  - 欄の中の右矢印では出たことにならない（エラー）
 *  - 打っていない（ホストの値だけの）欄にカーソルがあっても送れる。素の欄は打っても送れる
 * 原典 `PS5250.processAIDCode` は Help と Clear をこの検査から外す。自動 Enter 欄も外す。
 */
const SID = "fe1";

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
/** 3=RZ / 5=素 / 7=符号付き / 9=RB / 11=自動 Enter の RZ */
const FIELDS: Field[] = [
  fld(1, 3, { adjust: "right-zero" }),
  fld(2, 5),
  fld(3, 7, { signedNumeric: true, numeric: true }),
  fld(4, 9, { adjust: "right-blank" }),
  fld(5, 11, { adjust: "right-zero", autoEnter: true })
];
function snap(cursor = { row: 3, col: 20 }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: SID, rows: 24, cols: 80, cursor, keyboardLocked: false, cells, fields: FIELDS };
}
let send: ReturnType<typeof vi.fn>;
function seed(cursor?: { row: number; col: number }): void {
  send = vi.fn();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const s = snap(cursor);
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send } as unknown as WsClient
  });
}
/** 送った AID（活動通知などキー以外の送信は除く） */
function sentKeys(): string[] {
  return send.mock.calls.map((c) => c[0] as { type: string; key?: string })
    .filter((m) => m.type === "key").map((m) => m.key!);
}

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
beforeEach(() => seed());

async function mountAt(row: number) {
  seed({ row, col: 20 });
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  // 入力欄は欄の順に並ぶ（FIELDS は行の昇順）
  const input = w.findAll("input.grid-input")[FIELDS.findIndex((f) => f.row === row)]!;
  (input.element as HTMLInputElement).focus();
  await nextTick();
  expect(document.activeElement, "前提: 対象の欄にフォーカスがある").toBe(input.element);
  return { w, input };
}
function opmsg(w: ReturnType<typeof mount>): string {
  return w.find(".opmsg").exists() ? w.find(".opmsg").text().replace(/\s/g, "") : "";
}
const ERR = MSG_FIELD_EXIT_REQUIRED.replace(/\s/g, "");

async function type(input: { trigger: (t: string, o: object) => Promise<void> }, text: string) {
  for (const ch of text) await input.trigger("keydown", { key: ch });
  await nextTick();
}

describe("右寄せ・符号付き数値の欄に打って、欄を出ずに AID", () => {
  it.each([
    ["CHECK(RZ)", 3],
    ["符号付き数値", 7],
    ["CHECK(RB)", 9]
  ])("**%s: Enter は送らずにエラー**", async (_label, row) => {
    const { w, input } = await mountAt(row);
    await type(input, "12");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys(), "欄を出ていないのに送った").toEqual([]);
    expect(opmsg(w)).toBe(ERR);
  });

  it("**F3（CA キー）も止める**（実機の ACS で止まった。Enter に限らない）", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    await input.trigger("keydown", { key: "F3" });
    await nextTick();
    expect(sentKeys()).toEqual([]);
  });

  it("**PageDown（Roll）も止める**", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    await input.trigger("keydown", { key: "PageDown" });
    await nextTick();
    expect(sentKeys()).toEqual([]);
  });

  it("**エラー状態に入る**（次の文字は入らない）", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    await type(input, "3");
    expect((input.element as HTMLInputElement).value.trimEnd(), "エラー中に文字が入った").toBe("12");
  });

  it("**カーソルは動かさない**（ACS は打った位置のまま）", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    const el = input.element as HTMLInputElement;
    expect(el.selectionStart, "前提: 打った後ろにキャレットがある").toBe(2);
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(document.activeElement, "0020 で別の欄へ移った").toBe(el);
    expect(el.selectionStart, "0020 で欄の先頭へ戻された").toBe(2);
  });
});

describe("送れる場合", () => {
  it("**Field Exit で出れば送れる**", async () => {
    const { w, input } = await mountAt(3);
    await type(input, "12");
    w.findComponent(ScreenGrid).vm.fieldExit();
    await nextTick();
    await nextTick();
    const now = document.activeElement as HTMLElement;
    now.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("**単独欄で Field Exit が自分へ巡回しても送れる**（出たことになる）", async () => {
    // 欄 1 つだけの画面
    const one = [FIELDS[0]!];
    seed({ row: 3, col: 20 });
    sessionsStore.get(SID)!.snapshot = { ...snap(), fields: one };
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    const input = w.find("input.grid-input");
    (input.element as HTMLInputElement).focus();
    await nextTick();
    await type(input, "12");
    expect(sessionsStore.get(SID)!.awaitingFieldExit, "前提: 待ちが付いた").toBe(1);
    w.findComponent(ScreenGrid).vm.fieldExit();
    // **Field Exit そのものが「出た」**（ACS `processFieldPlusMinusAndExit` がフラグを立てる）。
    // カーソルの行き先（自分の欄の中か外か）に頼らないことを、カーソル監視が走る前に見る
    expect(sessionsStore.get(SID)!.awaitingFieldExit, "Field Exit で待ちが外れていない").toBeUndefined();
    await nextTick();
    await nextTick();
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("**Tab で出て Shift+Tab で戻っても送れる**（実機 ACS の場合 4）", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    await input.trigger("keydown", { key: "Tab" });
    await nextTick();
    const next = document.activeElement as HTMLInputElement;
    expect(next, "前提: Tab で次の欄へ移った").not.toBe(input.element);
    next.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement, "前提: 戻ってきた").toBe(input.element);
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("**欄の中の右矢印では出たことにならない**（実機 ACS の場合 5）", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    await input.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    expect(document.activeElement, "前提: 欄の中に居る").toBe(input.element);
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual([]);
  });

  it("**Erase Input の後は送れる**（ACS は MDT ごと下ろすので 0020 の対象から外れる）", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    // 既定の割り当て（Ctrl+Backspace）で押す——ペインの onLocal を通す経路が実際の経路
    await input.trigger("keydown", { key: "Backspace", code: "Backspace", ctrlKey: true });
    await nextTick();
    await nextTick();
    expect((input.element as HTMLInputElement).value.trim(), "前提: Erase Input で消えた").toBe("");
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("**RZ 欄を最終桁まで打てば送れる**（欄に留まるが「出た」ことになる。実機 ACS の場合 10）", async () => {
    const { input } = await mountAt(3);
    await type(input, "123456");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("**符号付き数値は数字桁を埋めても 0020**（符号桁に留まる。実機 ACS の場合 11）", async () => {
    const { input } = await mountAt(7);
    await type(input, "12345");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual([]);
  });

  it("素の欄は打っても送れる", async () => {
    const { input } = await mountAt(5);
    await type(input, "12");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("打っていない RZ 欄にカーソルがあるだけなら送れる", async () => {
    const { input } = await mountAt(3);
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it("自動 Enter の RZ 欄は対象外", async () => {
    const { input } = await mountAt(11);
    await type(input, "12");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });

  it.each(["Help", "Clear"] as const)("%s は止めない（原典が検査から外す）", async (key) => {
    const { input } = await mountAt(3);
    await type(input, "12");
    sendKey(SID, key);
    expect(sentKeys()).toEqual([key]);
    void input;
  });

  it("**エラーのあと Tab で抜ければ、次の Enter は送れる**", async () => {
    const { w, input } = await mountAt(3);
    await type(input, "12");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(sentKeys()).toEqual([]);
    await input.trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(opmsg(w), "Tab でエラーを抜けていない").toBe("");
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    await nextTick();
    expect(sentKeys()).toEqual(["Enter"]);
  });
});

describe("待ちの寿命", () => {
  it("**新しい画面が来たら捨てる**（打ちかけも捨てられる）", async () => {
    const { input } = await mountAt(3);
    await type(input, "12");
    expect(sessionsStore.get(SID)!.awaitingFieldExit, "前提: 待ちが付いた").toBe(1);
    sessionsStore.updateScreen(SID, snap());
    expect(sessionsStore.get(SID)!.awaitingFieldExit).toBeUndefined();
  });

  it("**ペインを通らない送信（OIA のボタン）でも止め、エラー状態に入る**", async () => {
    const { w, input } = await mountAt(3);
    await type(input, "12");
    sendKey(SID, "F3");
    await nextTick();
    expect(sentKeys()).toEqual([]);
    expect(opmsg(w)).toBe(ERR);
    expect(sessionsStore.get(SID)!.notice, "セッション側に通知が残ると、エラーを抜けても消えない").toBeUndefined();
  });
});
