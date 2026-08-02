import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PrinterPane from "../src/components/PrinterPane.vue";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";

/**
 * **累計と保持を区別して出す**（`20260802-printer-report-history`）。
 *
 * サーバーは 50 件で頭打ちにして古いものから落とす（`REPORT_LIMIT`）。
 * `reports.length` だけを「受信 N 件」と出すと**落ちた分がここで消える**——
 * 60 件受け取ったのに「受信 50 件」とだけ書かれる。
 *
 * ただし**普段は括弧を出さない**。50 件を超えるまで起きない状態のために、
 * 常時 2 つ並べると通常の見え方が煩くなる。
 */
const SID = "p1";
const rep = (id: string) => ({ id, pages: [{ rows: 1, cols: 3, lines: ["ABC"] }], receivedAt: 1 });

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

describe("PrinterPane: 受信件数の表示", () => {
  it("累計と保持が同じなら括弧を出さない", () => {
    const id = addPrinterSession({ reports: [rep("s1"), rep("s2")], receivedTotal: 2 });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).toContain("受信 2 件");
    expect(w.text()).not.toContain("保持");
    w.unmount();
  });

  it("**落ちた分があるなら両方出す**（累計が消えない）", () => {
    const id = addPrinterSession({ reports: [rep("s1"), rep("s2")], receivedTotal: 62 });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).toContain("受信 62 件（保持 2）");
    w.unmount();
  });

  it("累計が無い（古いサーバー）なら保持数に落とす", () => {
    const id = addPrinterSession({ reports: [rep("s1")] });
    const w = mount(PrinterPane, { props: { sessionId: id } });
    expect(w.text()).toContain("受信 1 件");
    expect(w.text()).not.toContain("保持");
    w.unmount();
  });
});
