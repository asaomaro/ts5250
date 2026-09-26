import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

const openSession = vi.fn((...args: unknown[]): Promise<string> => {
  void args;
  return Promise.resolve("s-embed-1");
});
const closeSession = vi.fn();
const openPrinterSession = vi.fn((...args: unknown[]): Promise<string> => {
  void args;
  return Promise.resolve("p-embed-1");
});
vi.mock("../src/session-controller.js", () => ({
  openSession: (...a: unknown[]) => openSession(...a),
  openPrinterSession: (...a: unknown[]) => openPrinterSession(...a),
  closeSession: (...a: unknown[]) => closeSession(...a)
}));

const downloadScreenHtml = vi.fn();
vi.mock("../src/screenExport.js", () => ({
  downloadScreenHtml: (...a: unknown[]) => downloadScreenHtml(...a)
}));

import EmbedApp from "../src/EmbedApp.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import PrinterPane from "../src/components/PrinterPane.vue";
import SpoolPane from "../src/components/SpoolPane.vue";
import SqlPane from "../src/components/SqlPane.vue";
import IfsPane from "../src/components/IfsPane.vue";
import SettingsForm from "../src/components/SettingsForm.vue";
import { embedStore } from "../src/stores/embed.js";
import { EMBED_APP_EXTENSIONS } from "../src/embed-protocol.js";

const STUBS = { EmulatorPane: true, PrinterPane: true, SpoolPane: true, SqlPane: true, IfsPane: true, SettingsForm: true };

