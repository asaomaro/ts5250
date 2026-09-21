import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { typeAheadKind } from "../src/composables/useKeymap.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **先打ち（type-ahead）**（`20260921-type-ahead`）。
 *
 * ACS は応答待ち・ホスト施錠の間に打ったキーを溜め、解錠で再生する。実機の ACS（ECL の `SendKeys`）で:
 *  - 施錠中の `ABC` → 解錠後のコマンド行に `ABC`
 *  - 施錠中の `DSPLIBL` + Enter → 解錠後に送られて DSPLIBL の画面
 *  - 施錠中の `XYZ` + Reset → 解錠後は空（捨てられる）。Reset でホストの施錠は解けない
 *  - 施錠中の Enter（連打）→ 解錠後に 2 回目が送られる
 * 以前の当 PJ は施錠中の打鍵を黙って捨てていた（PR #388）。
 */
const SID = "ta1";

function cell(): Cell {
  return {
    char: " ", kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  };
}
const FIELD: Field = {
  index: 1, row: 20, col: 7, length: 40,
  protected: false, hidden: false, numeric: false, mdt: false, value: ""
} as Field;
/** 0020 との絡みを見る右寄せ欄（10 行目） */
const RZ: Field = {
  index: 2, row: 10, col: 20, length: 6, adjust: "right-zero",
  protected: false, hidden: false, numeric: false, mdt: false, value: ""
} as Field;
function snap(keyboardLocked = false, fields: Field[] = [FIELD], cursor = { row: 20, col: 7 }): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return { sessionId: SID, rows: 24, cols: 80, cursor, keyboardLocked, cells, fields };
}
let send: Mock<(m: unknown) => void>;
function seed(s: ScreenSnapshot = snap(), id = SID, clear = true): void {
  if (clear) {
    send = vi.fn<(m: unknown) => void>();
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  }
  sessionsStore.add({
    sessionId: id, label: id, snapshot: { ...s, sessionId: id }, edits: new Map(), cursor: s.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    client: { send: (m: unknown) => send({ ...(m as object), sid: id }) } as unknown as WsClient
  });
}
const st = () => sessionsStore.get(SID)!;
type Sent = { type: string; key: string; sid: string; fields?: { field: number; value: string }[] };
function keysSent(sid = SID): Sent[] {
  return send.mock.calls.map((c) => c[0] as Sent).filter((m) => m.type === "key" && m.sid === sid);
}

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});
beforeEach(() => {
  keybindingsStore.reset();
  seed();
});

async function mountPane() {
  const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const input = w.find("input.grid-input");
  (input.element as HTMLInputElement).focus();
  await nextTick();
  expect(document.activeElement, "前提: 入力欄にフォーカスがある").toBe(input.element);
  return { w, input, el: input.element as HTMLInputElement };
}
/** いまフォーカスのある要素へ打つ（実際の打鍵と同じく、フォーカス先に届く） */
async function press(key: string, opts: KeyboardEventInit = {}) {
  const t = (document.activeElement as HTMLElement) ?? document.body;
  t.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
  await nextTick();
}
async function typeText(text: string) {
  for (const ch of text) await press(ch);
}
/** 再生（次のタスクで始まり、1 キーごとに nextTick を挟む）が流れ終わるまで待つ */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 20; j++) await nextTick();
  }
}
/** 解錠（応答が来た） */
async function unlock(newScreen = false, id = SID) {
  if (newScreen) sessionsStore.updateScreen(id, { ...snap(), sessionId: id });
  sessionsStore.get(id)!.busy = false;
  await settle();
}

describe("typeAheadKind（純関数）", () => {
  const ev = (key: string, m: Partial<Record<"shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "isComposing", boolean>> = {}) => ({
    key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...m
  });
  it.each([
    ["A", {}], ["1", {}], ["Enter", {}], ["Tab", {}], ["ArrowLeft", {}], ["F3", {}], ["Backspace", {}],
    ["Delete", {}], ["PageDown", {}], ["ArrowLeft", { ctrlKey: true }]
  ] as const)("%s %o は溜める", (key, m) => {
    expect(typeAheadKind(ev(key, m))).toBe("hold");
  });
  it.each([
    ["c", { ctrlKey: true }], ["Shift", {}], ["Control", { ctrlKey: true }], ["Process", {}],
    ["a", { isComposing: true }], ["PageUp", { altKey: true, shiftKey: true }]
  ] as const)("%s %o は溜めない（端末のキーではない）", (key, m) => {
    expect(typeAheadKind(ev(key, m))).toBe("pass");
  });
  it("割り当てた Attn / SysReq は flag（溜めを捨てて通す）", () => {
    keybindingsStore.set("F13", "Attn");
    expect(typeAheadKind(ev("F13"))).toBe("flag");
  });
  it("割り当てたローカル編集キー（Ctrl+Enter の Field Exit 等）は溜める", () => {
    keybindingsStore.set("Ctrl+Enter", "local:field-exit");
    expect(typeAheadKind(ev("Enter", { ctrlKey: true }))).toBe("hold");
  });
});

