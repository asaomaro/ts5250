import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **WRITE ERROR CODE TO WINDOW（0x22）のメッセージを ACS と同じ行・桁に重ねる**（`20260926-window-error-code`）。
 * core が ACS と同じ規則で位置（`systemMessageArea`）を付け、UI はそこへ `.opmsg` を置く。0x21 はメッセージ行の 1 行全体（`20260926-wec-msgline-row`）。
 * 位置の無い systemMessage（旧いサーバー等）は従来どおり最下行の全幅。
 * 実機の ACS のコアの結果は `scripts/acs-probe/window-error-code.txt`（0x22: 22 行・桁 12 から 17 桁／最下行は桁 1 から）と
 * `scripts/acs-probe/wec-msgline-row.txt`（0x21: 申告した行の桁 1 に属性・桁 2 から本文）。
 */
const SID = "we1";
function cell(): Cell {
  return { char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false };
}
const FIELD = { index: 1, row: 7, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
function snap(extra: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: 80 }, () => cell()));
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: 7, col: 20 }, keyboardLocked: false, cells, fields: [FIELD], ...extra };
}
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
beforeEach(() => {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  const s = snap();
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: s, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send: () => {} } as unknown as WsClient
  });
});
async function mountPane() {
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const input = w.find("input.grid-input");
  (input.element as HTMLInputElement).focus();
  await nextTick();
  return { w, el: input.element as HTMLInputElement };
}
async function host(extra: Partial<ScreenSnapshot>) {
  sessionsStore.updateScreen(SID, snap(extra));
  await nextTick();
  await nextTick();
}
const box = (w: ReturnType<typeof mount>) => w.find(".opmsg");

describe("0x22 の位置に重ねる", () => {
  it("**22 行・桁 12・幅 17 に置き、本文を出す**", async () => {
    const { w } = await mountPane();
    await host({ systemMessage: "ERR IN WINDOW", systemMessageSeq: 301, systemMessageArea: { row: 22, col: 12, width: 17 } });
    const el = box(w);
    expect(el.exists()).toBe(true);
    expect(el.classes()).toContain("opmsg-area");
    const st = (el.element as HTMLElement).style;
    expect(st.top).toBe(`${21 * 1.25}em`);
    expect(st.left).toBe("11ch");
    expect(st.width).toBe("17ch");
    expect(el.text().trim()).toBe("ERR IN WINDOW");
  });

  it("**最下行（ACS が桁 1 へ戻した）も位置どおりに置く**", async () => {
    const { w } = await mountPane();
    await host({ systemMessage: "ERR IN WINDOW", systemMessageSeq: 302, systemMessageArea: { row: 24, col: 1, width: 28 } });
    const st = (box(w).element as HTMLElement).style;
    expect(st.top).toBe(`${23 * 1.25}em`);
    expect(st.left).toBe("0ch");
    expect(st.width).toBe("28ch");
  });

  it("本文が空でも位置があれば空欄として重ねる（ACS は範囲を空にする）", async () => {
    const { w } = await mountPane();
    await host({ systemMessage: "", systemMessageSeq: 303, systemMessageArea: { row: 22, col: 12, width: 17 } });
    expect(box(w).exists()).toBe(true);
    expect(box(w).classes()).toContain("opmsg-area");
    // 高さを持たないと空の div は 0 の高さで何も隠さない（独立点検の指摘）
    expect((box(w).element as HTMLElement).style.height).toBe("1.25em");
  });

  it("**位置の無い systemMessage（旧いサーバー等）は従来どおり最下行の全幅**（`opmsg-area` を付けない）", async () => {
    const { w } = await mountPane();
    await host({ systemMessage: "FULL LINE", systemMessageSeq: 304 });
    expect(box(w).exists()).toBe(true);
    expect(box(w).classes()).not.toContain("opmsg-area");
    expect((box(w).element as HTMLElement).getAttribute("style")).toBeNull();
  });

  it("クライアント側の操作員メッセージを出している間は、位置を使わず最下行の全幅（ACS の OIA 相当が優先）", async () => {
    const { w } = await mountPane();
    await host({ systemMessage: "ERR IN WINDOW", systemMessageSeq: 306, systemMessageArea: { row: 22, col: 12, width: 17 } });
    sessionsStore.get(SID)!.notice = "CLIENT NOTICE";
    await nextTick();
    await nextTick();
    expect(box(w).text().trim()).toBe("CLIENT NOTICE");
    expect(box(w).classes()).not.toContain("opmsg-area");
  });

  it("**Reset でエラー状態を抜けると消える**（0x21 と同じ経路。ACS はメッセージ行を元に戻す）", async () => {
    const { w, el } = await mountPane();
    await host({ systemMessage: "ERR IN WINDOW", systemMessageSeq: 305, systemMessageArea: { row: 22, col: 12, width: 17 } });
    expect(box(w).exists()).toBe(true);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft", location: 1, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", location: 1, bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(box(w).exists(), "抜けても残った").toBe(false);
  });
});

describe("0x21 のメッセージ行に重ねる（`20260926-wec-msgline-row`）", () => {
  it("**0x21 は SOH が申告したメッセージ行（22 行）の 1 行全体に置く**（桁 1 は属性の空き、本文は桁 2 から。`20260926-wec-msgline-row`）", async () => {
    const { w } = await mountPane();
    await host({ systemMessage: "ERR ON MSG LINE", systemMessageSeq: 307, systemMessageArea: { row: 22, col: 1, width: 80 } });
    const el = box(w);
    expect(el.classes()).toContain("opmsg-area");
    const st = (el.element as HTMLElement).style;
    expect(st.top).toBe(`${21 * 1.25}em`);
    expect(st.left).toBe("0ch");
    expect(st.width).toBe("80ch");
    expect(el.element.textContent).toBe(" ERR ON MSG LINE");
  });

  it("**90 字の本文も 1 行の範囲（80 桁）に置き、切り捨てで出す**（ACS は続きを次の行へ上書きするが合わせない。decisions D2。jsdom では切れ方そのものは測れない）", async () => {
    const { w } = await mountPane();
    await host({ systemMessage: "L".repeat(90), systemMessageSeq: 308, systemMessageArea: { row: 22, col: 1, width: 80 } });
    const el = box(w);
    expect(el.classes()).toContain("opmsg-area");
    expect((el.element as HTMLElement).style.width).toBe("80ch");
    expect((el.element as HTMLElement).style.height).toBe("1.25em");
  });
});
