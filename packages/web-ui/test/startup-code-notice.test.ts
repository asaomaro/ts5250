/**
 * **表示セッションが繋がったら、起動応答のコードつきの開始の文言を 3 秒出す**（`20260921-startup-code-status`）。
 * ACS は繋がるたび（繋ぎ直しも）状態行に「<コード> - セッションを開始しました」の意味の文言を 3 秒出して消す（`AcsOnly.displayResponseCode`・
 * `StatusBar` の時間切れで `clearText`）。I901（関連付けたプリンターが無い等）もこれで分かる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import type { ScreenSnapshot } from "@ts5250/tn5250";

interface Fake {
  handlers: { onServerMessage: (m: unknown) => void };
}
let clients: Fake[] = [];

vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    close = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      clients.push({ handlers });
    }
    connect() {
      return Promise.resolve();
    }
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession, closeSession } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { startupStartedText, STARTUP_NOTICE_MS, isOperatorError, msgHostReconnecting, MSG_ASSOC_PRINTER_ISSUE } from "../src/composables/opMessages.js";
import SessionInfo from "../src/components/SessionInfo.vue";

const snap = (): ScreenSnapshot =>
  ({ sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells: [], fields: [] }) as unknown as ScreenSnapshot;
async function open(extra: Record<string, unknown> = {}) {
  const p = openSession({ type: "open", host: "h" }, "t");
  clients[0]!.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: snap(), ccsid: 930, pcCommand: false, ...extra });
  await p;
  return sessionsStore.get("s1")!;
}

describe("開始の知らせ", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clients = [];
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });
  afterEach(() => {
    if (sessionsStore.get("s1")) closeSession("s1");
    vi.useRealTimers();
  });

  it("開いたら「開始しました（起動応答 I902）」を出し、3 秒で消す", async () => {
    const s = await open({ startupCode: "I902" });
    expect(s.startupCode).toBe("I902");
    expect(s.notice).toBe(startupStartedText("I902"));
    vi.advanceTimersByTime(STARTUP_NOTICE_MS - 1);
    expect(sessionsStore.get("s1")!.notice).toBe(startupStartedText("I902"));
    vi.advanceTimersByTime(1);
    expect(sessionsStore.get("s1")!.notice).toBeUndefined();
  });

  it("I901 も同じ形で出す（ACS も開始の文言で上書きされる）", async () => {
    const s = await open({ startupCode: "I901" });
    expect(s.notice).toBe(startupStartedText("I901"));
    expect(startupStartedText("I901")).toContain("I901");
  });

  it("**I901・I902 以外のコードは「応答コード: …」**（ACS `KEY_RESPONSE_CODE`。I906 は自動サインオンが許されずサインオン画面が続くので「開始しました」は事実と違う）", async () => {
    expect(startupStartedText("I906")).toBe("応答コード: I906");
    expect(startupStartedText("I906")).not.toContain("開始");
    const s = await open({ startupCode: "I906" });
    expect(s.notice).toBe("応答コード: I906");
    expect(s.startupCode).toBe("I906");
  });

  it("**関連付けるプリンターが使えず関連付けなしで開いたら、その理由を出す**（3 秒で消さない。開始の知らせより優先）", async () => {
    for (const issue of ["invalid", "failed", "timeout"] as const) {
      sessionsStore.byId.clear();
      sessionsStore.order = [];
      clients = [];
      const s = await open({ startupCode: "I902", associatedPrinterIssue: issue });
      expect(s.notice, issue).toBe(MSG_ASSOC_PRINTER_ISSUE[issue]);
      vi.advanceTimersByTime(STARTUP_NOTICE_MS * 5);
      expect(sessionsStore.get("s1")!.notice, `${issue}: 消えない`).toBe(MSG_ASSOC_PRINTER_ISSUE[issue]);
      closeSession("s1");
    }
  });

  it("理由の文言は 3 種類とも違い、「5250端末」でなく「開きました」で終わる自然な日本語（です・ます調）", () => {
    const all = Object.values(MSG_ASSOC_PRINTER_ISSUE);
    expect(new Set(all).size).toBe(3);
    for (const m of all) expect(m.endsWith("開きました")).toBe(true);
  });

  it("エラー状態に入る文言ではない", () => {
    expect(isOperatorError(startupStartedText("I902"))).toBe(false);
  });

  it("**3 秒の間に別の通知が出たら、そちらは消さない**", async () => {
    const s = await open({ startupCode: "I902" });
    sessionsStore.get("s1")!.notice = "別の通知";
    vi.advanceTimersByTime(STARTUP_NOTICE_MS);
    expect(sessionsStore.get("s1")!.notice).toBe("別の通知");
    expect(s.startupCode).toBe("I902");
  });

  it("**先に出ている通知（留守中の PC コマンド等）は上書きしない**（コードは覚える）", async () => {
    const s = await open({
      startupCode: "I902",
      pcCommands: [{ at: "2026-09-21T00:00:00Z", command: "notepad", status: "disabled" }]
    });
    expect(s.notice).toBeDefined();
    expect(s.notice).not.toBe(startupStartedText("I902"));
    expect(s.startupCode).toBe("I902");
  });

  it("起動応答が無ければ何も出さない（3270・VT）", async () => {
    const s = await open();
    expect(s.notice).toBeUndefined();
    expect(s.startupCode).toBeUndefined();
  });

  it("**繋ぎ直したら新しいコードで出す**（繋ぎ直しの通知は消える）", async () => {
    const s = await open({ startupCode: "I902" });
    vi.advanceTimersByTime(STARTUP_NOTICE_MS);
    clients[0]!.handlers.onServerMessage({ type: "host-reconnecting", attempt: 1, reason: "x" });
    expect(s.notice).toBe(msgHostReconnecting(1));
    clients[0]!.handlers.onServerMessage({ type: "host-reconnected", startupCode: "I901" });
    expect(sessionsStore.get("s1")!.notice).toBe(startupStartedText("I901"));
    expect(sessionsStore.get("s1")!.startupCode).toBe("I901");
  });

  it("ⓘ に表示セッションの起動応答のコードが出る", async () => {
    await open({ startupCode: "I901" });
    const w = mount(SessionInfo, { props: { sessionId: "s1" } as never });
    expect(w.text()).toContain("起動");
    expect(w.text()).toContain("I901");
    w.unmount();
  });
});