describe("施錠中の打鍵を溜めて、解錠で再生する", () => {
  it("**応答待ちの間に打った文字が、解錠後に欄へ入る**", async () => {
    const { el } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("ABC");
    expect(el.value.trim(), "施錠中に欄へ入った").toBe("");
    await unlock();
    expect(el.value.trim()).toBe("ABC");
  });

  it("**ホスト施錠（keyboardLocked）でも溜める**", async () => {
    const { el } = await mountPane();
    st().snapshot = snap(true);
    await nextTick();
    await typeText("AB");
    expect(el.value.trim()).toBe("");
    st().snapshot = snap(false);
    await settle();
    expect((document.activeElement as HTMLInputElement).value.trim()).toBe("AB");
  });

  it("**溜めた Enter は解錠後に送られ、打った値が載る**", async () => {
    await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("DSPLIBL");
    await press("Enter");
    expect(keysSent(), "施錠中に送った").toEqual([]);
    await unlock();
    const k = keysSent();
    expect(k.map((m) => m.key)).toEqual(["Enter"]);
    expect(k[0]!.fields).toEqual([{ field: 1, value: "DSPLIBL" }]);
  });

  it("**AID を再生して施錠したら止め、残りは次の解錠で続きから**", async () => {
    await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("AB");
    await press("Enter");
    await typeText("CD");
    await unlock();
    expect(keysSent().map((m) => m.key)).toEqual(["Enter"]);
    expect(st().busy, "前提: Enter で再び応答待ち").toBe(true);
    // 新しい画面が来て解錠 → 残りの CD が新しい画面の欄へ
    await unlock(true);
    expect((document.activeElement as HTMLInputElement).value.trim()).toBe("CD");
  });

  it("**Enter の連打の 2 回目も送られる**（実機 ACS の場合 4）", async () => {
    await mountPane();
    await press("Enter");
    expect(keysSent().length, "前提: 1 回目は送られた").toBe(1);
    await press("Enter");
    expect(keysSent().length, "施錠中に送った").toBe(1);
    await unlock(true);
    expect(keysSent().map((m) => m.key)).toEqual(["Enter", "Enter"]);
  });
});

describe("溜めを捨てる／溜めない", () => {
  it("**Insert は溜めずにその場で切り替わる**（ACS は `[insert]` を溜めない）", async () => {
    const { w } = await mountPane();
    st().busy = true;
    await nextTick();
    await press("Insert");
    expect(w.find(".mode").text(), "施錠中に Insert が効いていない").toBe("挿入");
    // 新しい画面で上書きへ戻り、そのあと溜めた Insert が効いて挿入へ戻ったりしない
    await unlock(true);
    expect(w.find(".mode").text()).toBe("上書き");
  });

  it("**Reset（左 Ctrl 単独）で捨てる**（実機 ACS の場合 3）", async () => {
    const { el } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("XYZ");
    await press("Control", { code: "ControlLeft", ctrlKey: true });
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", bubbles: true })
    );
    await unlock();
    expect(el.value.trim(), "Reset の後に再生された").toBe("");
  });

  it("**割り当てた Attn で捨て、Attn 自体は送る**", async () => {
    keybindingsStore.set("F13", "Attn");
    const { el } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("XYZ");
    await press("F13");
    expect(keysSent().map((m) => m.key)).toEqual(["Attn"]);
    await unlock();
    expect(el.value.trim()).toBe("");
  });

  it("**自動操作の予約中は溜めない**（利用者の打鍵を他人の画面へ流さない）", async () => {
    const { el } = await mountPane();
    st().busy = true;
    st().reservedBy = "agent";
    await nextTick();
    await typeText("XYZ");
    delete st().reservedBy;
    await unlock();
    expect(el.value.trim()).toBe("");
  });

  it("**切断したら捨てる**", async () => {
    const { el } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("XYZ");
    sessionsStore.markLost(SID, "transport");
    await nextTick();
    sessionsStore.markConnected(SID);
    await unlock();
    expect(el.value.trim()).toBe("");
  });
});

