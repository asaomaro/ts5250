import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PublicSession, PublicSystem } from "@ts5250/server";

/**
 * **端末の種類を開く指示へ載せること。**
 *
 * `terminal: "3270"` が付かないと、サーバーは 5250 として開いてしまう
 * ——ホストは 3270 のつもりで待っているので、**画面が出ないまま黙る**という
 * 一番読みにくい壊れ方になる。配線をここで固定する。
 */
const openSession = vi.fn((...args: unknown[]): Promise<string> => {
  void args;
  return Promise.resolve("s-1");
});
vi.mock("../src/session-controller.js", () => ({
  openPrinterSession: () => Promise.resolve("p-1"),
  openSession: (...a: unknown[]) => openSession(...a)
}));

import { systemsStore } from "../src/stores/systems.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { useOpenConfigured } from "../src/composables/openConfigured.js";

const SYSTEM: PublicSystem = { ref: "srv:sys", name: "MF", host: "h", autoSignon: false };
const session = (extra: Partial<PublicSession>): PublicSession =>
  ({ ref: "srv:s", name: "画面", system: "srv:sys", sessionType: "display", ...extra }) as PublicSession;

beforeEach(() => {
  openSession.mockClear();
  systemsStore.systems = [SYSTEM];
  sessionsStore.sessions = [];
});

describe("端末の種類を開く指示へ載せる", () => {
  it("**3270 の設定なら terminal と model が付く**", async () => {
    systemsStore.sessions = [session({ terminal: "3270", model3270: 5 })];
    await useOpenConfigured().open("srv:s");
    expect(openSession).toHaveBeenCalled();
    expect(openSession.mock.calls[0]![0]).toMatchObject({
      type: "open",
      session: "srv:s",
      terminal: "3270",
      model: 5
    });
  });

  it("**モデル未指定なら 2**（24x80）", async () => {
    systemsStore.sessions = [session({ terminal: "3270" })];
    await useOpenConfigured().open("srv:s");
    expect(openSession.mock.calls[0]![0]).toMatchObject({ terminal: "3270", model: 2 });
  });

  it("**5250 のときは付けない**——既定なので載せても意味が同じ", async () => {
    systemsStore.sessions = [session({})];
    await useOpenConfigured().open("srv:s");
    const msg = openSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(msg.terminal).toBeUndefined();
    expect(msg.model).toBeUndefined();
  });
});
