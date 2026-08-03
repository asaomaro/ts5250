import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **自動操作（HLLAPI の `Reserve`）に予約されている間は打てない。**
 *
 * 5250 は入力欄の値を AID と一緒に送る——ブラウザは Enter を押すまで打ちかけを
 * 手元に持っている。その間に自動操作が画面を変えると、打ちかけの行き先が消える。
 *
 * サーバー側でも `SessionManager` が断る（`session-manager.test.ts`）が、
 * **画面側でも止める**。断られてから気づくのでは、なぜ打てないのか分からない。
 */

const COLS = 80;
const cell = (char = " "): Cell =>
  ({
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  }) as Cell;

const fld = (over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field =>
  ({ protected: false, hidden: false, numeric: false, mdt: false, value: "", ...over }) as Field;

function snapOf(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  return {
    sessionId: "s1",
    rows: 24,
    cols: COLS,
    cursor: { row: 5, col: 10 },
    keyboardLocked: false,
    cells,
    fields: [fld({ index: 1, row: 5, col: 10, length: 8 })]
  } as unknown as ScreenSnapshot;
}

describe("EmulatorPane: 予約中は入力を止める", () => {
  const SID = "s1";
  let mounted: ReturnType<typeof mount>[] = [];
  const sent: unknown[] = [];

  function seed(reservedBy?: string): void {
    sent.length = 0;
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    sessionsStore.add({
      sessionId: SID,
      label: "t",
      snapshot: snapOf(),
      edits: new Map(),
      cursor: { row: 5, col: 10 },
      connected: true,
      readOnly: false,
      ...(reservedBy !== undefined ? { reservedBy } : {}),
      client: { send: (m: unknown) => sent.push(m) } as unknown as WsClient
    });
  }
  function mountPane() {
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    mounted.push(w);
    return w;
  }

  beforeEach(() => document.body.replaceChildren());
  afterEach(() => {
    for (const w of mounted) w.unmount();
    mounted = [];
  });

  it("予約が無ければ覆いは出ない", () => {
    seed();
    expect(mountPane().find(".reserved-overlay").exists()).toBe(false);
  });

  it("**予約中は理由を出す**（「入力できません」だけだと不具合と区別できない）", () => {
    seed("HLLAPI");
    const w = mountPane();
    expect(w.find(".reserved-overlay").exists()).toBe(true);
    expect(w.text()).toContain("HLLAPI が自動操作中です");
  });

  /**
   * **対照つきで見る。** 「送らない」だけを検査すると、打鍵がそもそも届いていなくても
   * 通ってしまう（この作業で一度そういう検査を書いた）。
   * 予約が無いときは**送られる**ことを同じ操作で確かめる。
   */
  const pressEnter = async (): Promise<unknown[]> => {
    const w = mountPane();
    await w.find(".screen-wrap").trigger("keydown", { key: "Enter" });
    await nextTick();
    return sent.filter((m) => (m as { type?: string }).type === "key");
  };

  it("予約が無ければキーは送られる（対照）", async () => {
    seed();
    expect(await pressEnter()).toHaveLength(1);
  });

  it("**予約中はキーを送らない**", async () => {
    seed("HLLAPI");
    expect(await pressEnter()).toEqual([]);
  });

  it("**解除の口がある**（自動化が落ちると `Release` が来ない）", async () => {
    seed("HLLAPI");
    const w = mountPane();
    await w.find(".reserved-box button").trigger("click");
    expect(sent).toContainEqual({ type: "reserve-break" });
  });

  it("**予約が始まったら打ちかけを捨てる**（画面を変えずに始まるので `updateScreen` では捨てられない）", () => {
    seed();
    sessionsStore.get(SID)!.edits.set(1, "打ちかけ");
    sessionsStore.setReserved(SID, "HLLAPI");
    expect(sessionsStore.get(SID)!.edits.size).toBe(0);
    expect(sessionsStore.get(SID)!.reservedBy).toBe("HLLAPI");
  });

  it("解除で元に戻る", () => {
    seed("HLLAPI");
    sessionsStore.setReserved(SID, undefined);
    expect(sessionsStore.get(SID)!.reservedBy).toBeUndefined();
    expect(mountPane().find(".reserved-overlay").exists()).toBe(false);
  });
});
