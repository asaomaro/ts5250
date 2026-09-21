import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { MSG_PROTECTED } from "../src/composables/opMessages.js";

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

/**
 * **エラー状態は画面＝セッションに属する**（`SessionState.hostErrorDismissedSeq`。独立点検の指摘）。
 * ペインに持っていた頃は、タブの切り替え・裏のタブへの WEC・ペインの作り直しで
 * 「最下行にメッセージが出ているのにエラー状態ではない」になった。
 */
describe("ホストのエラーとタブ・ペイン", () => {
  const SID2 = "he2";
  function addSecond(): void {
    const s = { ...snap(), sessionId: SID2 };
    sessionsStore.add({
      sessionId: SID2, label: "t2", snapshot: s, edits: new Map(), cursor: s.cursor,
      link: { state: "connected" }, resumability: "resumable", readOnly: false,
      client: { send: () => {} } as unknown as WsClient
    });
  }
  /** 今フォーカスのある欄に 1 文字打ち、値が変わったかを返す */
  async function typeChanges(ch: string): Promise<boolean> {
    const cur = document.activeElement as HTMLInputElement;
    const before = cur.value;
    cur.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    await nextTick();
    return cur.value !== before;
  }
  async function focusInput(w: ReturnType<typeof mount>): Promise<void> {
    (w.find("input.grid-input").element as HTMLInputElement).focus();
    await nextTick();
  }

  it("**抜けないままタブを切り替えて戻っても、エラー状態のまま**", async () => {
    addSecond();
    const { w } = await mountPane();
    await hostError(201);
    await w.setProps({ sessionId: SID2 });
    await nextTick();
    await w.setProps({ sessionId: SID });
    await nextTick();
    await focusInput(w);
    expect(opmsg(w)).toBe(norm(MSG));
    expect(await typeChanges("3"), "戻ったら文字が入った").toBe(false);
  });

  it("**裏のタブに WEC が届いてから切り替えても、エラー状態に入っている**", async () => {
    addSecond();
    const { w } = await mountPane();
    await w.setProps({ sessionId: SID2 });
    await nextTick();
    // 裏（SID）に WEC
    sessionsStore.updateScreen(SID, snap({ systemMessage: MSG, systemMessageSeq: 202 }));
    await nextTick();
    await w.setProps({ sessionId: SID });
    await nextTick();
    await nextTick();
    await focusInput(w);
    expect(opmsg(w)).toBe(norm(MSG));
    expect(await typeChanges("3")).toBe(false);
  });

  it("**抜けて隠した後にペインを作り直しても、隠したメッセージは戻らない**", async () => {
    const first = await mountPane();
    await hostError(203);
    first.el.focus();
    await first.input.trigger("keydown", { key: "ArrowRight" });
    await nextTick();
    first.w.unmount();
    mounted = mounted.filter((x) => x !== first.w);
    const { w } = await mountPane();
    expect(opmsg(w), "作り直したら隠したメッセージが戻った").toBe("");
    expect(await typeChanges("3"), "隠したのに文字が拒否された").toBe(true);
  });

  it("**新しい画面（CLEAR UNIT）でメッセージが消えたら、エラー状態も解ける**", async () => {
    const { w } = await mountPane();
    await hostError(204);
    // コアは CLEAR UNIT で systemMessage を捨てる（ACS `processClearUnit` の `clearErrorMode`）
    sessionsStore.updateScreen(SID, snap({ lastWrite: { cleared: true, restored: false, cells: 10 } }));
    await nextTick();
    await nextTick();
    await focusInput(w);
    expect(opmsg(w)).toBe("");
    expect(await typeChanges("7"), "サインオン画面等で最初の打鍵が黙って捨てられた").toBe(true);
  });

  it("CLEAR UNIT と WEC が同じレコードで来たら、エラー状態に入る（CLEAR UNIT で隠さない）", async () => {
    const { w } = await mountPane();
    sessionsStore.updateScreen(SID, snap({ systemMessage: MSG, systemMessageSeq: 205, lastWrite: { cleared: true, restored: false, cells: 10 } }));
    await nextTick();
    await nextTick();
    await focusInput(w);
    expect(opmsg(w)).toBe(norm(MSG));
    expect(await typeChanges("7")).toBe(false);
  });
});

