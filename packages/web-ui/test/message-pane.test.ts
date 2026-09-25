import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import MessagePane from "../src/components/MessagePane.vue";

/**
 * **回帰テスト**（`20260924-vscode-extension` D12）。`MessageQuickView.vue`を作る過程で、
 * `reply()`/`remove()`/`doSend()`が自分の`withBusy`の中から`refresh()`を呼んでおり、
 * `refresh()`自身の`busy.value`ガードに阻まれて**読み直しが起きない**バグを見つけた
 * （このコンポーネント自体には既存テストが無く、素通りしていた）。
 * mutationで確認済み（`fetchMessages()`への切り替えを戻すと、このテストは落ちる）。
 */
function fetchMock() {
  const fn = vi.fn();
  vi.stubGlobal("fetch", fn);
  return fn;
}
const reply = (body: unknown, ok = true): Promise<Response> =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

afterEach(() => vi.unstubAllGlobals());

const INQUIRY = {
  key: "0000000B",
  id: "CPA1234",
  type: "INQUIRY",
  severity: 40,
  text: "続けますか？",
  secondLevel: null,
  timestamp: "2026-09-26-00.00.00",
  fromUser: "QSYS",
  fromJob: "JOB1"
};

describe("MessagePane: 照会への応答後に一覧を読み直す", () => {
  it("応答が成功したら、読み直しのfetchが実際に発生する（busyガードの二重掛けで消えないことを固定する）", async () => {
    const fetch = fetchMock();
    const w = mount(MessagePane, { props: { tabId: "msg:queue@own:s1", system: "own:s1" } });

    fetch.mockResolvedValueOnce(reply({ messages: [INQUIRY] })); // 「読む」
    await w.find(".form button").trigger("click"); // 「読む」ボタン（form内の最初のbutton）
    await flushPromises();
    expect(w.text()).toContain("CPA1234");

    fetch.mockResolvedValueOnce(reply({ success: true })); // 応答
    fetch.mockResolvedValueOnce(reply({ messages: [] })); // 応答後の読み直し
    await w.find(".reply input").setValue("G");
    await w.find(".reply button").trigger("click");
    await flushPromises();

    // 読み直しが実際に起きた証拠: (1) fetchが3回目まで呼ばれ、(2) 一覧が空になっている
    // （バグがあると2回で止まり、CPA1234が画面に残ったまま）
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]![0]).toBe("/api/host/messages");
    expect(w.text()).not.toContain("CPA1234");
  });
});
