import { describe, it, expect, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import VtPane from "../src/components/VtPane.vue";
import { vtStore } from "../src/stores/vt.js";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import type { WsVtFrame } from "@ts5250/server";

/**
 * VT のペイン。**5250 とは入力の作法が根本的に違う**ので、
 * 「打鍵がそのまま送られるか」「ブラウザに食われないか」をここで固定する。
 */
const ids: string[] = [];
const sent: Record<string, unknown>[] = [];

afterEach(() => {
  for (const id of ids.splice(0)) {
    sessionsStore.remove(id);
    vtStore.remove(id);
  }
  sent.length = 0;
});

function open(over: Partial<WsVtFrame> = {}, opts: { readOnly?: boolean } = {}) {
  const id = `vt-${ids.length}`;
  ids.push(id);
  vtStore.create(
    id,
    {
      rows: 3,
      cols: 20,
      cursor: { row: 0, col: 0, visible: true },
      alternate: false,
      title: "",
      styles: [],
      lines: [],
      ...over
    },
    { encoding: "utf-8", ibmI: false, hostEchoes: true }
  );
  sessionsStore.add({
    sessionId: id,
    label: "vt",
    snapshot: undefined,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: opts.readOnly ?? false,
    client: { send: (m: Record<string, unknown>) => sent.push(m) },
    meta: { terminal: "vt" }
  } as unknown as SessionState);
  return { id, w: mount(VtPane, { props: { sessionId: id, focused: true } }) };
}

describe("描画", () => {
  it("行がそのまま出る", () => {
    const { w } = open({ lines: [{ row: 0, runs: [{ col: 0, text: "hello" }] }] });
    expect(w.text()).toContain("hello");
    w.unmount();
  });

  it("**履歴と画面が 1 本の流れで並ぶ**", async () => {
    const { id, w } = open({ lines: [{ row: 0, runs: [{ col: 0, text: "now" }] }] });
    vtStore.apply(id, {
      rows: 3, cols: 20, cursor: { row: 0, col: 0, visible: true },
      alternate: false, title: "", styles: [], lines: [],
      scrollback: [[{ col: 0, text: "past" }]]
    });
    await w.vm.$nextTick();
    expect(w.text()).toContain("past");
    expect(w.text()).toContain("now");
    w.unmount();
  });

  it("**代替画面では履歴を出さない**", async () => {
    const { id, w } = open();
    vtStore.apply(id, {
      rows: 3, cols: 20, cursor: { row: 0, col: 0, visible: true },
      alternate: false, title: "", styles: [], lines: [],
      scrollback: [[{ col: 0, text: "past" }]]
    });
    await w.vm.$nextTick();
    expect(w.text()).toContain("past");
    vtStore.apply(id, {
      rows: 3, cols: 20, cursor: { row: 0, col: 0, visible: true },
      alternate: true, title: "", styles: [],
      lines: [{ row: 0, runs: [{ col: 0, text: "vi" }] }]
    });
    await w.vm.$nextTick();
    expect(w.text()).not.toContain("past");
    w.unmount();
  });

  it("色が付く（256 色は計算で出す）", () => {
    const { w } = open({
      styles: [{ fg: { kind: "indexed", index: 208 } }],
      lines: [{ row: 0, runs: [{ col: 0, text: "O", s: 0 }] }]
    });
    const span = w.findAll("span").find((s) => s.text() === "O");
    // 16 (55,0,0) から数えて 208 → rgb(255,135,0)
    expect(span?.attributes("style")).toContain("rgb(255, 135, 0)");
    w.unmount();
  });

  it("16 色は CSS 変数（テーマに追随させる）", () => {
    const { w } = open({
      styles: [{ fg: { kind: "indexed", index: 1 } }],
      lines: [{ row: 0, runs: [{ col: 0, text: "R", s: 0 }] }]
    });
    const span = w.findAll("span").find((s) => s.text() === "R");
    expect(span?.attributes("style")).toContain("var(--vt-c1)");
    w.unmount();
  });

  it("**反転は色を入れ替えて解決する**（既定色でも効くように）", () => {
    const { w } = open({
      styles: [{ reverse: true }],
      lines: [{ row: 0, runs: [{ col: 0, text: "V", s: 0 }] }]
    });
    const style = w.findAll("span").find((s) => s.text() === "V")?.attributes("style") ?? "";
    expect(style).toContain("var(--vt-bg)");
    expect(style).toContain("var(--vt-fg)");
    w.unmount();
  });

  it("桁の隙間は字下げで表す", () => {
    const { w } = open({
      lines: [{ row: 0, runs: [{ col: 0, text: "A" }, { col: 5, text: "B" }] }]
    });
    const b = w.findAll("span").find((s) => s.text() === "B");
    expect(b?.attributes("style")).toContain("padding-left: 4ch");
    w.unmount();
  });

  it("**全角のあとの字下げが桁で計算される**", () => {
    const { w } = open({
      lines: [{ row: 0, runs: [{ col: 0, text: "あ" }, { col: 4, text: "X" }] }]
    });
    // あ は 2 桁 → 隙間は 4-2 = 2ch
    const x = w.findAll("span").find((s) => s.text() === "X");
    expect(x?.attributes("style")).toContain("padding-left: 2ch");
    w.unmount();
  });
});

describe("打鍵", () => {
  it("文字はそのまま送る", async () => {
    const { w } = open();
    await w.trigger("keydown", { key: "a" });
    expect(sent).toEqual([{ type: "vt-input", text: "a" }]);
    w.unmount();
  });

  it("名前つきのキーは意味のまま送る（符号化はサーバー）", async () => {
    const { w } = open();
    await w.trigger("keydown", { key: "ArrowUp" });
    expect(sent[0]).toMatchObject({ type: "vt-input", key: "ArrowUp" });
    w.unmount();
  });

  it("**Tab はブラウザに食わせない**（端末へ渡す）", async () => {
    const { w } = open();
    const e = { key: "Tab", preventDefault: vi.fn() };
    await w.trigger("keydown", e);
    expect(sent[0]).toMatchObject({ key: "Tab" });
    w.unmount();
  });

  it("Ctrl つきの文字を送る", async () => {
    const { w } = open();
    await w.trigger("keydown", { key: "c", ctrlKey: true });
    expect(sent[0]).toMatchObject({ text: "c", ctrl: true });
    w.unmount();
  });

  it("**Ctrl+Shift+C / V は通す**（コピー・貼り付けの逃げ道）", async () => {
    const { w } = open();
    await w.trigger("keydown", { key: "C", ctrlKey: true, shiftKey: true });
    await w.trigger("keydown", { key: "V", ctrlKey: true, shiftKey: true });
    expect(sent).toEqual([]);
    w.unmount();
  });

  it("**IME の変換中は送らない**（確定前の文字が流れる）", async () => {
    const { w } = open();
    await w.trigger("compositionstart");
    await w.trigger("keydown", { key: "a" });
    expect(sent).toEqual([]);
    await w.trigger("compositionend", { data: "あい" });
    expect(sent).toEqual([{ type: "vt-input", text: "あい" }]);
    w.unmount();
  });

  it("読み取り専用のセッションでは送らない", async () => {
    const { w } = open({}, { readOnly: true });
    await w.trigger("keydown", { key: "a" });
    expect(sent).toEqual([]);
    w.unmount();
  });

  it("切断後は送らない", async () => {
    const { id, w } = open();
    const s = sessionsStore.get(id);
    if (s) s.connected = false;
    await w.trigger("keydown", { key: "a" });
    expect(sent).toEqual([]);
    w.unmount();
  });
});

describe("案内", () => {
  it("切断されたら出す", async () => {
    const { id, w } = open();
    vtStore.setConnected(id, false);
    await w.vm.$nextTick();
    expect(w.text()).toContain("切断されました");
    w.unmount();
  });

  it("**理由が来ていたら添えて出す**（真っ白な画面と 5 文字だけにしない）", async () => {
    const { id, w } = open();
    vtStore.setConnected(id, false, "IBM i と交渉できたが画面が届かないまま閉じました");
    await w.vm.$nextTick();
    expect(w.text()).toContain("画面が届かないまま閉じました");
    w.unmount();
  });

  it("**ホストがエコーを返していないことを言う**（打っても出ない理由が分かるように）", async () => {
    const id = "vt-noecho";
    ids.push(id);
    vtStore.create(
      id,
      { rows: 2, cols: 10, cursor: { row: 0, col: 0, visible: true }, alternate: false, title: "", styles: [], lines: [] },
      { encoding: "utf-8", ibmI: false, hostEchoes: false }
    );
    sessionsStore.add({
      sessionId: id, label: "vt", snapshot: undefined, edits: new Map(),
      cursor: { row: 1, col: 1 }, connected: true, readOnly: false,
      client: { send: () => undefined }, meta: { terminal: "vt" }
    } as unknown as SessionState);
    const w = mount(VtPane, { props: { sessionId: id, focused: true } });
    expect(w.text()).toContain("エコー");
    w.unmount();
  });
});