describe("操作員エラーと新しい画面", () => {
  it("**CLEAR UNIT の画面が届いたら操作員エラーも抜ける**（ACS `processClearUnit`）", async () => {
    const { w } = await mountPane();
    // 送信の合流点が止めた操作員エラー（セッション側の通知）をペインが引き取ってエラー状態に入る経路
    sessionsStore.get(SID)!.notice = MSG_PROTECTED;
    await nextTick();
    await nextTick();
    expect(opmsg(w), "前提: 操作員エラー").toBe(norm(MSG_PROTECTED));
    sessionsStore.updateScreen(SID, snap({ lastWrite: { cleared: true, restored: false, cells: 10 } }));
    await nextTick();
    await nextTick();
    (w.find("input.grid-input").element as HTMLInputElement).focus();
    await nextTick();
    const cur = document.activeElement as HTMLInputElement;
    cur.dispatchEvent(new KeyboardEvent("keydown", { key: "Q", bubbles: true, cancelable: true }));
    await nextTick();
    expect(cur.value.trim(), "新しい画面で最初の打鍵が拒否された").toBe("Q");
  });

  it("CLEAR UNIT でない画面の更新では、操作員エラーのまま", async () => {
    const { w } = await mountPane();
    sessionsStore.get(SID)!.notice = MSG_PROTECTED;
    await nextTick();
    await nextTick();
    sessionsStore.updateScreen(SID, snap({ lastWrite: { cleared: false, restored: false, cells: 1 } }));
    await nextTick();
    await nextTick();
    (w.find("input.grid-input").element as HTMLInputElement).focus();
    await nextTick();
    const cur = document.activeElement as HTMLInputElement;
    cur.dispatchEvent(new KeyboardEvent("keydown", { key: "Q", bubbles: true, cancelable: true }));
    await nextTick();
    expect(cur.value.trim()).toBe("");
  });
});

/**
 * **エラー中はローカル編集キーも拒否する**（ACS `PS5250.keyDown`。実機の ACS でも Field Exit・Erase EOF・
 * Erase Input・Field±・Dup・Field Mark はどれも欄を変えずエラーのままだった。`scripts/acs-probe/field-exit-full.txt`）
 */
describe("エラー中の編集キー", () => {
  it.each([
    ["Field Exit（Ctrl+Enter）", { key: "Enter", ctrlKey: true }],
    ["Erase EOF（Ctrl+Delete）", { key: "Delete", ctrlKey: true }],
    ["Erase Input（Ctrl+Backspace）", { key: "Backspace", ctrlKey: true }],
    ["Field−（Ctrl+-）", { key: "-", ctrlKey: true }],
    ["Dup（Ctrl+D）", { key: "d", ctrlKey: true }]
  ])("**%s は欄を変えず、エラーのまま**", async (_l, init) => {
    const { w } = await mountPane();
    sessionsStore.updateScreen(SID, snap({ systemMessage: MSG, systemMessageSeq: 301, fields: [{ ...FIELD, value: "ABCDEF" }] }));
    await nextTick();
    await nextTick();
    const el = w.find("input.grid-input").element as HTMLInputElement;
    el.focus();
    el.setSelectionRange(2, 2);
    await nextTick();
    const before = el.value;
    el.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(sessionsStore.get(SID)!.edits.has(1), "エラー中に欄が変わった").toBe(false);
    expect(el.value).toBe(before);
    expect(opmsg(w), "エラーを抜けた").toBe(norm(MSG));
  });
});
