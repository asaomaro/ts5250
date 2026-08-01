import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { parseTraceJsonl } from "../src/trace/trace.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("Session5250 DBCS（合成 fixture リプレイ）", () => {
  it("ccsid 1399 で日本語 DBCS 画面をデコード・描画する（桁維持）", async () => {
    const entries = parseTraceJsonl(
      readFileSync(join(here, "fixtures", "synthetic-dbcs.jsonl"), "utf8")
    );
    const transport = new ReplayTransport(entries);
    const session = await Session5250.connect({ transport, id: "dbcs", ccsid: 1399 });
    expect(session.currentState).toBe("ready");
    const snap = session.snapshot();

    // 行 1: "User: " + 日本語ﾃｽﾄ が表示される
    const row1 = snap.cells[0]!.map((c) => (c.char === "" ? "" : c.char)).join("");
    expect(row1).toContain("User:");
    expect(row1).toContain("日本語");

    // DBCS セルの kind と桁位置を確認（"User: " は 6 桁、その後 SO→DBCS）
    const soIdx = snap.cells[0]!.findIndex((c) => c.kind === "so");
    expect(soIdx).toBeGreaterThan(0);
    expect(snap.cells[0]![soIdx + 1]!.kind).toBe("dbcs-lead");
    expect(snap.cells[0]![soIdx + 2]!.kind).toBe("dbcs-tail");

    // 全行 80 桁維持（DBCS 行でもズレない）
    expect(snap.cells[0]).toHaveLength(80);
  });
});
