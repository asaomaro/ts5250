import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import PrinterPane from "../src/components/PrinterPane.vue";
import { sessionsStore, type SessionState, createSessionState, type SessionStateInit } from "../src/stores/sessions.js";
import {
  MSG_PRINTER_HELD,
  MSG_PRINTER_RETRY,
  MSG_PRINTER_CANCEL,
  MSG_PRINTER_CANCELED,
  MSG_PRINTER_DROPPED,
  MSG_PRINTER_CHIP_HELD,
  MSG_PRINTER_CHIP_CANCELED,
  MSG_PRINTER_CHIP_DROPPED
} from "../src/composables/opMessages.js";

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
    expect(w.text()).toContain(MSG_PRINTER_CHIP_HELD);
    const [retry, cancel] = w.findAll(".held-btn");
    expect(retry!.text()).toBe(MSG_PRINTER_RETRY);
    expect(cancel!.text()).toBe(MSG_PRINTER_CANCEL);
    await retry!.trigger("click");
    await cancel!.trigger("click");
    expect(send.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(["printer-output-retry", "printer-output-cancel"]);
    w.unmount();
  });

  it("止めていなければバーを出さない。取消した帳票は「取消」と出し、成功していた PDF の結果も残す", () => {
    addPrinterSession({
      outputStatuses: { r1: { spoolId: "r1", at: Date.now(), canceled: true, pdf: { ok: true, path: "/out/r1.pdf" } } }
    });
    const w = mount(PrinterPane, { props: { sessionId: SID } });
    expect(w.find(".held-bar").exists()).toBe(false);
    expect(w.text()).toContain(MSG_PRINTER_CHIP_CANCELED);
    expect(w.text()).toContain(MSG_PRINTER_CANCELED);
    expect(w.text(), "取消で PDF ✓ と保存先が消えた").toContain("PDF ✓");
    expect(w.text()).toContain("/out/r1.pdf");
    w.unmount();
  });

  it("**止めている間に切れた帳票はバーを下ろし、切断で未応答と出す**", () => {
    addPrinterSession({ outputStatuses: { r1: { spoolId: "r1", at: Date.now(), dropped: true, pdf: { ok: false } } } });
    const w = mount(PrinterPane, { props: { sessionId: SID } });
    expect(w.find(".held-bar").exists()).toBe(false);
    expect(w.text()).toContain(MSG_PRINTER_CHIP_DROPPED);
    expect(w.text()).toContain(MSG_PRINTER_DROPPED);
    w.unmount();
  });

  it("ホスト変換で作らなかった PDF は失敗（✗）と出さない", () => {
    addPrinterSession({
      outputStatuses: { r1: { spoolId: "r1", at: Date.now(), pdf: { ok: false, skipped: true, error: "PDF にできません" } } }
    });
    const w = mount(PrinterPane, { props: { sessionId: SID } });
    expect(w.text()).toContain("PDF —");
    expect(w.text()).not.toContain("PDF ✗");
    expect(w.text()).not.toContain("PDF 保存に失敗");
    w.unmount();
  });
});
