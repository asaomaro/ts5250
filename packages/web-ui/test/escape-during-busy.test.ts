import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import type { ScreenSnapshot, Cell } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **待たされている時だけ逃げ道が消える**のを塞ぐ（`20260726-attn-sysreq-cancel-invite` の積み残し）。
 *
 * 画面は期限を設けずに待つようになった（#388）ので、固まった要求から抜ける口は
 * Attn / SysReq しか無い。core（`session.sendAid`）も ws（`ws-handler.onKey`）も施錠中の
 * フラグキーを通すようにしてあったが、**画面側の `EmulatorPane.onKeydown` が
 * `inputBlocked` で全キーを `preventDefault` していた**ため、
 *
 *   - キー設定で割り当てた Attn / SysReq が通信中だけ効かない
 *   - システム要求行に「2」（前の要求の終了）を打てない——空の SysReq を送って
 *     メニューを出してから選ぶ 2 手になる
 *
 * という状態だった（実機で確認。`scripts/verify-browser-escape-during-wait.mjs`）。
 */

function cells(): Cell[][] {
  const out: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) {
      row.push({
        char: " ",
        kind: "sbcs",
        color: "green",
        reverse: false,
        underline: false,
        blink: false,
        columnSeparator: false,
        nonDisplay: false
      });
    }
    out.push(row);
  }
  return out;
}

const SID = "esc1";

/** 通信中（`busy`）のセッションを 1 本置く。`send` の呼ばれ方で判定する */
function seed(busy: boolean): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  const snapshot: ScreenSnapshot = {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 3, col: 5 },
    keyboardLocked: false,
    cells: cells(),
    fields: []
  } as unknown as ScreenSnapshot;
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot,
    edits: new Map(),
    cursor: { row: 3, col: 5 },
    connected: true,
    readOnly: false,
    busy,
    loading: busy,
    client: { send } as unknown as WsClient
  });
  return send;
}

const mountPane = () =>
  mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });

/** ホストへ送った AID だけを見る。打鍵のたびに在席の合図（`activity`）も流れるため */
const keysSent = (send: ReturnType<typeof vi.fn>): { key?: string }[] =>
  send.mock.calls.map((c) => c[0] as { type: string; key?: string }).filter((m) => m.type === "key");

describe("応答待ちの最中でも Attn / SysReq で抜けられる", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    keybindingsStore.reset();
  });

  it("通信中でも、割り当てた Attn は送れる", async () => {
    keybindingsStore.set("F13", "Attn");
    const send = seed(true);
    const w = mountPane();
    await w.find(".pane").trigger("keydown", { key: "F13" });
    expect(keysSent(send)).toEqual([expect.objectContaining({ key: "Attn" })]);
    w.unmount();
  });

  it("通信中でも、割り当てた SysReq はシステム要求行を開く（送信は行の確定時）", async () => {
    keybindingsStore.set("F14", "SysReq");
    const send = seed(true);
    const w = mountPane();
    await w.find(".pane").trigger("keydown", { key: "F14" });
    await nextTick();
    expect(w.find(".sysreq").exists()).toBe(true);
    expect(keysSent(send)).toEqual([]); // 押した時点では送らない（実機・ACS の動き）
    w.unmount();
  });

  it("通信中でも、システム要求行への打鍵はプロテクトに潰されない", async () => {
    keybindingsStore.set("F14", "SysReq");
    seed(true);
    const w = mountPane();
    await w.find(".pane").trigger("keydown", { key: "F14" });
    await nextTick();
    // 行の中で起きたキーは**ペインが preventDefault しない**（潰すと「2」が入らない）
    const ev = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
    w.find(".sysreq .inp").element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    w.unmount();
  });

  it("通信中の普通のキーは従来どおりプロテクトする", async () => {
    const send = seed(true);
    const w = mountPane();
    await w.find(".pane").trigger("keydown", { key: "F3" });
    expect(keysSent(send)).toEqual([]);
    w.unmount();
  });

  it("通信中でなければ、システム要求行の外の打鍵は従来どおり処理する", async () => {
    const send = seed(false);
    const w = mountPane();
    await w.find(".pane").trigger("keydown", { key: "F3" });
    expect(keysSent(send)).toEqual([expect.objectContaining({ key: "F3" })]);
    w.unmount();
  });
});
