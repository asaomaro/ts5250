import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  embedStore.loaded = undefined;
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

  it("systemRef未到着の間はプレーンなペインを出さず、接続ボタンの待機表示のまま", async () => {
    const w = mount(EmbedApp, { props: { app: "sql" }, global: { stubs: STUBS } });
    await nextTick();
    expect(w.findComponent(SqlPane).exists()).toBe(false);
    expect(w.find(".connect-btn").exists()).toBe(true);
  });
});

/**
 * **`.ts5250`を開いても即座に接続しない**（利用者の要望「設定だけを変えたい場合にも
 * 接続されてしまう」への対応。`20260924-vscode-extension` D17）。実際に接続するのは
 * 利用者が「接続」ボタンを押して`{type:"connect"}`を拡張ホストへ送り、その応答
 * （`embedStore.connect`）を受け取ってから
 */
describe("EmbedApp: 接続は明示的な「接続」ボタンから", () => {
  function stubParentPostMessage(): ReturnType<typeof vi.fn> {
    const post = vi.fn();
    vi.spyOn(window, "parent", "get").mockReturnValue({ postMessage: post } as unknown as Window);
    return post;
  }

  afterEach(() => vi.restoreAllMocks());

  it("emulator: loadedが届いてもopenSession()は呼ばれず、接続ボタンにホストが見える", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "AS400" }; // readyの応答相当（接続しない）
    await nextTick();
    expect(openSession).not.toHaveBeenCalled();
    expect(w.findComponent(EmulatorPane).exists()).toBe(false);
    expect(w.text()).toContain("AS400");
    const btn = w.find(".connect-btn");
    expect(btn.exists()).toBe(true);
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("ホスト未設定（loadedのhostが空）だと接続ボタンを無効化する", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "" };
    await nextTick();
    expect((w.find(".connect-btn").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("接続ボタンを押すと、拡張ホストへ {type:'connect'}（payload無し）を送る", async () => {
    const post = stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "AS400" };
    await nextTick();
    await w.get(".connect-btn").trigger("click");
    expect(post).toHaveBeenCalledWith({ type: "connect" }, "*");
  });

  it("接続ボタン押下の応答（connectメッセージ）が来て初めてopenSession()が呼ばれる", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "AS400" };
    await nextTick();
    expect(openSession).not.toHaveBeenCalled();
    embedStore.connect = { app: "emulator", host: "AS400" }; // 拡張ホストからの応答
    await nextTick();
    await nextTick();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(w.findComponent(EmulatorPane).exists()).toBe(true);
  });

  it("printer/sql/ifs: loadedだけではペインを出さず、connectで初めて出す", async () => {
    const w = mount(EmbedApp, { props: { app: "sql" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "sql", host: "AS400", systemRef: "own:xyz" };
    await nextTick();
    expect(w.findComponent(SqlPane).exists()).toBe(false); // loadedだけでは出ない
    embedStore.connect = { app: "sql", host: "AS400", systemRef: "own:xyz" };
    await nextTick();
    expect(w.findComponent(SqlPane).exists()).toBe(true);
  });

  it("設定を保存しただけ（savedメッセージ）では接続しない", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "AS400" };
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    expect(w.findComponent(EmulatorPane).exists()).toBe(true);
    openSession.mockClear();
    // saved相当: loadedだけ更新（EmbedAppは直接connectを書き換えないので、initEmbedBridge経由の
    // 実際の挙動をここではembedStore.loadedの更新のみで模す——connectは変えない）
    embedStore.loaded = { app: "emulator", host: "AS400", port: 992 };
    await nextTick();
    expect(openSession).not.toHaveBeenCalled(); // 再接続されない
  });
});

