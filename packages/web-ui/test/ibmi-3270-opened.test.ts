/**
 * **3270 の `opened` の `ibmI` をペインの状態へ写す**（`20260921-acs-default-keys` の節目の点検の指摘への対応）。
 * 汎用機の 3270 では Attn・SysReq・Help・Print の割り当てを送らない（`acs-default-keys-3270.test.ts`）。その判断の元になる
 * 値がここで落ちると、汎用機でも IBM i と見なされて毎回エラーに戻る。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";

let captured: { handlers: { onServerMessage: (m: unknown) => void } };
vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      captured = { handlers };
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";

const screen = (): ScreenSnapshot => ({ sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells: [], fields: [] });

describe("3270 の opened の ibmI", () => {
  beforeEach(() => {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });

  for (const ibmI of [false, true]) {
    it(`ibmI=${ibmI} がそのまま状態に載る`, async () => {
      const p = openSession({ type: "open", host: "h" }, "t", { terminal: "3270" } as never);
      captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: screen(), ibmI });
      await p;
      expect(sessionsStore.get("s1")!.ibmI3270).toBe(ibmI);
    });
  }

  it("5250 の opened には無い（載せない）", async () => {
    const p = openSession({ type: "open", host: "h" }, "t");
    captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: screen() });
    await p;
    expect(sessionsStore.get("s1")!.ibmI3270).toBeUndefined();
  });
});
