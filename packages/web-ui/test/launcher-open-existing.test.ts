import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@as400web/server";
import LauncherPane from "../src/components/LauncherPane.vue";
import ConfigCard from "../src/components/ConfigCard.vue";
import { systemsStore } from "../src/stores/systems.js";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import { workspaceStore } from "../src/stores/workspace.js";
import { authStore } from "../src/stores/auth.js";

/**
 * **システムを切り替えて戻ったとき、既存のセッションへ戻れること。**
 *
 * 切替でセッションは閉じない（他システムのタブは生きたまま隠れる）。しかし戻った先はメニューで、
 * そこに出るのはセッション設定のカードだけ——タブが生きていることが見えない。そのまま「接続」を
 * 押すと 2 本目が開き、装置名を固定していればホストが「使用中」としてネゴシエーション中に
 * ソケットを切る（`SESSION_CLOSED: closed during negotiation: socket closed`）。
 * 実機で再現した挙動なので、カードの表示と押したときの動きをここで固定する。
 */
const SYSTEM: PublicSystem = { ref: "own:s-1", name: "JP", host: "h", autoSignon: false };
const SESSION: PublicSession = {
  ref: "own:ses-1",
  name: "jp1",
  system: "own:s-1",
  sessionType: "display",
  deviceName: "WEBEMU01"
} as PublicSession;

function stubFetch(): void {
  vi.stubGlobal("fetch", (url: string) => {
    const u = String(url);
    if (u === "/api/systems") {
      return Promise.resolve(
        new Response(JSON.stringify({ systems: [SYSTEM], editable: false }), { status: 200 })
      );
    }
    if (u === "/api/sessions-config") {
      return Promise.resolve(new Response(JSON.stringify({ sessions: [SESSION] }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

/** 生きているセッション（WebSocket は使わないのでダミー） */
function liveSession(configRef: string, deviceName?: string): SessionState {
  return {
    sessionId: "sess-1",
    label: "jp1",
    configRef,
    snapshot: undefined,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: false,
    client: { close: () => {}, send: () => {} } as unknown as SessionState["client"],
    ...(deviceName !== undefined ? { meta: { deviceName } } : {})
  };
}

beforeEach(() => {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [SESSION];
  systemsStore.selected = SYSTEM.ref;
  systemsStore.loaded = true;
  authStore.enabled = false;
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  workspaceStore.init();
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("既に開いている設定のカード", () => {
  it("開いていなければ「接続」", async () => {
    const w = mount(LauncherPane);
    await flushPromises();
    const card = w.findComponent(ConfigCard);
    expect(card.props("opened")).toBe(false);
    expect(w.text()).toContain("接続");
    w.unmount();
  });

  it("開いていれば「開く」になり、あえて増やすための「＋新規」が出る", async () => {
    sessionsStore.add(liveSession(SESSION.ref, "WEBEMU01"));
    const w = mount(LauncherPane);
    await flushPromises();
    const card = w.findComponent(ConfigCard);
    expect(card.props("opened")).toBe(true);
    expect(w.text()).toContain("開く");
    expect(w.text()).toContain("＋新規");
    w.unmount();
  });

  it("押しても新しいセッションは開かず、既存タブへ戻る（ワークスペースを表示する）", async () => {
    sessionsStore.add(liveSession(SESSION.ref, "WEBEMU01"));
    workspaceStore.addSession("sess-1", SYSTEM.ref);
    workspaceStore.showLauncher = true;

    const w = mount(LauncherPane);
    await flushPromises();
    await w.findComponent(ConfigCard).vm.$emit("open", SESSION.ref);
    await flushPromises();

    expect(workspaceStore.showLauncher, "ワークスペースへ移る").toBe(false);
    expect(sessionsStore.all, "セッションは増えない").toHaveLength(1);
    w.unmount();
  });

  it("別設定が同じ装置名を使っていたら、開かずに理由を出す", async () => {
    // 別の設定（configRef 違い）が装置名 WEBEMU01 を使用中
    sessionsStore.add(liveSession("own:ses-other", "WEBEMU01"));
    const w = mount(LauncherPane);
    await flushPromises();
    await w.findComponent(ConfigCard).vm.$emit("open", SESSION.ref);
    await flushPromises();

    expect(w.text()).toContain("WEBEMU01");
    expect(w.text()).toContain("使用中");
    expect(sessionsStore.all, "セッションは増えない").toHaveLength(1);
    w.unmount();
  });
});

/**
 * **システム一覧に接続中の数を出す。**
 *
 * カードの「セッション N」は設定の数なので、それだけでは今つながっているのかが分からない。
 * 切り替えて戻ったときに一番知りたいのは「このシステムは今つながっているか」なので、
 * 接続中が 1 本でもあれば数を添える（0 なら出さない＝普段の見た目を変えない）。
 */
describe("システムカードの接続数", () => {
  it("接続が無ければ設定の数だけを出す", () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM } });
    expect(w.text()).toContain("セッション 1");
    expect(w.text()).not.toContain("接続 ");
    w.unmount();
  });

  it("接続中があれば「接続 N」を添える", () => {
    sessionsStore.add({ ...liveSession(SESSION.ref, "WEBEMU01"), systemRef: SYSTEM.ref });
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM } });
    expect(w.text()).toContain("セッション 1");
    expect(w.text()).toContain("接続 1");
    w.unmount();
  });

  it("別システムの接続は数えない", () => {
    sessionsStore.add({
      ...liveSession(SESSION.ref, "WEBEMU01"),
      sessionId: "sess-other",
      systemRef: "own:s-other"
    });
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM } });
    expect(w.text()).not.toContain("接続 ");
    w.unmount();
  });

  it("切断済みのセッションは数えない", () => {
    sessionsStore.add({
      ...liveSession(SESSION.ref, "WEBEMU01"),
      systemRef: SYSTEM.ref,
      connected: false
    });
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM } });
    expect(w.text()).not.toContain("接続 ");
    w.unmount();
  });
});