beforeEach(() => {
  openSession.mockClear();
  openPrinterSession.mockClear();
  closeSession.mockClear();
  downloadScreenHtml.mockClear();
  embedStore.loaded = undefined;
  embedStore.connect = undefined;
  embedStore.error = undefined;
  embedStore.loadedRev = 0;
  embedStore.savedRev = 0;
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

  it("spool(スプール表示): openSession()は呼ばず、systemRefをそのままSpoolPaneのsystemへ渡す", async () => {
    const w = mount(EmbedApp, { props: { app: "spool" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "spool", host: "AS400", systemRef: "own:abc123" };
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
    // **本物と同じく構造化複製を通す**（D34）。素の`vi.fn()`だと Vue のリアクティブ値（Proxy）もそのまま受け取れてしまい、
    // 実際のブラウザで`DataCloneError`になる送信を見逃した
    const post = vi.fn((msg: unknown) => void structuredClone(msg));
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
    expect(w.findComponent(SettingsForm).props("initial")).toMatchObject({ host: "AS400" });
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

  it("spool/sql/ifsには「切断」を出さない（接続を持たないため。D19）", async () => {
    for (const app of ["spool", "sql", "ifs"] as const) {
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

/**
 * **設定は待機画面に置き、編集はその場で自動保存する**（利用者の要望。D23）。ヘッダーの⚙とポップアップは廃止。
 * 保存は間引く（1文字ごとにファイルを書かない）が、「接続」の前には必ず送る
 */
describe("EmbedApp: 待機画面の設定フォーム（自動保存）", () => {
  function stubParentPostMessage() {
    // **本物と同じく構造化複製を通す**（D34）。素の`vi.fn()`だと Vue のリアクティブ値（Proxy）もそのまま受け取れてしまい、
    // 実際のブラウザで`DataCloneError`になる送信を見逃した
    const post = vi.fn((msg: unknown) => void structuredClone(msg));
    const fakeParent = { postMessage: post } as unknown as Window;
    vi.spyOn(window, "parent", "get").mockReturnValue(fakeParent);
    return post;
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ヘッダーに⚙（設定ポップアップ）は無く、待機画面にフォームがある。初期値はファイルの現在値（loaded）", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "AS400", ccsid: 930, katakanaVariant: "katakana", terminal: "3270", watermark: { text: "検証機" } };
    await nextTick();
    expect(w.find(".embed-header button[title='設定']").exists()).toBe(false);
    const form = w.findComponent(SettingsForm);
    expect(form.props("app")).toBe("emulator");
    expect(form.props("initial")).toMatchObject({ host: "AS400", ccsid: 930, katakanaVariant: "katakana", terminal: "3270", watermark: { text: "検証機" } });
  });

  it("ファイルが読めない（loaded無し）間はフォームを出さない——入力1つで壊れたファイルを上書きしないため", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.error = "JSONとして読めません";
    await nextTick();
    expect(w.findComponent(SettingsForm).exists()).toBe(false);
    expect(w.find(".idle-card .error").text()).toContain("JSON");
  });


  /** 保存は「保存」ボタンを押したときだけ（利用者の指定。D33。以前は入力のたびに間引いて自動保存していた） */
  it("入力しただけでは保存しない。「保存」を押すと最後の値を1回だけ save する", async () => {
    vi.useFakeTimers();
    const post = stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "A", title: "f" };
    await nextTick();
    const saveBtn = () => w.get(".save-btn").element as HTMLButtonElement;
    expect(saveBtn().disabled).toBe(true); // 変更が無ければ押せない
    const form = w.findComponent(SettingsForm);
    form.vm.$emit("change", { host: "AS" });
    form.vm.$emit("change", { host: "AS400" });
    await nextTick();
    vi.advanceTimersByTime(5000);
    expect(post).not.toHaveBeenCalled();
    expect(w.find(".save-state").text()).toBe("未保存の変更があります");
    await w.get(".save-btn").trigger("click");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: "save", payload: { host: "AS400" } }, "*");
    expect(w.find(".save-state").text()).toBe("保存しています…");
    expect(saveBtn().disabled).toBe(true);
    embedStore.savedRev++;
    await nextTick();
    expect(w.find(".save-state").text()).toBe("保存しました");
  });

  it("保存の応答を待つ間に次の入力があれば「未保存の変更があります」のまま（古い応答で保存済みと出さない）", async () => {
    stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "A", title: "f" };
    await nextTick();
    const form = w.findComponent(SettingsForm);
    form.vm.$emit("change", { host: "B" });
    await nextTick();
    await w.get(".save-btn").trigger("click");
    form.vm.$emit("change", { host: "BC" });
    embedStore.savedRev++; // 1回目の応答
    await nextTick();
    expect(w.find(".save-state").text()).toBe("未保存の変更があります");
  });

  it("打ちかけの不正な値がある間（change が undefined）は、保存も接続もできない", async () => {
    const post = stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "A" };
    await nextTick();
    w.findComponent(SettingsForm).vm.$emit("change", undefined);
    await nextTick();
    expect((w.get(".save-btn").element as HTMLButtonElement).disabled).toBe(true);
    expect((w.get(".connect-btn").element as HTMLButtonElement).disabled).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("保存し終えた後の「接続」は保存を送り直さない（未保存の変更がある時だけ保存する）", async () => {
    const post = stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "A" };
    await nextTick();
    w.findComponent(SettingsForm).vm.$emit("change", { host: "B" });
    await nextTick();
    await w.get(".save-btn").trigger("click");
    embedStore.savedRev++;
    await nextTick();
    await w.get(".connect-btn").trigger("click");
    expect(post.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(["save", "connect"]);
  });

  it("未保存の変更が無ければ「接続」は connect だけを送る", async () => {
    const post = stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "A" };
    await nextTick();
    await w.get(".connect-btn").trigger("click");
    expect(post.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(["connect"]);
  });

  it("「接続」は未保存の変更を先に保存してから送る（保存し終えた設定で繋ぐ）", async () => {
    vi.useFakeTimers();
    const post = stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "A" };
    await nextTick();
    w.findComponent(SettingsForm).vm.$emit("change", { host: "NEW" });
    await nextTick();
    await w.get(".connect-btn").trigger("click");
    expect(post.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(["save", "connect"]);
    vi.advanceTimersByTime(1000);
    expect(post).toHaveBeenCalledTimes(2); // 送った分を後から二重に送らない
  });

  it("入力中の値で「接続」の可否と種類の表示が変わる（保存の往復を待たない）", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "" };
    await nextTick();
    expect((w.find(".connect-btn").element as HTMLButtonElement).disabled).toBe(true);
    w.findComponent(SettingsForm).vm.$emit("change", { host: "MF", terminal: "3270" });
    await nextTick();
    expect((w.find(".connect-btn").element as HTMLButtonElement).disabled).toBe(false);
    expect(w.find(".idle-card .kind").text()).toBe("3270端末");
  });

  it("自分の保存の応答（saved＝loadedRevは進まない）ではフォームを作り直さず、外での書き換え（loaded）では作り直す", async () => {
    vi.useFakeTimers();
    const post = stubParentPostMessage();
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "A" };
    await nextTick();
    const form1 = w.findComponent(SettingsForm);
    form1.vm.$emit("change", { host: "B" });
    embedStore.loaded = { app: "emulator", host: "B" }; // saved相当
    await nextTick();
    expect(w.findComponent(SettingsForm).vm).toBe(form1.vm);

    embedStore.loaded = { app: "emulator", host: "EDITED" };
    embedStore.loadedRev++; // loaded相当（テキストで直接書き換えられた）
    await nextTick();
    const form2 = w.findComponent(SettingsForm);
    expect(form2.vm).not.toBe(form1.vm);
    expect(form2.props("initial")).toMatchObject({ host: "EDITED" });
    // 外で書き換えられたら、間引き中だった古い入力は捨てる（書き換えを上書きしない）
    vi.advanceTimersByTime(1000);
    expect(post).not.toHaveBeenCalled();
  });



  it.each([
    ["emulator", "948px"],
    ["printer", "648px"],
    ["sql", "648px"]
  ] as const)("%s: カードの幅は設定の列数で決まる（%s）", async (app, width) => {
    const w = mount(EmbedApp, { props: { app }, global: { stubs: STUBS } });
    embedStore.loaded = { app, host: "A" };
    await nextTick();
    expect((w.find(".idle-card").element as HTMLElement).style.width).toBe(width);
  });

  it.each(["spool", "sql", "ifs"] as const)("%s: 開いたあと「閉じる」で待機画面（設定）へ戻れる", async (app) => {
    const w = mount(EmbedApp, { props: { app }, global: { stubs: STUBS } });
    embedStore.loaded = { app, host: "AS400" };
    embedStore.connect = { app, host: "AS400", systemRef: "own:x" };
    await nextTick();
    expect(w.findComponent(SettingsForm).exists()).toBe(false);
    await w.get(".embed-header button[title='閉じて設定に戻る']").trigger("click");
    expect(embedStore.connect).toBeUndefined();
    expect(w.findComponent(SettingsForm).exists()).toBe(true);
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

  it("spool/sql/ifsでは出さない（HTML化できるのは5250/3270画面だけ）", async () => {
    const w = mount(EmbedApp, { props: { app: "spool" }, global: { stubs: STUBS } });
    embedStore.connect = { app: "spool", host: "AS400", systemRef: "own:p1" };
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
    ["printer", "プリンター", "接続"],
    ["spool", "スプール", "開く"],
    ["sql", "SQL", "開く"],
    ["ifs", "IFS", "開く"]
  ] as const)("%s: 種類「%s」と説明・ファイル名・設定欄を出し、ボタンは「%s」", async (app, kind, button) => {
    const w = mount(EmbedApp, { props: { app }, global: { stubs: STUBS } });
    embedStore.loaded = { app, host: "AS400", port: 992, user: "U", title: "sample-x" };
    await nextTick();
    expect(w.find(".idle-card .kind").text()).toBe(kind);
    expect(w.find(".idle-card .desc").text().length).toBeGreaterThan(0);
    expect(w.find(".idle-card .file").text()).toContain(`sample-x${EMBED_APP_EXTENSIONS[app]}`); // 拡張子は種別ごと（D32）
    // 接続先は設定フォームの欄として出す（D23。以前は読み取り専用の一覧だった）
    expect(w.findComponent(SettingsForm).props("initial")).toMatchObject({ host: "AS400", port: 992, user: "U" });
    expect(w.find(".connect-btn").text()).toBe(button);
    w.unmount();
  });

  it("emulatorの3270設定は「3270端末」と出す", async () => {
    const w = mount(EmbedApp, { props: { app: "emulator" }, global: { stubs: STUBS } });
    embedStore.loaded = { app: "emulator", host: "MF", terminal: "3270" };
    await nextTick();
    expect(w.find(".idle-card .kind").text()).toBe("3270端末");
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

/**
 * **プリンターセッション**（`app: "printer"`。利用者の要望。D20）。emulatorと同じくセッションなので
 * 「接続／切断」・名前とⓘを持つ。開くのは`openPrinterSession()`で、表示は`PrinterPane`
 */
describe("EmbedApp: プリンターセッション", () => {
  it("接続の応答でopenPrinterSession()をkind:printerで呼び、emulator専用の項目は送らない", async () => {
    const w = mount(EmbedApp, { props: { app: "printer" }, global: { stubs: STUBS } });
    embedStore.connect = {
      app: "printer",
      host: "AS400",
      port: 23,
      ccsid: 5035,
      deviceName: "PRT01",
      user: "U",
      password: "P",
      terminal: "3270",
      screenSize: "27x132",
      title: "prt"
    };
    await nextTick();
    await nextTick();
    expect(openSession).not.toHaveBeenCalled();
    expect(openPrinterSession).toHaveBeenCalledTimes(1);
    const [open, label, meta] = openPrinterSession.mock.calls[0]! as [Record<string, unknown>, string, Record<string, unknown>];
    expect(open).toMatchObject({ type: "open", kind: "printer", host: "AS400", port: 23, ccsid: 5035, deviceName: "PRT01", user: "U", password: "P" });
    expect(open.terminal).toBeUndefined();
    expect(open.screenSize).toBeUndefined();
    expect(label).toBe("prt");
    expect(meta).toMatchObject({ sessionType: "printer", deviceName: "PRT01" });
    expect(w.findComponent(PrinterPane).props("sessionId")).toBe("p-embed-1");
  });

  it("接続中は「切断」・名前とⓘを出し、⬇HTMLは出さない。切断でcloseSession()して待機表示へ戻る", async () => {
    const w = mount(EmbedApp, { props: { app: "printer" }, global: { stubs: { ...STUBS, SessionInfo: true } } });
    embedStore.connect = { app: "printer", host: "AS400", deviceName: "PRT01", title: "prt" };
    await nextTick();
    await nextTick();
    expect(w.find(".title-group").exists()).toBe(true);
    expect(w.find(".embed-header button[title*=\"HTML\"]").exists()).toBe(false);
    await w.get(".embed-header button[title='切断する']").trigger("click");
    expect(closeSession).toHaveBeenCalledWith("p-embed-1");
    expect(w.findComponent(PrinterPane).exists()).toBe(false);
    expect(w.find(".connect-btn").text()).toBe("接続");
  });
});
