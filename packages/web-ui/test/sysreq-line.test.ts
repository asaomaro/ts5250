import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import StatusBar from "../src/components/StatusBar.vue";
import SysReqLine from "../src/components/SysReqLine.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import type { Cell, Field, ScreenSnapshot } from "@as400web/core";
import type { WsClient } from "../src/ws-client.js";

/**
 * システム要求行（SysReq）の振る舞い。
 *
 * 要点は **「SysReq を押しただけでは 1 バイトも送らない」**こと。実機・ACS は画面下部の入力行で
 * 確定して初めて SRQ レコードを送り、その文字列がレコードのデータになる。押した瞬間に送る実装だと
 * オプション（2=前の要求の終了 / 6=システム操作員メッセージ 等）を選ぶ機会が無くなる。
 */

const SID = "srq1";

function cell(ch = " "): Cell {
  return {
    char: ch,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

function snap(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  const fields: Field[] = [
    { index: 1, row: 20, col: 7, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
  ];
  return {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 20, col: 7 },
    keyboardLocked: false,
    cells,
    fields
  } as ScreenSnapshot;
}

function seed(send: (m: unknown) => void): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot: snap(),
    edits: new Map(),
    cursor: { row: 20, col: 7 },
    connected: true,
    readOnly: false,
    client: { send } as unknown as WsClient
  });
}

/** 送信メッセージから 5250 のキー送信だけを拾う */
function keyMessages(send: ReturnType<typeof vi.fn>): { key: string; sysReqText?: string }[] {
  return send.mock.calls
    .map((c) => c[0] as { type?: string; key?: string; sysReqText?: string })
    .filter((m): m is { type: "key"; key: string; sysReqText?: string } => m.type === "key");
}

