import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import StatusBar from "../src/components/StatusBar.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { sendKey } from "../src/session-controller.js";
import { MSG_NO_RESPONSE } from "../src/composables/opMessages.js";
import type { ScreenSnapshot } from "@as400web/tn5250";
import type { WsClient } from "../src/ws-client.js";

/**
 * **無応答を無言で戻さない。**
 * Attn / SysReq はホストが黙って無視することが正常にあり得る（ATNPGM が既に前面のとき等）。
 * 何も出さないと「押したのに何も起きない」が不具合と区別できない——実際その report を受けた。
 */

const SID = "nr1";

function snap(): ScreenSnapshot {
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells: [], fields: []
  } as unknown as ScreenSnapshot;
}

function seed(send: (m: unknown) => void = () => {}) {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(), edits: new Map(),
    cursor: { row: 1, col: 1 }, connected: true, readOnly: false,
    client: { send } as unknown as WsClient
  });
  return sessionsStore.get(SID)!;
}

describe("ホスト無応答の通知", () => {
  it("SessionState.notice を StatusBar が操作員メッセージとして出す", async () => {
    const st = seed();
    const w = mount(StatusBar, { props: { state: st, notice: st.notice ?? "" } });
    expect(w.text()).not.toContain(MSG_NO_RESPONSE);

    st.notice = MSG_NO_RESPONSE;
    await w.setProps({ notice: st.notice ?? "" });
    expect(w.find(".msg.notice").text()).toBe(MSG_NO_RESPONSE);
  });

  it("次の送信で通知が消える", () => {
    const send = vi.fn();
    const st = seed(send);
    st.notice = MSG_NO_RESPONSE;

    sendKey(SID, "Enter");
    expect(st.notice).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it("通信中は送信しないので通知も消さない（多重送信プロテクトと整合）", () => {
    const send = vi.fn();
    const st = seed(send);
    st.notice = MSG_NO_RESPONSE;
    st.busy = true;

    sendKey(SID, "Enter");
    expect(st.notice).toBe(MSG_NO_RESPONSE);
    expect(send).not.toHaveBeenCalled();
  });
});
