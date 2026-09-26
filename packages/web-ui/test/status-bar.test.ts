import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import StatusBar from "../src/components/StatusBar.vue";
import MessageQuickView from "../src/components/MessageQuickView.vue";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import { createSessionState, type SessionState } from "../src/stores/sessions.js";
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
  return createSessionState({
    sessionId: "s",
    label: "t",
    snapshot: snap(),
    edits: new Map(),
    cursor: { row: 3, col: 5 },
    link: { state: "connected" },
    resumability: "resumable",
    readOnly: false,
    client: {} as WsClient
  });
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

/**
 * **フッターのキーの並び**（利用者の指示）。
 *
 * 移動・割込キー（Home / End / PageUp / PageDown / Attn / SysReq）は一度「その他」へ畳んだが、
 * **F1 などと同じ常時表示に戻した**——畳んでいると、待たされている最中に押したい
 * Attn / SysReq が 2 手先になる。並びと、開閉で位置が動かないことをここで留める。
 */
describe("StatusBar のキーの並び", () => {
  const labels = (w: ReturnType<typeof mount>): string[] =>
    w.findAll(".fkeys .fk").map((b) => b.text());

  it("Esc / Attn / SysReq は「その他」を開かなくても出ている", () => {
    const w = mount(StatusBar, { props: { state: state() } });
    for (const k of ["Esc", "Attn", "SysReq"]) expect(labels(w)).toContain(k);
  });

  it("カーソル移動・ページ送りは「その他」の中（常時行には出さない）", () => {
    const w = mount(StatusBar, { props: { state: state() } });
    for (const k of ["Home", "End", "PageUp", "PageDown"]) expect(labels(w)).not.toContain(k);
  });

  it("並びは F12 → Esc → Attn → SysReq → ⏎ → その他", () => {
    const w = mount(StatusBar, { props: { state: state() } });
    const l = labels(w);
    expect(l.slice(l.indexOf("F12"))).toEqual(["F12", "Esc", "Attn", "SysReq", "⏎", "▲ その他"]);
  });

  it("「その他」を開いても ⏎ は その他 の左隣のまま（押す場所が動かない）", async () => {
    const w = mount(StatusBar, { props: { state: state() } });
    await w.find(".fk.more").trigger("click");
    const l = labels(w);
    expect(l.slice(-2)).toEqual(["⏎", "▼ その他"]);
    // Esc / Attn / SysReq は開いても消えない（一覧に無いキーなので二重表示にならない）
    expect(l).toContain("Attn");
    expect(l).toContain("Esc");
    // 畳んだ側のキーは開いたときだけ出る
    expect(l).toContain("PageUp");
    // F1〜F12 は一覧側に出るので常時行からは消える（同じキーが 2 か所に出ない）
    expect(l).not.toContain("F1");
  });

  it("ファンクションキーの一覧は OIA より上に出す（フッターが下へずれない）", async () => {
    const w = mount(StatusBar, { props: { state: state() } });
    await w.find(".fk.more").trigger("click");
    // **描画順で見る**（多ルートなので element は先頭 1 つしか指さない）。
    // 先に keypad、その下に oia＝画面から見て一覧が上・フッターが下
    const html = w.html();
    expect(html.indexOf('class="keypad"')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('class="keypad"')).toBeLessThan(html.indexOf('class="oia"'));
  });
});

/**
 * **メッセージ待ち表示（MW）**（`20260921-message-waiting-indicator`）。
 * `*NOTIFY` の待ち行列にメッセージが届いたときにホストが点ける。以前は受け取っても
 * どこにも出していなかった（ACS は OIA に出す）。
 */
describe("StatusBar のメッセージ待ち表示", () => {
  function stateWith(messageWaiting: boolean, extra: Partial<SessionState> = {}): SessionState {
    const st = { ...state(), ...extra };
    st.snapshot = { ...snap(), ...(messageWaiting ? { messageWaiting: true } : {}) } as ScreenSnapshot;
    return st;
  }

  it("点いているときだけ出す", () => {
    const on = mount(StatusBar, { props: { state: stateWith(true), cursor: { row: 1, col: 1 } } });
    expect(on.find(".msgwait").exists()).toBe(true);
    const off = mount(StatusBar, { props: { state: stateWith(false), cursor: { row: 1, col: 1 } } });
    expect(off.find(".msgwait").exists()).toBe(false);
  });

  /**
   * **クリックで読める**（`20260924-vscode-extension` D12。利用者要望）。ただし
   * `systemRef`（`own:<id>`等）が無いと`/api/host/messages`を呼べない
   * （直接接続で開いたセッション）ので、その場合はボタンを disabled のまま出す
   * （隠さない——「届いている」こと自体は有用な情報のため）。
   */
  it("systemRefが無ければボタンはdisabledのまま（クリックしてもクイックビューは開かない）", async () => {
    const w = mount(StatusBar, { props: { state: stateWith(true), cursor: { row: 1, col: 1 } } });
    const btn = w.find("button.msgwait");
    expect(btn.attributes("disabled")).toBeDefined();
    await btn.trigger("click");
    expect(w.findComponent(MessageQuickView).exists()).toBe(false);
  });

  it("systemRefがあればクリックでMessageQuickViewが開き、systemRef/defaultQueueが渡る", async () => {
    // MessageQuickViewはmount時に/api/host/messagesを叩く（onMounted(refresh)）ので、
    // StatusBar側の点検（クリックで開くか・propsが正しく渡るか）とは無関係に応答を用意する
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ messages: [] }) }) as unknown as Response)
    );
    const w = mount(StatusBar, {
      props: {
        state: stateWith(true, { systemRef: "own:s-1", meta: { signonUser: "ASAO" } }),
        cursor: { row: 1, col: 1 }
      }
    });
    const btn = w.find("button.msgwait");
    expect(btn.attributes("disabled")).toBeUndefined();
    await btn.trigger("click");

    const view = w.findComponent(MessageQuickView);
    expect(view.exists()).toBe(true);
    expect(view.props("systemRef")).toBe("own:s-1");
    expect(view.props("defaultQueue")).toBe("ASAO");
  });

  afterEach(() => vi.unstubAllGlobals());
});
