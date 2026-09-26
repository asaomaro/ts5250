import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

const openSession = vi.fn((...args: unknown[]): Promise<string> => {
  void args;
  return Promise.resolve("s-embed-1");
});
const closeSession = vi.fn();
vi.mock("../src/session-controller.js", () => ({
  openSession: (...a: unknown[]) => openSession(...a),
  closeSession: (...a: unknown[]) => closeSession(...a)
}));

const downloadScreenHtml = vi.fn();
vi.mock("../src/screenExport.js", () => ({
  downloadScreenHtml: (...a: unknown[]) => downloadScreenHtml(...a)
}));

import EmbedApp from "../src/EmbedApp.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import SpoolPane from "../src/components/SpoolPane.vue";
import SqlPane from "../src/components/SqlPane.vue";
import IfsPane from "../src/components/IfsPane.vue";
import SettingsForm from "../src/components/SettingsForm.vue";
import { embedStore } from "../src/stores/embed.js";

const STUBS = { EmulatorPane: true, SpoolPane: true, SqlPane: true, IfsPane: true, SettingsForm: true };

beforeEach(() => {
  openSession.mockClear();
  closeSession.mockClear();
  downloadScreenHtml.mockClear();
  embedStore.connect = undefined;
  embedStore.error = undefined;
});

