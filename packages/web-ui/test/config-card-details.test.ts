import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@ts5250/server";
import ConfigCard from "../src/components/ConfigCard.vue";
import { systemsStore } from "../src/stores/systems.js";
import { authStore } from "../src/stores/auth.js";

const SYSTEM: PublicSystem = { ref: "own:test", name: "test", host: "AS400", autoSignon: false };
const SESSION: PublicSession = { ref: "own:session", name: "session", system: SYSTEM.ref, sessionType: "display" };

beforeEach(() => {
  systemsStore.systems = [SYSTEM]; systemsStore.sessions = []; systemsStore.editable = true;
  authStore.enabled = false; authStore.user = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe("通常版の詳細設定", () => {
  it("通信フラグ・拡張 GUI を復元し、無効への切り替えも保存する", async () => {
    const current = { ...SESSION, enhanced: true, keepAlive: true, deviceNameRetry: true };
    const update = vi.spyOn(systemsStore, "updateSession").mockResolvedValue(current);
    const w = mount(ConfigCard, { props: { kind: "session", session: current } });
    await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
    for (const key of ["enhanced", "keepAlive", "deviceNameRetry"]) {
      expect(w.find<HTMLInputElement>(`[data-setting="${key}"]`).element.checked).toBe(true);
      await w.find(`[data-setting="${key}"]`).setValue(false);
    }
    await w.findAll("button").find((b) => b.text() === "保存")!.trigger("click"); await flushPromises();
    expect(update).toHaveBeenCalledWith(SESSION.ref, expect.objectContaining({ enhanced: false, keepAlive: false, deviceNameRetry: false }));
    w.unmount();
  });

  it.each(["3270", "vt"] as const)("%s は TCP 設定だけを表示する", async (terminal) => {
    const w = mount(ConfigCard, { props: { kind: "session", session: { ...SESSION, terminal } } });
    await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
    expect(w.find('[data-setting="keepAlive"]').exists()).toBe(true);
    expect(w.find('[data-setting="enhanced"]').exists()).toBe(false);
    expect(w.find('[data-setting="deviceNameRetry"]').exists()).toBe(false);
    w.unmount();
  });

  it("システムの IFS・SQL 初期値を復元し、空欄で解除できる", async () => {
    const current = { ...SYSTEM, ifsPath: "/home/USER", sqlInitial: "SELECT 1" };
    const update = vi.spyOn(systemsStore, "updateSystem").mockResolvedValue(current);
    const w = mount(ConfigCard, { props: { kind: "system", system: current } });
    await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
    expect(w.find<HTMLInputElement>('[data-setting="ifsPath"]').element.value).toBe("/home/USER");
    expect(w.find<HTMLTextAreaElement>('[data-setting="sqlInitial"]').element.value).toBe("SELECT 1");
    await w.find('[data-setting="ifsPath"]').setValue("relative");
    await w.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    expect(update).not.toHaveBeenCalled();
    await w.find('[data-setting="ifsPath"]').setValue("");
    await w.find('[data-setting="sqlInitial"]').setValue("");
    await w.findAll("button").find((b) => b.text() === "保存")!.trigger("click"); await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("ifsPath");
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("sqlInitial");
    w.unmount();
  });
});
