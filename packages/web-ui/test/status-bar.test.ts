import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import StatusBar from "../src/components/StatusBar.vue";
import type { ScreenSnapshot } from "@as400web/tn5250";
import type { SessionState } from "../src/stores/sessions.js";
import type { WsClient } from "../src/ws-client.js";
import { MSG_BY_REASON } from "../src/composables/opMessages.js";

function snap(): ScreenSnapshot {
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 3, col: 5 }, // ホスト由来
    keyboardLocked: false,
    cells: [],
    fields: []
  } as unknown as ScreenSnapshot;
}


function state(): SessionState {
  return {
    sessionId: "s",
    label: "t",
    snapshot: snap(),
    edits: new Map(),
    cursor: { row: 3, col: 5 },
    connected: true,
    readOnly: false,
    client: {} as WsClient
  };
}

describe("StatusBar のカーソル位置表示（ACS 相当）", () => {
  it("有効カーソルを 行/列（ゼロ埋め）で表示する", () => {
    const w = mount(StatusBar, { props: { state: state(), cursor: { row: 20, col: 7 } } });
    expect(w.find(".pos").text()).toBe("20/007");
  });

  it("ユーザーのカーソル移動に追従する（ホスト由来の snapshot.cursor ではない）", () => {
    const w = mount(StatusBar, { props: { state: state(), cursor: { row: 9, col: 42 } } });
    expect(w.find(".pos").text()).toBe("09/042"); // snapshot.cursor(3,5) ではない
  });

  it("cursor 未指定ならホスト由来へフォールバックする", () => {
    const w = mount(StatusBar, { props: { state: state() } });
    expect(w.find(".pos").text()).toBe("03/005");
  });
});

/**
 * クライアント側メッセージはホストのメッセージを**隠す**（ACS 準拠）。
 * notice が消えれば systemMessage が自然に戻る（復帰のための状態は持たない）。
 */
