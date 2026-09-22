import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_BY_REASON } from "../src/composables/opMessages.js";

/**
 * **操作員エラー中の打鍵の振り分け**（`20260921-operator-error-mode`）。
 *
 * 実機で ACS を測った規則（`research.md` F3〜F5）:
 *  - 欄を書き換えるキー（文字・Backspace・Delete）は**拒否**。メッセージは残る
 *  - カーソルを動かすキー（矢印・Tab・Home）・AID・Reset（左 Ctrl 単独）・クリックで**抜ける**
 *  - **エラーに入った時点で挿入モードが解ける**。Reset は**エラーでなくても**挿入モードを解く
 *
 * 型違反で入る経路を使う: 英字専用欄（`alphaOnly`）に数字を打つと `MSG_BY_REASON["alpha-only"]`。
 * 実機と同じく EmulatorPane 起点で打つ（`.pane` の capture が入力欄より先に打鍵を見るため）。
 */
const SID = "em1";
const ERR = MSG_BY_REASON["alpha-only"];

function cell(): Cell {
  return {
    char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  };
}
function snap(fields: Field[], cursor: { row: number; col: number }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: SID, rows: 24, cols: 80, cursor, keyboardLocked: false, cells, fields };
}
function fld(): Field {
  return {
    index: 1, row: 5, col: 10, length: 5,
    protected: false, hidden: false, numeric: false, mdt: false, value: "", alphaOnly: true
  } as Field;
}
function seed(): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap([fld()], { row: 5, col: 10 }), edits: new Map(),
    cursor: { row: 5, col: 10 }, link: { state: "connected" }, resumability: "resumable",
    readOnly: false, client: { send: () => {} } as unknown as WsClient
  });
}

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
beforeEach(seed);

async function mountInField() {
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const input = w.find("input.grid-input");
  (input.element as HTMLInputElement).focus();
  await nextTick();
  expect(document.activeElement, "前提: 入力欄にフォーカスがある").toBe(input.element);
  return { w, input };
}
function opmsg(w: ReturnType<typeof mount>): string {
  return w.find(".opmsg").exists() ? w.find(".opmsg").text() : "";
}
function value(input: ReturnType<ReturnType<typeof mount>["find"]>): string {
  return (input.element as HTMLInputElement).value.trimEnd();
}
/** 型違反でエラー状態に入る */
async function enterError(input: ReturnType<ReturnType<typeof mount>["find"]>, w: ReturnType<typeof mount>) {
  await input.trigger("keydown", { key: "1" });
  await nextTick();
  expect(opmsg(w), "前提: 型違反のメッセージが出ている").toBe(ERR);
}

describe("操作員エラー中の打鍵", () => {
  it("前提: エラーでなければ英字は入力される", async () => {
    const { input } = await mountInField();
    await input.trigger("keydown", { key: "A" });
    expect(value(input)).toBe("A");
  });

  it("**文字は拒否され、メッセージが残る**（ACS: 入力されない）", async () => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await input.trigger("keydown", { key: "A" });
    await nextTick();
    expect(value(input), "エラー中に文字が入った").toBe("");
    expect(opmsg(w), "拒否したのにメッセージが消えた").toBe(ERR);
  });

  it.each(["Backspace", "Delete"])("**%s も拒否**（欄を書き換えない）", async (key) => {
    const { w, input } = await mountInField();
    await input.trigger("keydown", { key: "A" });
    await input.trigger("keydown", { key: "B" });
    expect(value(input)).toBe("AB");
    await enterError(input, w);
    await input.trigger("keydown", { key: "Home" }); // 抜けてしまうので、先に入れ直す
    await enterError(input, w);
    await input.trigger("keydown", { key });
    await nextTick();
    expect(value(input), `${key} で欄が書き換わった`).toBe("AB");
    expect(opmsg(w)).toBe(ERR);
  });

  it.each(["ArrowRight", "ArrowLeft", "Tab", "Home"])("**%s で抜ける**（メッセージが消え、次の文字が入る）", async (key) => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await input.trigger("keydown", { key });
    await nextTick();
    expect(opmsg(w), `${key} で抜けていない`).toBe("");
  });

  it("抜けた後は文字が入る（錠が残っていない）", async () => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await input.trigger("keydown", { key: "ArrowLeft" });
    await input.trigger("keydown", { key: "A" });
    await nextTick();
    expect(value(input)).toBe("A");
    expect(opmsg(w)).toBe("");
  });

  it("Shift 等の修飾キー単独では抜けない", async () => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await input.trigger("keydown", { key: "Shift", code: "ShiftLeft" });
    await nextTick();
    expect(opmsg(w)).toBe(ERR);
  });
});

