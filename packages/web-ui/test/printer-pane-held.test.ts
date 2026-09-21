import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import PrinterPane from "../src/components/PrinterPane.vue";
import { sessionsStore, type SessionState, createSessionState, type SessionStateInit } from "../src/stores/sessions.js";
import { MSG_PRINTER_HELD, MSG_PRINTER_RETRY, MSG_PRINTER_CANCEL, MSG_PRINTER_CANCELED } from "../src/composables/opMessages.js";

/**
 * **出力に失敗して応答を止めている帳票**の表示と、再試行・取消（ACS のプリンター・エラー。`20260921-printer-hold-response`）。
 * 止めている間ホストはスプールを印刷済みにしないので、利用者が選ぶまで待つ。
 */
const SID = "ph1";
function addPrinterSession(over: Partial<SessionState> = {}): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add(createSessionState({
    sessionId: SID, label: "prt", kind: "printer", snapshot: undefined, edits: new Map(),
    cursor: { row: 1, col: 1 }, link: { state: "connected" }, resumability: "resumable", readOnly: false,
    reports: [{ id: "r1", pages: [{ rows: 1, cols: 1, lines: ["A"] }], receivedAt: Date.now() }],
    selectedReportId: "r1", outputConfigured: true, outputEnabled: true,
    client: { send } as unknown as SessionState["client"],
    ...over
  } as unknown as SessionStateInit));
  return { send };
}

describe("PrinterPane: 応答を止めている帳票", () => {
  it("**止めているとバーを出し、再試行・取消を送れる**", async () => {
    const { send } = addPrinterSession({
      outputStatuses: { r1: { spoolId: "r1", at: Date.now(), held: true, pdf: { ok: false, error: "ENOENT" } } }
    });
    const w = mount(PrinterPane, { props: { sessionId: SID } });
    expect(w.find(".held-bar").exists()).toBe(true);
    expect(w.text()).toContain(MSG_PRINTER_HELD);
    expect(w.text()).toContain("応答停止中");
    const [retry, cancel] = w.findAll(".held-btn");
    expect(retry!.text()).toBe(MSG_PRINTER_RETRY);
    expect(cancel!.text()).toBe(MSG_PRINTER_CANCEL);
    await retry!.trigger("click");
    await cancel!.trigger("click");
    expect(send.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(["printer-output-retry", "printer-output-cancel"]);
    w.unmount();
  });

  it("止めていなければバーを出さない。取消した帳票は「取消」と出す", () => {
    addPrinterSession({ outputStatuses: { r1: { spoolId: "r1", at: Date.now(), canceled: true } } });
    const w = mount(PrinterPane, { props: { sessionId: SID } });
    expect(w.find(".held-bar").exists()).toBe(false);
    expect(w.text()).toContain("取消");
    expect(w.text()).toContain(MSG_PRINTER_CANCELED);
    w.unmount();
  });
});
