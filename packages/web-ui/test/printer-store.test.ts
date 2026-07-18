import { describe, it, expect, beforeEach } from "vitest";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";

function printerState(id: string): SessionState {
  return {
    sessionId: id,
    label: id,
    kind: "printer",
    snapshot: undefined,
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: true,
    reports: [],
    client: {} as unknown as SessionState["client"],
    meta: { host: "pub400.com", deviceName: "PRT_TEST", ccsid: 1399, sessionType: "printer" }
  };
}

describe("sessionsStore: プリンター未読・メタ", () => {
  beforeEach(() => {
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });

  it("addReport で unread が増え、markSpoolRead で 0 になる", () => {
    sessionsStore.add(printerState("p1"));
    sessionsStore.addReport("p1", { id: "r1", pages: [] });
    sessionsStore.addReport("p1", { id: "r2", pages: [] });
    expect(sessionsStore.get("p1")!.unread).toBe(2);
    sessionsStore.markSpoolRead("p1");
    expect(sessionsStore.get("p1")!.unread).toBe(0);
  });

  it("最初の受信は自動選択され、接続メタは保持される", () => {
    sessionsStore.add(printerState("p2"));
    sessionsStore.addReport("p2", { id: "r1", pages: [] });
    const s = sessionsStore.get("p2")!;
    expect(s.selectedReportId).toBe("r1");
    expect(s.meta?.deviceName).toBe("PRT_TEST");
    expect(s.meta?.ccsid).toBe(1399);
  });
});
