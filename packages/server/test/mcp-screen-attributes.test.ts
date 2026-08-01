import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { SessionManager, type SessionEntry } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import type { ScreenSnapshot, Cell, Session5250 } from "@as400web/tn5250";

const ESC = "\u001b";

/**
 * **MCP から表示属性を取れること**を、ツール呼び出しの経路で確かめる。
 *
 * - `include: ["ansi"]` … 色つき画面を**人向けの別ブロック**（`audience: ["user"]`）で返す
 * - `include: ["attributes"]` … 属性の変わり目を `structuredContent.attributes` で返す
 *
 * outputSchema を宣言しているツールは、SDK が structuredContent を**検証する**。
 * つまりこの経路を通すだけで、スキーマと実際の中身の食い違いも捕まえられる
 * （窓の見出しを文字列から構造へ変えたとき、スキーマが取り残されていた）。
 */
const SID = "sess-1";

function cell(char: string, over: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green",
    reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false,
    ...over
  };
}

/** 1 行目の 1〜5 桁を赤の反転にし、窓（見出しつき）を 1 つ持つ画面 */
function snapshot(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    const text = r === 0 ? "ALERT!" : "";
    for (let c = 0; c < 80; c++) {
      row.push(cell(text[c] ?? " ", r === 0 && c < 5 ? { color: "red", reverse: true } : {}));
    }
    cells.push(row);
  }
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: [],
    gui: {
      selectionFields: [],
      windows: [{
        id: 1, row: 8, col: 24, width: 30, height: 8, restrictCursor: true, pulldown: false,
        title: { text: "CHAR BORDER", align: "center", footer: false, cba: 0x32 }
      }],
      scrollBars: [],
      gridLines: []
    }
  };
}

interface ToolResult {
  structuredContent: Record<string, unknown>;
  content: { type: string; text: string; annotations?: { audience?: string[] } }[];
}

async function getScreen(include?: string[]): Promise<ToolResult> {
  const sessions = new SessionManager();
  // get_screen は snapshot() しか触らないので、最小の偽セッションを差し込む
  const entry = {
    id: SID,
    session: { snapshot: () => snapshot() } as unknown as Session5250,
    readOnly: false, host: "h", origin: "test",
    connectedAt: new Date(0).toISOString(), lastActivity: 0
  } satisfies SessionEntry;
  (sessions as unknown as { sessions: Map<string, SessionEntry> }).sessions.set(SID, entry);

  const server = buildMcpServer({
    sessions,
    resolver: new ConfigResolver(
      new ServerConfigStore({ systems: [], sessions: [] }),
      new PersonalConfigStore({ systems: [], sessions: [] })
    ),
    version: "test"
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  return (await client.callTool({
    name: "get_screen",
    arguments: { sessionId: SID, ...(include ? { include } : {}) }
  })) as unknown as ToolResult;
}

describe("get_screen の表示属性", () => {
  it("既定では従来どおり本文だけ（色は付けない）", async () => {
    const r = await getScreen();
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.text).not.toContain(ESC);
    expect(r.structuredContent["attributes"]).toBeUndefined();
  });

  it("ansi は人向けの別ブロックで返る（本文は汚さない）", async () => {
    const r = await getScreen(["grid", "ansi"]);
    expect(r.content).toHaveLength(2);
    const forUser = r.content.find((c) => c.annotations?.audience?.includes("user"));
    const forModel = r.content.find((c) => c.annotations?.audience?.includes("assistant"));
    expect(forUser?.text).toContain(`${ESC}[0;31;7m`); // 赤・反転
    expect(forModel?.text).not.toContain(ESC); // 本文にエスケープを混ぜない
  });

  it("attributes は変わり目を構造で返す", async () => {
    const r = await getScreen(["grid", "attributes"]);
    expect(r.structuredContent["attributes"]).toEqual([
      { row: 1, col: 1, len: 5, color: "red", reverse: true }
    ]);
    expect(r.content[0]!.text).toContain("(1,1) len=5 red reverse");
  });

  /**
   * outputSchema と実際の中身が食い違うと SDK が弾く。
   * 窓の見出しを「文字列」から「文字＋寄せ方＋脚注＋色」に変えたとき、
   * スキーマ側が文字列のまま取り残されていた（この経路を通すテストが無く気付けなかった）。
   */
  it("見出しつきの窓を含む画面でも検証を通る", async () => {
    const r = await getScreen();
    const gui = r.structuredContent["gui"] as { windows: { title?: { text: string } }[] };
    expect(gui.windows[0]!.title).toEqual({
      text: "CHAR BORDER", align: "center", footer: false, cba: 0x32
    });
  });
});
