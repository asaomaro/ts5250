import { describe, it, expect, beforeEach } from "vitest";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import { systemsStore } from "../src/stores/systems.js";
import { workspaceStore } from "../src/stores/workspace.js";

/**
 * **セッションは明示的な切断以外では切らない。**
 *
 * ライフサイクルは「1 タブ = 1 WebSocket = サーバーの 1 セッション = ホストへの 1 接続」。
 * WebSocket を持つのは `sessionsStore` で、Vue コンポーネントではない。だからタブを切り替えても
 * システムを切り替えても接続には触れない（システム選択は `visibleTabs` の絞り込みでしかない）。
 *
 * 切れるのは次の 2 つだけ:
 *   - タブの × （`closeSession` → サーバーへ `close`）
 *   - WebSocket が閉じたとき（ブラウザタブを閉じる・リロード・ブラウザ終了・通信断）
 *
 * ここは前者の「切替では切れない」を固定する。実機で「切替後に戻ると再接続できない」と
 * 報告されたが、原因は切断ではなくメニューから 2 本目を開いてしまうことだった。
 */
function live(sessionId: string, configRef: string): SessionState {
  return {
    sessionId,
    label: sessionId,
    configRef,
    snapshot: undefined,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: false,
    client: { close: () => {}, send: () => {} } as unknown as SessionState["client"]
  };
}

beforeEach(() => {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  systemsStore.selected = undefined;
  workspaceStore.init();
});

describe("システム切替でセッションは切れない", () => {
  it("切り替えても接続は残り、戻すとタブがまた見える", () => {
    sessionsStore.add(live("s-jp", "own:ses-jp"));
    workspaceStore.addSession("s-jp", "own:sys-jp");
    sessionsStore.add(live("s-pub", "own:ses-pub"));
    workspaceStore.addSession("s-pub", "own:sys-pub");

    const g = workspaceStore.focusedGroup();

    // JP を選択 → JP のタブだけ見える
    systemsStore.select("own:sys-jp");
    expect(workspaceStore.visibleTabs(g, systemsStore.selected)).toEqual(["s-jp"]);

    // pub400 へ切替 → 見えるのは pub400 のタブ。**接続は 2 本とも生きている**
    systemsStore.select("own:sys-pub");
    expect(workspaceStore.visibleTabs(g, systemsStore.selected)).toEqual(["s-pub"]);
    expect(sessionsStore.all.map((s) => s.sessionId)).toEqual(["s-jp", "s-pub"]);
    expect(sessionsStore.all.every((s) => s.connected)).toBe(true);

    // JP へ戻す → タブがまた見える（作り直しではなく同じセッション）
    systemsStore.select("own:sys-jp");
    expect(workspaceStore.visibleTabs(g, systemsStore.selected)).toEqual(["s-jp"]);
    expect(sessionsStore.get("s-jp")?.connected).toBe(true);
  });

  it("設定 ref から開いているセッションを引ける（メニューが「開く」を出す根拠）", () => {
    sessionsStore.add(live("s-jp", "own:ses-jp"));
    expect(sessionsStore.all.find((s) => s.configRef === "own:ses-jp")?.sessionId).toBe("s-jp");
    expect(sessionsStore.all.find((s) => s.configRef === "own:ses-none")).toBeUndefined();
  });
});
