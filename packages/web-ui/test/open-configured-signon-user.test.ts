import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PublicSession, PublicSystem } from "@ts5250/server";

/**
 * **`meta.signonUser` を接続 payload へ載せること。**
 *
 * 載らないと `StatusBar.vue` → `MessageQuickView.vue` の既定の待ち行列（`defaultQueue`）が
 * 常に空になり、`QSYSOPR`（無関係な共有待ち行列）へフォールバックしてしまう。
 * 実機（PUB400）で確認済み: MW 灯を点けた実メッセージは自分の待ち行列（signonUser 名）にあり、
 * QSYSOPR には無関係な他ジョブのメッセージしか無かった（`20260924-vscode-extension` D13）。
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

const session = (extra: Partial<PublicSession>): PublicSession =>
  ({ ref: "srv:s", name: "画面", system: "srv:sys", sessionType: "display", ...extra }) as PublicSession;

beforeEach(() => {
  openSession.mockClear();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
});

describe("signonUserをmetaへ載せる", () => {
  it("システムがsignonUserを持つなら、metaのsignonUserとして渡す", async () => {
    const SYSTEM: PublicSystem = {
      ref: "srv:sys",
      name: "MF",
      host: "h",
      autoSignon: true,
      signonUser: "MARO"
    } as PublicSystem;
    systemsStore.systems = [SYSTEM];
    systemsStore.sessions = [session({})];
    await useOpenConfigured().open("srv:s");
    expect(openSession.mock.calls[0]![2]).toMatchObject({ signonUser: "MARO" });
  });

  it("システムがsignonUserを持たないなら、metaに付けない", async () => {
    const SYSTEM: PublicSystem = { ref: "srv:sys", name: "MF", host: "h", autoSignon: false } as PublicSystem;
    systemsStore.systems = [SYSTEM];
    systemsStore.sessions = [session({})];
    await useOpenConfigured().open("srv:s");
    const meta = openSession.mock.calls[0]![2] as Record<string, unknown>;
    expect(meta.signonUser).toBeUndefined();
  });
});