describe("Reset（左 Ctrl を単独で押して離す）", () => {
  it("**左 Ctrl 単独で抜ける**", async () => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await input.trigger("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(opmsg(w), "押しただけでは抜けない（離して Reset）").toBe(ERR);
    await input.trigger("keyup", { key: "Control", code: "ControlLeft" });
    await nextTick();
    expect(opmsg(w), "Reset で抜けていない").toBe("");
  });

  it("**他のキーを挟んだら Reset にしない**（Ctrl+C のたびに Reset が走らないため）", async () => {
    // 挟むキーは Shift（修飾キー単独ではエラーを抜けない）。文字キーを挟むと、そのキー自体の
    // 「抜ける」が働いて Reset の取り消しを観測できない
    const { w, input } = await mountInField();
    await enterError(input, w);
    await input.trigger("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
    await input.trigger("keydown", { key: "Shift", code: "ShiftLeft", ctrlKey: true, shiftKey: true });
    await input.trigger("keyup", { key: "Control", code: "ControlLeft" });
    await nextTick();
    expect(opmsg(w), "他のキーを挟んだのに Reset が走った").toBe(ERR);
  });

  it("**エラーでなくても Reset で挿入モードが解ける**（ACS `ECLPS.reset`・実機 2 経路）", async () => {
    const { w, input } = await mountInField();
    await input.trigger("keydown", { key: "Insert" });
    await nextTick();
    expect(w.find(".mode").text(), "前提: 挿入モード").toBe("挿入");
    await input.trigger("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
    await input.trigger("keyup", { key: "Control", code: "ControlLeft" });
    await nextTick();
    expect(w.find(".mode").text(), "Reset で挿入モードが解けていない").toBe("上書き");
  });

  it("**Reset のあと同じ欄で打つと上書きになる**（表示だけでなく打鍵も。独立点検の指摘）", async () => {
    const { w, input } = await mountInField();
    await input.trigger("keydown", { key: "A" });
    await input.trigger("keydown", { key: "B" });
    await input.trigger("keydown", { key: "Home" });
    await input.trigger("keydown", { key: "Insert" });
    await nextTick();
    expect(w.find(".mode").text(), "前提: 挿入モード").toBe("挿入");
    await input.trigger("keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
    await input.trigger("keyup", { key: "Control", code: "ControlLeft" });
    await nextTick();
    await input.trigger("keydown", { key: "Z" });
    await nextTick();
    expect(value(input), "Reset の後なのに挿入で入った").toBe("ZB");
    expect(w.find(".mode").text(), "打鍵で挿入モードが復活した").toBe("上書き");
  });

  it("右 Ctrl は Reset ではない", async () => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await input.trigger("keydown", { key: "Control", code: "ControlRight", ctrlKey: true });
    await input.trigger("keyup", { key: "Control", code: "ControlRight" });
    await nextTick();
    expect(opmsg(w)).toBe(ERR);
  });
});

describe("そのほかの抜け方", () => {
  it("**クリックで抜ける**（ACS `canClearErrorModeViaMouseClick`）", async () => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await w.find(".pane").trigger("pointerdown");
    await nextTick();
    expect(opmsg(w)).toBe("");
  });

  it("**エラーに入った時点で挿入モードが解ける**（実機 2 経路で観測。`research.md` F6）", async () => {
    const { w, input } = await mountInField();
    await input.trigger("keydown", { key: "Insert" });
    await nextTick();
    expect(w.find(".mode").text(), "前提: 挿入モード").toBe("挿入");
    await enterError(input, w);
    expect(w.find(".mode").text(), "エラーに入っても挿入モードのまま").toBe("上書き");
  });

  it("**エラーで挿入が解けたあと、同じ欄で抜けて打つと上書きになる**（research F6 の実測の筋書き）", async () => {
    const { w, input } = await mountInField();
    await input.trigger("keydown", { key: "A" });
    await input.trigger("keydown", { key: "B" });
    await input.trigger("keydown", { key: "Home" });
    await input.trigger("keydown", { key: "Insert" });
    await nextTick();
    await enterError(input, w);
    await input.trigger("keydown", { key: "ArrowRight" }); // 同じ欄の中で抜ける
    await nextTick();
    expect(w.find(".mode").text(), "抜けたら挿入モードが復活した").toBe("上書き");
    await input.trigger("keydown", { key: "Z" });
    await nextTick();
    expect(value(input), "挿入で入った").toBe("AZ");
  });

  it("情報の通知では挿入モードを解かない", async () => {
    const { w, input } = await mountInField();
    await input.trigger("keydown", { key: "Insert" });
    await nextTick();
    w.findComponent({ name: "ScreenGrid" }).vm.$emit("notice", "表示切替");
    await nextTick();
    expect(w.find(".mode").text()).toBe("挿入");
  });

  it("**ホイール（PageUp/Down）でも抜ける**（ACS は Roll も AID として `clearErrorMode` する）", async () => {
    const { w, input } = await mountInField();
    await enterError(input, w);
    await w.find(".pane").trigger("wheel", { deltaY: 100 });
    await nextTick();
    expect(opmsg(w), "ホイールで送ったのにエラーが残った").toBe("");
  });

  it("エラーでない通知（情報）は次のキーで消えるだけで、文字は入る", async () => {
    const { w, input } = await mountInField();
    // 情報の通知を直接出す経路の代わりに、ScreenGrid の notice を型違反以外の文言で発火させる
    const grid = w.findComponent({ name: "ScreenGrid" });
    grid.vm.$emit("notice", "表示切替");
    await nextTick();
    expect(opmsg(w).replace(/\s/g, "")).toBe("表示切替"); // 最下行はセル描画で全角の間に空白が入る
    await input.trigger("keydown", { key: "A" });
    await nextTick();
    expect(value(input), "情報の通知で打鍵が止まった").toBe("A");
    expect(opmsg(w)).toBe("");
  });
});
