import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **ホストのエラー（WRITE ERROR CODE）でもエラー状態に入る**（`20260921-host-error-mode`）。
 *
 * 実機の ACS（ULKPGM の RANGE(1 5) に 9。`scripts/acs-probe/window-error.txt`）:
 *  - WEC が来ると inhibit=5（エラー状態）・最下行にメッセージ・**文字は拒否**・**挿入モードが解ける**
 *  - 左矢印・Tab で抜けると、**最下行のメッセージが消える**（メッセージ行を元に戻す）
 * 操作員エラー（`operator-error-mode.test.ts`）と同じ規則。同じ文言がもう一度来たら入り直す。
 */
const SID = "he1";
const MSG = "このフィールドの有効な範囲は1-5である。";
function cell(): Cell {
  return {
    char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  };
}
const FIELD = { index: 1, row: 7, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
function snap(extra: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
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
  return { w, input, el: input.element as HTMLInputElement };
}
const opmsg = (w: ReturnType<typeof mount>) => (w.find(".opmsg").exists() ? w.find(".opmsg").text().replace(/\s/g, "") : "");
const norm = (t: string) => t.replace(/\s/g, "");
/** ホストが WEC を返した（新しい画面として届く。番号はコアが WEC ごとに振る） */
async function hostError(seq: number) {
  sessionsStore.updateScreen(SID, snap({ systemMessage: MSG, systemMessageSeq: seq }));
  await nextTick();
  await nextTick();
}

describe("ホストのエラー（WRITE ERROR CODE）", () => {
  it("**エラー状態に入り、文字を拒否する**", async () => {
    const { w, input, el } = await mountPane();
    await hostError(101);
    expect(opmsg(w)).toBe(norm(MSG));
    (document.activeElement as HTMLElement).focus();
    el.focus();
    await input.trigger("keydown", { key: "3" });
    await nextTick();
    expect(el.value.trim(), "エラー中に文字が入った").toBe("");
  });

  it("**挿入モードが解ける**", async () => {
    const { w, input } = await mountPane();
    await input.trigger("keydown", { key: "Insert" });
    await nextTick();
    expect(w.find(".mode").text(), "前提").toBe("挿入");
    // ⚠ 画面が届くたびに上書きへ戻す監視（`20260921-insert-mode-per-screen`）も同じ働きをするので、
    // ここで見ているのは「WEC が届いたら上書きになっている」という結果まで（どちらの監視が効いたかは区別しない）
    const st = sessionsStore.get(SID)!;
    st.snapshot = { ...st.snapshot!, systemMessage: MSG, systemMessageSeq: 102 };
    await nextTick();
    await nextTick();
    expect(w.find(".mode").text(), "ホストのエラーで挿入モードが解けていない").toBe("上書き");
  });

  it("**矢印で抜けると、最下行のメッセージが消えて文字が入る**（メッセージ行を元に戻す）", async () => {
    const { w, input, el } = await mountPane();
    await hostError(103);
    el.focus();
    await input.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    expect(opmsg(w), "抜けてもメッセージが残った").toBe("");
    await input.trigger("keydown", { key: "3" });
    await nextTick();
    expect(el.value.trim()).not.toBe("");
  });

  it("**同じ文言がもう一度来たら、入り直してメッセージも出す**", async () => {
    const { w, input, el } = await mountPane();
    await hostError(104);
    el.focus();
    await input.trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(opmsg(w)).toBe("");
    await hostError(105);
    expect(opmsg(w), "2 回目のエラーが出ない").toBe(norm(MSG));
    const cur = document.activeElement as HTMLInputElement;
    const before = cur.value;
    cur.dispatchEvent(new KeyboardEvent("keydown", { key: "7", bubbles: true, cancelable: true }));
    await nextTick();
    expect(cur.value, "2 回目のエラーで文字を拒否していない").toBe(before);
  });

  it("隠したメッセージは、同じ番号のまま画面が更新されても出さない", async () => {
    const { w } = await mountPane();
    await hostError(106);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await nextTick();
    expect(opmsg(w)).toBe("");
    // 同じ番号のまま（新しい WEC ではない）画面が更新されても、隠したものは出さない
    const st = sessionsStore.get(SID)!;
    st.snapshot = { ...st.snapshot!, cursor: { row: 7, col: 21 } };
    await nextTick();
    expect(opmsg(w), "隠したメッセージが戻った").toBe("");
  });
});