describe("EmbedApp: app種別ごとのマウント分岐", () => {
  it("emulator: connectを受けたら openSession() を直接呼び、返ったsessionIdでEmulatorPaneを出す", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400", port: 992, user: "U", password: "P" };
    await nextTick();
    await nextTick();
    expect(openSession).toHaveBeenCalledTimes(1);
    const openArg = openSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(openArg).toMatchObject({ type: "open", host: "AS400", port: 992, user: "U", password: "P" });
    expect(w.findComponent(EmulatorPane).props("sessionId")).toBe("s-embed-1");
  });

  it("emulator: connectがsystemRefを持っていれば、openSession()の第4引数（systemRef）へそのまま渡す（D12。ステータスバーのメッセージ表示用）", async () => {
    mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400", user: "U", password: "P", systemRef: "own:emu1" };
    await nextTick();
    await nextTick();
    expect(openSession).toHaveBeenCalledTimes(1);
    const call = openSession.mock.calls[0]!;
    expect(call[3]).toBe("own:emu1"); // systemRef
    const meta = call[2] as Record<string, unknown>;
    expect(meta["signonUser"]).toBe("U"); // メッセージ待ち行列の既定値に使う
  });

  it("emulator: connectがwatermarkを持っていれば、openSession()のmetaへそのまま渡す（D16。EmulatorPaneのフォールバック先）", async () => {
    mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400", watermark: { text: "検証機 {host}" } };
    await nextTick();
    await nextTick();
    expect(openSession).toHaveBeenCalledTimes(1);
    const meta = openSession.mock.calls[0]![2] as Record<string, unknown>;
    expect(meta["watermark"]).toEqual({ text: "検証機 {host}" });
  });

  it("printer(スプール表示): openSession()は呼ばず、systemRefをそのままSpoolPaneのsystemへ渡す", async () => {
    const w = mount(EmbedApp, { props: { app: "printer" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "printer", host: "AS400", systemRef: "own:abc123" };
    await nextTick();
    expect(openSession).not.toHaveBeenCalled();
    const pane = w.findComponent(SpoolPane);
    expect(pane.props("system")).toBe("own:abc123");
    expect(pane.props("tabId")).toBe("spool:files@own:abc123");
  });

  it("sql: systemRefからtabIdを合成してSqlPaneへ渡す", async () => {
    const w = mount(EmbedApp, { props: { app: "sql" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "sql", host: "AS400", systemRef: "own:xyz" };
    await nextTick();
    const pane = w.findComponent(SqlPane);
    expect(pane.props("tabId")).toBe("sql:query@own:xyz");
    expect(pane.props("system")).toBe("own:xyz");
  });

  it("ifs: systemRefからtabIdを合成してIfsPaneへ渡す", async () => {
    const w = mount(EmbedApp, { props: { app: "ifs" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "ifs", host: "AS400", systemRef: "own:ifs1" };
    await nextTick();
    const pane = w.findComponent(IfsPane);
    expect(pane.props("tabId")).toBe("ifs:files@own:ifs1");
  });

  it("systemRef未到着の間はプレーンなペインを出さず待機表示のまま", async () => {
    const w = mount(EmbedApp, { props: { app: "sql" }, global: { stubs: STUBS } });
    await nextTick();
    expect(w.findComponent(SqlPane).exists()).toBe(false);
    expect(w.text()).toContain("設定を待っています");
  });
});

describe("EmbedApp: 再接続の二重発火防止（taskcheck T6の指摘）", () => {
  it("openSession()が解決する前に2つ目のconnectが来ても、openSession()は1回しか呼ばれない", async () => {
    let resolveFirst!: (v: string) => void;
    openSession.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    // 1つ目がまだ解決していない間に2つ目を発火
    embedStore.connect = { app: "emulator", host: "AS400", port: 992 };
    await nextTick();
    expect(openSession).toHaveBeenCalledTimes(1); // 2つ目は connecting 中なので無視される
    resolveFirst("s-first");
    await nextTick();
    await nextTick();
  });

  it("設定保存後の再接続では、前のセッションをcloseSession()してから開き直す", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    expect(w.findComponent(EmulatorPane).props("sessionId")).toBe("s-embed-1");
    expect(closeSession).not.toHaveBeenCalled();
    openSession.mockResolvedValueOnce("s-embed-2");
    embedStore.connect = { app: "emulator", host: "AS400", port: 992 }; // 設定フォーム保存相当
    await nextTick();
    await nextTick();
    expect(closeSession).toHaveBeenCalledWith("s-embed-1");
    expect(w.findComponent(EmulatorPane).props("sessionId")).toBe("s-embed-2");
  });
});

describe("EmbedApp: 設定ボタン", () => {
  it("押すとSettingsFormが表示される", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    expect(w.findComponent({ name: "SettingsForm" }).exists()).toBe(false);
    await w.get(".settings-btn").trigger("click");
    expect(w.findComponent({ name: "SettingsForm" }).exists()).toBe(true);
  });

  it("SettingsFormへapp（種別）とconnectの拡張フィールド（katakanaVariant/terminal/screenSize/watermark）を渡す", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = {
      app: "emulator",
      host: "AS400",
      ccsid: 930,
      katakanaVariant: "katakana",
      terminal: "3270",
      screenSize: "27x132",
      watermark: { text: "検証機" }
    };
    await nextTick();
    await w.get(".settings-btn").trigger("click");
    const form = w.findComponent(SettingsForm);
    expect(form.props("app")).toBe("emulator");
    expect(form.props("initial")).toMatchObject({
      ccsid: 930,
      katakanaVariant: "katakana",
      terminal: "3270",
      screenSize: "27x132",
      watermark: { text: "検証機" }
    });
  });
});

describe("EmbedApp: ⬇ HTML（画面のHTML保存。利用者の要望）", () => {
  it("emulatorで接続済みのときだけボタンを出す", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    expect(w.find(".embed-header button[title*=\"HTML\"]").exists()).toBe(false);
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    expect(w.find(".embed-header button[title*=\"HTML\"]").exists()).toBe(true);
  });

  it("printer/sql/ifsでは出さない（HTML化できるのは5250/3270画面だけ）", async () => {
    const w = mount(EmbedApp, { props: { app: "printer" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "printer", host: "AS400", systemRef: "own:p1" };
    await nextTick();
    expect(w.find(".embed-header button[title*=\"HTML\"]").exists()).toBe(false);
  });

  it("押すと接続中のsessionIdでdownloadScreenHtml()を呼ぶ", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    await w.get('.embed-header button[title*="HTML"]').trigger("click");
    expect(downloadScreenHtml).toHaveBeenCalledWith("s-embed-1");
  });
});