describe("EmbedApp: 切断ボタン", () => {
  it("接続していないときは出さない", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    await nextTick();
    expect(w.find(".embed-header button[title='切断する']").exists()).toBe(false);
  });

  it("emulator接続中は「切断」を出し、押すとcloseSession()して待機表示へ戻る", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    expect(w.findComponent(EmulatorPane).exists()).toBe(true);
    const disconnectBtn = w.find(".embed-header button[title='切断する']");
    expect(disconnectBtn.exists()).toBe(true);
    await disconnectBtn.trigger("click");
    expect(closeSession).toHaveBeenCalledWith("s-embed-1");
    expect(w.findComponent(EmulatorPane).exists()).toBe(false);
    expect(w.find(".connect-btn").exists()).toBe(true); // 待機表示（接続ボタン）へ戻る
  });

  it("切断のあと、もう一度「接続」の応答が来れば開き直せる", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "AS400" };
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    await w.get(".embed-header button[title='切断する']").trigger("click");
    openSession.mockClear();
    openSession.mockResolvedValueOnce("s-embed-2");
    embedStore.connect = { app: "emulator", host: "AS400" }; // 再度の接続ボタン押下への応答
    await nextTick();
    await nextTick();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(w.findComponent(EmulatorPane).props("sessionId")).toBe("s-embed-2");
  });

  it("接続に失敗したら、エラーと一緒に「接続」ボタンを出す（押し直せる）", async () => {
    openSession.mockRejectedValueOnce(new Error("SESSION_CLOSED: 8902 装置が使用中です"));
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "AS400" };
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    await nextTick();
    expect(w.text()).toContain("8902");
    const btn = w.find(".connect-btn");
    expect(btn.exists()).toBe(true);
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("保存エラー（embedStore.error）が出ていても「接続」ボタンは出す", async () => {
    const w = mount(EmbedApp, { props: { app: "sql" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "sql", host: "AS400" };
    embedStore.error = "保存に失敗しました。";
    await nextTick();
    expect(w.text()).toContain("保存に失敗しました");
    expect(w.find(".connect-btn").exists()).toBe(true);
  });

  it("printer/sql/ifsには「切断」を出さない（接続を持たないため。D19）", async () => {
    for (const app of ["printer", "sql", "ifs"] as const) {
      const w = mount(EmbedApp, { props: { app }, global: { stubs: STUBS } });
      embedStore.connect = { app, host: "AS400", systemRef: "own:xyz" };
      await nextTick();
      expect(w.find(".embed-header button[title='切断する']").exists()).toBe(false);
      w.unmount();
      embedStore.connect = undefined;
    }
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

/**
 * **待機表示で何の機能か分かる**・**名前とⓘをヘッダー左に出す**（利用者の要望。D19）
 */
describe("EmbedApp: 待機表示の情報とヘッダーの名前", () => {
  it.each([
    ["emulator", "5250端末", "接続"],
    ["printer", "スプール", "開く"],
    ["sql", "SQL", "開く"],
    ["ifs", "IFS", "開く"]
  ] as const)("%s: 種類「%s」と説明・接続先を出し、ボタンは「%s」", async (app, kind, button) => {
    const w = mount(EmbedApp, { props: { app }, global: { stubs: STUBS } });
    embedStore.loaded = { app, host: "AS400", port: 992, user: "U", title: "sample-x" };
    await nextTick();
    expect(w.find(".idle-card .kind").text()).toBe(kind);
    expect(w.find(".idle-card .desc").text().length).toBeGreaterThan(0);
    const rows = w.find(".idle-card .rows").text();
    expect(rows).toContain("sample-x");
    expect(rows).toContain("AS400:992");
    expect(rows).toContain("U");
    expect(w.find(".connect-btn").text()).toBe(button);
    w.unmount();
  });

  it("emulatorの3270設定は「3270端末」と出す", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "MF", terminal: "3270" };
    await nextTick();
    expect(w.find(".idle-card .kind").text()).toBe("3270端末");
  });

  it("TLSの未指定は「無効」と出す（サーバーはtls===trueのときだけTLS）", async () => {
    const w = mount(EmbedApp, { props: { app: "sql" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "sql", host: "AS400" };
    await nextTick();
    expect(w.find(".idle-card .rows").text()).toContain("無効");
  });

  it("接続後、ヘッダー左に名前（title）とⓘを出し、ⓘでSessionInfoを開く。openSessionのlabelもtitle", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: { ...STUBS, SessionInfo: true } } });
    expect(w.find(".title-group").exists()).toBe(false); // 接続前は出さない
    embedStore.connect = { app: "emulator", host: "AS400", port: 23, tls: false, ccsid: 930, screenSize: "27x132", password: "p", title: "sample" };
    await nextTick();
    await nextTick();
    const call = openSession.mock.calls[0]!;
    expect(call[1]).toBe("sample"); // label
    expect(call[2]).toMatchObject({ host: "AS400", port: 23, tls: false, ccsid: 930, screenSize: "27x132", autoSignon: true });
    expect(w.find(".title-group").exists()).toBe(true);
    await w.get(".title-group .info").trigger("click");
    expect(w.findComponent({ name: "SessionInfo" }).exists()).toBe(true);
  });

  it("titleが無ければopenSessionのlabelはホスト名", async () => {
    mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "emulator", host: "AS400" };
    await nextTick();
    await nextTick();
    expect(openSession.mock.calls[0]![1]).toBe("AS400");
  });
});