describe("独立点検の指摘（セッション・フォーカス・再生中の状態）", () => {
  it("**同じペインでタブを切り替えても、溜めは別のセッションへ流れない**", async () => {
    seed(snap(), "B", false);
    const { w } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("4");
    await press("Enter");
    // タブ B へ（ペインは使い回され、sessionId だけが替わる）
    await w.setProps({ sessionId: "B" });
    await settle();
    expect(keysSent("B"), "A で打った Enter が B へ送られた").toEqual([]);
    expect((document.activeElement as HTMLInputElement).value?.trim() ?? "", "A の打鍵が B の欄に入った").toBe("");
    // A に戻り、A が解錠したら A へ流れる
    await w.setProps({ sessionId: SID });
    await nextTick();
    (w.find("input.grid-input").element as HTMLInputElement).focus();
    await unlock();
    expect(keysSent().map((m) => m.key)).toEqual(["Enter"]);
    expect(keysSent()[0]!.fields).toEqual([{ field: 1, value: "4" }]);
  });

  it("**よそのペインにフォーカスがある間は流さず、戻ってきたら流す**", async () => {
    const { w, el } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("AB");
    await w.setProps({ focused: false });
    await unlock();
    expect(el.value.trim(), "フォーカスの無いペインで流した").toBe("");
    await w.setProps({ focused: true });
    el.focus();
    await settle();
    expect(el.value.trim()).toBe("AB");
  });

  it("**解錠から再生までの間に打ったキーは、溜めの後ろに入る**（追い越さない）", async () => {
    const { el } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("AB");
    st().busy = false;
    await nextTick(); // 再生（次のタスク）より先に打つ
    await press("C");
    await settle();
    expect(el.value.trim()).toBe("ABC");
  });

  it("**予約が始まったら溜めを捨てる**", async () => {
    const { el } = await mountPane();
    st().busy = true;
    await nextTick();
    await typeText("XYZ");
    sessionsStore.setReserved(SID, "agent");
    sessionsStore.setReserved(SID, undefined);
    await unlock();
    expect(el.value.trim()).toBe("");
  });

  it("**再生中の Tab で欄を出れば、続く Enter は 0020 にならない**", async () => {
    seed(snap(false, [RZ, FIELD], { row: 10, col: 20 }));
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    (w.findAll("input.grid-input")[0]!.element as HTMLInputElement).focus();
    await nextTick();
    st().busy = true;
    await nextTick();
    await typeText("12");
    await press("Tab");
    await press("Enter");
    await unlock();
    expect(keysSent().map((m) => m.key), "Tab で出たのに 0020 で止まった").toEqual(["Enter"]);
  });

  it("**再生中に 0020 が出たら、続く文字はエラー中として拒否される**", async () => {
    seed(snap(false, [RZ, FIELD], { row: 10, col: 20 }));
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();
    const rz = w.findAll("input.grid-input")[0]!.element as HTMLInputElement;
    rz.focus();
    await nextTick();
    st().busy = true;
    await nextTick();
    await typeText("12");
    await press("Enter");
    await typeText("3");
    await unlock();
    expect(keysSent(), "0020 なのに送った").toEqual([]);
    expect(rz.value.trim(), "エラー中の文字が入った").toBe("12");
  });

  it("**キー一覧（パレット）のキーも溜める**", async () => {
    const { w, el } = await mountPane();
    st().busy = true;
    await nextTick();
    w.findComponent({ name: "StatusBar" }).vm.$emit("combo", { key: "Q" });
    await nextTick();
    expect(el.value.trim()).toBe("");
    await unlock();
    expect(el.value.trim()).toBe("Q");
  });

  it("**タブを切り替えたら、前のセッションの操作員エラーを持ち越さない**", async () => {
    seed(snap(), "B", false);
    const { w } = await mountPane();
    w.findComponent({ name: "ScreenGrid" }).vm.$emit("notice", "カーソルが保護された区域にあるため入力できません");
    await nextTick();
    expect(w.find(".opmsg").exists(), "前提: エラーが出た").toBe(true);
    await w.setProps({ sessionId: "B" });
    await nextTick();
    const b = w.find("input.grid-input").element as HTMLInputElement;
    b.focus();
    await nextTick();
    await press("Z");
    expect(b.value.trim(), "A のエラーで B の打鍵が拒否された").toBe("Z");
  });

  it("**ホストへ繋ぎ直している間の打鍵は溜めない**（送り先が無い。ACS も捨てる）", async () => {
    const { el } = await mountPane();
    st().hostReconnect = { attempt: 1 };
    st().snapshot = snap(true);
    await nextTick();
    await typeText("AB");
    delete st().hostReconnect;
    st().snapshot = snap(false);
    await settle();
    expect(el.value.trim(), "繋ぎ直し中の打鍵が再生された").toBe("");
  });
});
