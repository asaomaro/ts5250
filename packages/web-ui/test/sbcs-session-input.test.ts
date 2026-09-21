import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **セッションの CCSID で、打鍵の幅の判定が分かれる**（`20260921-monocase-non-ascii`）。
 * SBCS だけのセッション（37）では `é` `ü` `ß` を打てる（ACS `PS5250.inputChar` は DBCS のセッションでなければ幅を見ない。
 * 実機の ACS のコアでも入った）。DBCS のセッション（930）と CCSID が分からないときは従来どおり全角として弾く。
 */
const cell = (): Cell =>
  ({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

beforeEach(() => document.body.replaceChildren());

async function typed(ccsid: number | undefined, text: string): Promise<string | undefined> {
  const f: Field = { index: 1, row: 5, col: 10, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
  const snap: ScreenSnapshot = {
    sessionId: "s1", rows: 24, cols: 80, cursor: { row: 5, col: 10 }, keyboardLocked: false,
    cells: Array.from({ length: 24 }, () => Array.from({ length: 80 }, cell)), fields: [f]
  };
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: "s1", label: "t", snapshot: snap, edits: new Map(), cursor: { row: 5, col: 10 },
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    ...(ccsid !== undefined ? { ccsid } : {}),
    client: { send: () => {} } as unknown as WsClient
  });
  const w = mount(EmulatorPane, { props: { sessionId: "s1", focused: true }, attachTo: document.body });
  await nextTick();
  const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  el.focus();
  el.setSelectionRange(0, 0);
  for (const ch of text) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    await nextTick();
  }
  const v = sessionsStore.byId.get("s1")!.edits.get(1);
  w.unmount();
  return v?.replace(/ +$/, "");
}

describe("SBCS のセッションの打鍵", () => {
  it("**37 では `é` `ü` `ß` を打てる**", async () => {
    expect(await typed(37, "aéüß")).toBe("aéüß");
  });
  it("930（DBCS のセッション）では従来どおり全角として弾く", async () => {
    expect(await typed(930, "Aé")).toBe("A");
  });
  it("CCSID が分からなければ従来どおり（DBCS と同じ扱い）", async () => {
    expect(await typed(undefined, "aé")).toBe("a");
  });
});