beforeEach(() => {
  keybindingsStore.reset();
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("SysReqLine 単体", () => {
  it("open で入力欄が現れフォーカスされる", async () => {
    const w = mount(SysReqLine, { props: { open: false }, attachTo: document.body });
    expect(w.find("input").exists()).toBe(false);
    await w.setProps({ open: true });
    await nextTick();
    expect(w.find("input").exists()).toBe(true);
    expect(document.activeElement).toBe(w.find("input").element);
    w.unmount();
  });

  it("実行キーで submit、Esc で cancel を出す", async () => {
    const w = mount(SysReqLine, { props: { open: true }, attachTo: document.body });
    await nextTick();
    const inp = w.find("input");
    await inp.setValue("6");
    await inp.trigger("keydown", { key: "Enter" });
    expect(w.emitted("submit")).toEqual([["6"]]);
    await inp.trigger("keydown", { key: "Escape" });
    expect(w.emitted("cancel")).toHaveLength(1);
    w.unmount();
  });

  it("閉じると入力値を捨てる（次に開いたとき前回の文字が残らない）", async () => {
    const w = mount(SysReqLine, { props: { open: true }, attachTo: document.body });
    await nextTick();
    await w.find("input").setValue("90");
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    await nextTick();
    expect((w.find("input").element as HTMLInputElement).value).toBe("");
    w.unmount();
  });
});

describe("EmulatorPane のシステム要求行", () => {
  it("SysReq のキーバインドは行を開くだけで、ホストへは何も送らない", async () => {
    const send = vi.fn();
    seed(send);
    keybindingsStore.set("Escape", "SysReq"); // 利用者が Esc に割り当てた想定
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    await w.find(".pane").trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(true);
    expect(keyMessages(send)).toHaveLength(0); // ← 押しただけでは送らない
    w.unmount();
  });

  it("Esc で取り消すと 1 度も送らずに行が閉じる", async () => {
    const send = vi.fn();
    seed(send);
    keybindingsStore.set("Escape", "SysReq");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Escape" });
    await nextTick();

    await w.find(".sysreq input").trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(false);
    expect(keyMessages(send)).toHaveLength(0);
    w.unmount();
  });

  it("実行キーで確定すると SysReq を打った文字列付きで送る", async () => {
    const send = vi.fn();
    seed(send);
    keybindingsStore.set("Escape", "SysReq");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "Escape" });
    await nextTick();

    const inp = w.find(".sysreq input");
    await inp.setValue("6");
    await inp.trigger("keydown", { key: "Enter" });
    await nextTick();

    expect(w.find(".sysreq").exists()).toBe(false);
    expect(keyMessages(send)).toEqual([expect.objectContaining({ key: "SysReq", sysReqText: "6" })]);
    w.unmount();
  });

  /**
   * 入力欄は `.pane` の子なので keydown がペインまでバブルする。
   * 素通しすると行の確定と 5250 の AID 送信が二重に走る（実行キーが最も危ない）。
   */
  it("行が開いている間は 5250 のキー処理が止まる（F キーが飛ばない）", async () => {
    const send = vi.fn();
    seed(send);
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    // フッターの SysReq ボタンから開く（キー設定を触らない導線）
    const btn = w.findAll("button.fk").find((b) => b.text().includes("SysReq"));
    expect(btn).toBeDefined();
    await btn!.trigger("click");
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(true);

    await w.find(".pane").trigger("keydown", { key: "F3" });
    await w.find(".pane").trigger("keydown", { key: "Enter" });
    expect(keyMessages(send)).toHaveLength(0);
    w.unmount();
  });

  /**
   * **端末が固まって見える事故の回帰テスト**（review R1）。
   * `ScreenGrid` は新しい画面が来るたび `focusCursorField()` で入力欄へフォーカスを移す。
   * 行を出している最中にホスト発の非同期プッシュが来ると caret が行の外へ飛ぶ一方、
   * ペインは行が開いている間キー処理を止めるので、そのままではキーボードがどこにも効かなくなる。
   */
  it("ホスト画面がプッシュされてもシステム要求行がフォーカスを保つ", async () => {
    const send = vi.fn();
    seed(send);
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const btn = w.findAll("button.fk").find((b) => b.text().includes("SysReq"));
    await btn!.trigger("click");
    await nextTick();
    const inp = w.find(".sysreq input").element as HTMLInputElement;
    expect(document.activeElement).toBe(inp);

    // ホストが新しい画面を push（ScreenGrid が入力欄へフォーカスを移そうとする）
    sessionsStore.get(SID)!.snapshot = snap();
    await nextTick();
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));

    expect(w.find(".sysreq").exists()).toBe(true);
    expect(document.activeElement).toBe(inp); // 行が取り戻している
    w.unmount();
  });

  /**
   * タブ・ペイン切替（Alt+PageUp/Down・Alt+矢印）は App のグローバルハンドラが担うため、
   * 行を開いていても発火する。畳まないと離れたペインの行がフォーカスを引き戻し、
   * 切替先のペインがキーボードを取れなくなる（review R2）。
   */
  it("ペインがフォーカスを失ったら行を畳む（＝取り消し扱い・何も送らない）", async () => {
    const send = vi.fn();
    seed(send);
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const btn = w.findAll("button.fk").find((b) => b.text().includes("SysReq"));
    await btn!.trigger("click");
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(true);

    await w.setProps({ focused: false }); // 別タブ / 別ペインへ移った
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(false);
    expect(keyMessages(send)).toHaveLength(0);
    w.unmount();
  });

  it("切断されたら行を畳む", async () => {
    const send = vi.fn();
    seed(send);
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const btn = w.findAll("button.fk").find((b) => b.text().includes("SysReq"));
    await btn!.trigger("click");
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(true);

    sessionsStore.get(SID)!.connected = false;
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(false);
    w.unmount();
  });
});

describe("StatusBar の Attn / SysReq ボタン", () => {
  function stateOf(send: (m: unknown) => void) {
    seed(send);
    return sessionsStore.get(SID)!;
  }

  it("Attn は即座にホストへ送る", async () => {
    const send = vi.fn();
    const w = mount(StatusBar, { props: { state: stateOf(send) } });
    const btn = w.findAll("button.fk").find((b) => b.text().includes("Attn"));
    expect(btn).toBeDefined();
    await btn!.trigger("click");
    expect(keyMessages(send)).toEqual([expect.objectContaining({ key: "Attn" })]);
  });

  it("SysReq は送らずに sysreq を emit する（行を開くのは親の仕事）", async () => {
    const send = vi.fn();
    const w = mount(StatusBar, { props: { state: stateOf(send) } });
    const btn = w.findAll("button.fk").find((b) => b.text().includes("SysReq"));
    expect(btn).toBeDefined();
    await btn!.trigger("click");
    expect(w.emitted("sysreq")).toHaveLength(1);
    expect(keyMessages(send)).toHaveLength(0);
  });
});
