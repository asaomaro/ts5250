import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PrinterPane from "../src/components/PrinterPane.vue";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";

const SID = "p1";

function addPrinterSession(over: Partial<SessionState> = {}): string {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "prt",
    kind: "printer",
    snapshot: undefined,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: true,
    reports: [],
    client: {} as SessionState["client"],
    ...over
  } as SessionState);
  return SID;
}

describe("PrinterPane: 自動出力トグルと警告表示", () => {
  it("出力設定が無いセッションではトグルを出さない", () => {
    const id = addPrinterSession();
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).not.toContain("自動出力");
    w.unmount();
  });

  it("出力設定があるとトグルを出し、現在の状態を表示する", () => {
    const id = addPrinterSession({ outputConfigured: true, outputEnabled: true });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).toContain("自動出力: ON");
    w.unmount();
  });

  it("無効時は OFF と表示する", () => {
    const id = addPrinterSession({ outputConfigured: true, outputEnabled: false });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).toContain("自動出力: OFF");
    w.unmount();
  });

  it("PDF 作成・印刷の成否が一覧に簡易表示され、選択で詳細が出る", async () => {
    const id = addPrinterSession({
      outputConfigured: true,
      outputEnabled: true,
      reports: [{ id: "r1", pages: [{ rows: 1, cols: 5, lines: ["HELLO"] }], receivedAt: Date.now() }],
      selectedReportId: "r1",
      outputStatuses: {
        r1: {
          spoolId: "r1",
          at: Date.now(),
          pdf: { ok: true, path: "/data/out/20260718-x.pdf" },
          print: { ok: true, printer: "Office" }
        }
      }
    });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    // 一覧の簡易表示
    expect(w.text()).toContain("PDF ✓");
    expect(w.text()).toContain("印刷 ✓");
    // 選択中の詳細（保存先・プリンター名）
    expect(w.text()).toContain("/data/out/20260718-x.pdf");
    expect(w.text()).toContain("Office");
    w.unmount();
  });

  it("失敗・スキップも区別して表示する", () => {
    const id = addPrinterSession({
      outputConfigured: true,
      reports: [
        { id: "r1", pages: [{ rows: 1, cols: 1, lines: ["A"] }], receivedAt: Date.now() },
        { id: "r2", pages: [{ rows: 1, cols: 1, lines: ["B"] }], receivedAt: Date.now() }
      ],
      selectedReportId: "r1",
      outputStatuses: {
        r1: { spoolId: "r1", at: Date.now(), pdf: { ok: false, error: "ENOENT: no such directory" } },
        r2: { spoolId: "r2", at: Date.now(), skipped: true }
      }
    });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).toContain("PDF ✗");
    expect(w.text()).toContain("⏸ スキップ");
    // 選択中(r1)の詳細に理由が出る
    expect(w.text()).toContain("ENOENT: no such directory");
    w.unmount();
  });

  it("出力の失敗が警告バーに出て、✕ で消せる", async () => {
    const id = addPrinterSession({
      outputConfigured: true,
      outputEnabled: true,
      printerWarnings: [{ at: Date.now(), message: "PDF 保存に失敗（/var/spool/as400-pdf）: ENOENT" }]
    });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).toContain("PDF 保存に失敗");
    await w.find("button.warn-close").trigger("click");
    expect(w.text()).not.toContain("PDF 保存に失敗");
    w.unmount();
  });
});
