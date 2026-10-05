/**
 * **ページを離れるときに、開いているセッションを閉じる**（`closeAllOnPageHide`）。
 * ソケットが生きているものは `{type:"close"}`、生きていないもの（心拍が途絶えて切れていた・繋ぎ直し中）は `sendBeacon`
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const clients: { id: string; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    close = vi.fn();
    constructor() {
      clients.push({ id: "", send: this.send, close: this.close });
    }
    connect() {
      return Promise.resolve();
    }
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { closeAllOnPageHide } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";

type FakeSession = { sessionId: string; connected: boolean; client: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } };
const fake = (sessionId: string, connected: boolean): FakeSession => ({ sessionId, connected, client: { send: vi.fn(), close: vi.fn() } });

describe("closeAllOnPageHide", () => {
  const beacon = vi.fn();
  let all: FakeSession[] = [];
  beforeEach(() => {
    beacon.mockReset();
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    all = [fake("live", true), fake("lost", false)];
    vi.spyOn(sessionsStore, "all", "get").mockReturnValue(all as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("繋がっているセッションは WebSocket で close を送ってから閉じる。sendBeacon は使わない", () => {
    closeAllOnPageHide();
    expect(all[0]!.client.send).toHaveBeenCalledWith({ type: "close" });
    expect(all[0]!.client.close).toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalledWith("/api/sessions/live/close");
  });

  it("**繋がっていないセッションは sendBeacon で HTTP の口へ**（WebSocket では届かない）", () => {
    closeAllOnPageHide();
    expect(all[1]!.client.send).not.toHaveBeenCalled();
    expect(beacon).toHaveBeenCalledWith("/api/sessions/lost/close");
  });

  it("**ページキャッシュへ入る（persisted）なら何もしない**（戻ったとき画面だけ残るのを避ける）", () => {
    closeAllOnPageHide({ persisted: true });
    expect(all[0]!.client.send).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it("sendBeacon が無い・投げる環境でも例外にしない", () => {
    vi.stubGlobal("navigator", {});
    expect(() => closeAllOnPageHide()).not.toThrow();
    vi.stubGlobal("navigator", { sendBeacon: () => { throw new Error("x"); } });
    expect(() => closeAllOnPageHide()).not.toThrow();
  });

  it("セッションが無ければ何もしない", () => {
    vi.spyOn(sessionsStore, "all", "get").mockReturnValue([] as never);
    closeAllOnPageHide();
    expect(beacon).not.toHaveBeenCalled();
  });
});

describe("入口での配線", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  for (const entry of ["main.ts", "embed.ts"]) {
    it(`${entry} が pagehide で closeAllOnPageHide を呼ぶ`, () => {
      expect(readFileSync(join(src, entry), "utf8")).toMatch(/addEventListener\("pagehide", closeAllOnPageHide\)/);
    });
  }
});
