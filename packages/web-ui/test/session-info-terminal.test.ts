import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import SessionInfo from "../src/components/SessionInfo.vue";
import { sessionsStore, type SessionState, type SessionMeta } from "../src/stores/sessions.js";

/**
 * 開いているセッションの「種別」。
 *
 * `kind` は画面かプリンターかしか言わない。**端末の種類は `meta.terminal`**
 * ——`display` を一律「5250端末」と書くと、3270 で繋いだセッションが 5250 に見える
 * （一覧の札は直っていたのに、こちらと設定カードの ⓘ が残っていた）。
 */
const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) sessionsStore.remove(id);
});

function paneFor(meta: SessionMeta, kind?: "printer") {
  const id = `s-${ids.length}-${meta.terminal ?? "none"}-${kind ?? "display"}`;
  sessionsStore.add({
    sessionId: id,
    label: "テスト",
    edits: new Map(),
    connected: true,
    readOnly: false,
    client: {} as never,
    meta,
    ...(kind !== undefined ? { kind } : {})
  } as unknown as SessionState);
  ids.push(id);
  return mount(SessionInfo, { props: { sessionId: id } });
}

describe("セッション情報の種別", () => {
  it("**3270 で繋いだセッションは「3270端末」と出る**", () => {
    expect(paneFor({ terminal: "3270", host: "127.0.0.1" }).text()).toContain("3270端末");
  });

  it("5250 は従来どおり（指定なしも 5250）", () => {
    expect(paneFor({ terminal: "5250" }).text()).toContain("5250端末");
    expect(paneFor({}).text()).toContain("5250端末");
  });

  it("プリンターは端末の種類に関係しない", () => {
    const t = paneFor({ terminal: "3270" }, "printer").text();
    expect(t).toContain("プリンター");
    expect(t).not.toContain("端末");
  });
});
