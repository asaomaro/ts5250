import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import MessageQuickView from "../src/components/MessageQuickView.vue";

/**
 * ステータスバーの「✉ メッセージあり」クリックで開くクイックビュー（`decisions.md` D12）。
 * `MessagePane.vue`の縮小版——読む・照会に応答する、だけを見る（消す・送るは持たない）。
 */
function fetchMock() {
  const fn = vi.fn();
  vi.stubGlobal("fetch", fn);
  return fn;
}
const reply = (body: unknown, ok = true): Promise<Response> =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

afterEach(() => vi.unstubAllGlobals());

const MSG = {
  key: "0000000A",
  id: "CPF1234",
  type: "INFO",
  severity: 0,
  text: "ジョブが完了しました",
  secondLevel: null,
  timestamp: "2026-09-26-00.00.00",
  fromUser: "QSYS",
  fromJob: "JOB1"
};
const INQUIRY = { ...MSG, key: "0000000B", id: "CPA1234", type: "INQUIRY", severity: 40, text: "続けますか？" };

describe("MessageQuickView: 表示", () => {
  it("mount時に既定の待ち行列（defaultQueue）でメッセージを取得する", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [MSG] }));
    mount(MessageQuickView, { props: { systemRef: "own:s-1", defaultQueue: "ASAO" } });
    await flushPromises();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/host/messages");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ source: { system: "own:s-1" }, queue: "ASAO" });
  });

  it("defaultQueue未指定ならQSYSOPRを既定にする（MessagePane.vueと同じ既定）", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [] }));
    mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    const body = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.queue).toBe("QSYSOPR");
  });

  it("取得したメッセージのIDと本文を表示する", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [MSG] }));
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    expect(w.text()).toContain("CPF1234");
    expect(w.text()).toContain("ジョブが完了しました");
  });

  it("INQUIRYだけ応答欄を出す（通常メッセージには出さない。誤操作を誘わないため）", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [MSG, INQUIRY] }));
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    expect(w.findAll(".reply")).toHaveLength(1);
  });

  it("メッセージが無ければ「メッセージはありません」と出す", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [] }));
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    expect(w.text()).toContain("メッセージはありません");
  });

  it("取得に失敗したらエラー文言を出す", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ error: "接続できません", code: "CONNECT_FAILED" }, false));
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    expect(w.text()).toContain("接続できません");
  });
});

describe("MessageQuickView: 照会への応答", () => {
  it("応答するとreplyを送り、その後読み直す", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [INQUIRY] })); // 初回取得
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1", defaultQueue: "ASAO" } });
    await flushPromises();

    fetch.mockResolvedValueOnce(reply({ success: true })); // 応答
    fetch.mockResolvedValueOnce(reply({ messages: [] })); // 応答後の読み直し
    await w.find(".reply input").setValue("G");
    await w.find(".reply button").trigger("click");
    await flushPromises();

    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("/api/host/messages/reply");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ source: { system: "own:s-1" }, queue: "ASAO", key: "0000000B", reply: "G" });
    expect(w.text()).toContain("応答しました");
  });

  it("空の応答では送信ボタンが押せない", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [INQUIRY] }));
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    expect(w.find(".reply button").attributes("disabled")).toBeDefined();
  });
});

describe("MessageQuickView: 開閉", () => {
  it("バックドロップをクリックするとcloseを発火する", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [] }));
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    await w.find(".backdrop").trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("本体のクリックはcloseを発火しない（バックドロップまで伝播させない）", async () => {
    const fetch = fetchMock();
    fetch.mockResolvedValueOnce(reply({ messages: [] }));
    const w = mount(MessageQuickView, { props: { systemRef: "own:s-1" } });
    await flushPromises();

    await w.find(".msgqv").trigger("click");
    expect(w.emitted("close")).toBeUndefined();
  });
});
