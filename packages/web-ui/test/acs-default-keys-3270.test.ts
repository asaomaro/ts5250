import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import type { ScreenSnapshot, Cell } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **汎用機の 3270 では Attn・SysReq・Help・Print への割り当てを何もしない**（`20260921-acs-default-keys` の節目の点検の指摘）。
 * ACS の既定（Esc＝Attn・Alt+F1＝Help・Ctrl+Pause＝Print）が 3270 のペインにも効き、汎用機ではサーバーが
 * 「key has no 3270 assignment on this host」で拒否して、押すたびにエラーになっていた（以前は割り当てが無く何も起きなかった）。
 * IBM i の 3270 では割り当てがある（`tn3270-adapt.ts` の `IBMI_ONLY`）ので送る。
 */
const cells = (): Cell[][] =>
  Array.from({ length: 24 }, () =>
    Array.from({ length: 80 }, () => ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell)
  );

async function pressAll(ibmI: boolean | undefined): Promise<string[]> {
  const snap: ScreenSnapshot = { sessionId: "s3", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells: cells(), fields: [] };
  const sent: string[] = [];
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: "s3", label: "t", snapshot: snap, edits: new Map(), cursor: { row: 1, col: 1 },
    link: { state: "connected" }, resumability: "resumable", readOnly: false, meta: { terminal: "3270" },
    ...(ibmI !== undefined ? { ibmI3270: ibmI } : {}),
    client: { send: (m: { type: string; key?: string }) => void (m.type === "key" && sent.push(m.key!)) } as unknown as WsClient
  } as never);
  const w = mount(EmulatorPane, { props: { sessionId: "s3", focused: true }, attachTo: document.body });
  await nextTick();
  for (const k of [{ key: "Escape" }, { key: "F1", altKey: true }, { key: "Pause", ctrlKey: true }, { key: "Pause" }]) {
    await w.find(".pane").trigger("keydown", k);
    await nextTick();
    sessionsStore.byId.get("s3")!.busy = false; // 送った後の応答待ちを解く（キーごとに見るため）
    await nextTick();
  }
  w.unmount();
  return sent;
}

beforeEach(() => {
  localStorage.clear();
  keybindingsStore.reload();
  document.body.replaceChildren();
});

describe("3270 のペインの ACS の既定のキー", () => {
  it("**汎用機では Attn・Help・Print を送らない**（Clear は送る）", async () => {
    expect(await pressAll(false)).toEqual(["Clear"]);
  });
  it("IBM i の 3270 では送る（割り当てがある）", async () => {
    expect(await pressAll(true)).toEqual(["Attn", "Help", "Print", "Clear"]);
  });
});
