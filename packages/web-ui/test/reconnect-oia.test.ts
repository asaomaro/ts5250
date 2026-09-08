/**
 * 繋ぎ直しの見せ方（`20260908-session-survives-disconnect` AC-I1〜AC-I3）。
 *
 * **画面は覆わない**（覆いは応答待ち専用）。OIA に状態を出し、押して意味があるときだけ
 * 手動の繋ぎ直しを出す。猶予切れ（`"gone"`）では押しても同じ理由で失敗するので出さない。
 */
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import StatusBar from "../src/components/StatusBar.vue";
import type { SessionState } from "../src/stores/sessions.js";
import type { WsClient } from "../src/ws-client.js";

function state(extra: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "s1",
    label: "t",
    snapshot: undefined,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: false,
    client: { send: () => {} } as unknown as WsClient,
    ...extra
  } as SessionState;
}

const oia = (s: SessionState) => mount(StatusBar, { props: { state: s } });

describe("OIA の再接続表示", () => {
  // **見るのは入力状態の欄（`.ime`）だけ**。`w.text()` 全体で見ると、マクロの停止理由
  // （「切断されました」）にも当たってしまい、何を主張しているか曖昧になる
  const label = (w: ReturnType<typeof oia>): string => w.find(".ime").text();

  it("再接続中は「再接続中 (n/5)」を出す（「切断」より優先）", () => {
    const w = oia(state({ connected: false, reconnect: { attempt: 2, max: 5 } }));
    expect(label(w)).toContain("再接続中 (2/5)");
    expect(label(w)).not.toContain("切断");
  });

  it("再接続していない切断は従来どおり「切断」", () => {
    const w = oia(state({ connected: false }));
    expect(label(w)).toContain("切断");
  });

  it("**状態の変化は読み上げに載せる**（入力状態の欄そのものに付ける）", () => {
    const w = oia(state({ connected: false, reconnect: { attempt: 1, max: 5 } }));
    expect(w.find(".ime").attributes("role")).toBe("status");
  });

  it("再接続していないあいだは読み上げに載せない（常時のライブリージョンにしない）", () => {
    const w = oia(state());
    expect(w.find(".ime").attributes("role")).toBeUndefined();
  });

  it("**試行が尽きたら手動の繋ぎ直しを出す**（押せば再開する）", async () => {
    const w = oia(state({ connected: false, reconnectFailed: "retry" }));
    const btn = w.find("button.retry");
    expect(btn.exists()).toBe(true);

    await btn.trigger("click");

    expect(w.emitted("reconnect")).toHaveLength(1);
  });

  it("**猶予切れではボタンを出さない**（押しても同じ理由で失敗する）", () => {
    const w = oia(state({ connected: false, reconnectFailed: "gone" }));
    expect(w.find("button.retry").exists()).toBe(false);
  });

  it("繋がっているあいだはボタンを出さない", () => {
    const w = oia(state());
    expect(w.find("button.retry").exists()).toBe(false);
  });
});
