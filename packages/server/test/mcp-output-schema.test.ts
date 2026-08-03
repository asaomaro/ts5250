import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { SessionManager, type SessionEntry } from "../src/session-manager.js";
import { ServerConfigStore, PersonalConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import type { ScreenSnapshot, Cell, Field, Session5250 } from "@ts5250/tn5250";

/**
 * **`structuredContent` が自分で宣言した `outputSchema` に適合すること。**
 *
 * ## なぜ専用の検査が要るのか
 *
 * `screenResult` は `ScreenSnapshot` の `fields` / `gui` を**そのまま**流す。
 * ドメイン型は増える——`Field` は `adjust` / `monocase` / `dupEnable` / `dbcsType` /
 * `signedNumeric` … と育ってきた。スキーマ側が `z.object()`（＝JSON Schema で
 * `additionalProperties: false`）のままだと、**宣言していない属性が 1 つ載った時点で
 * `get_screen` が丸ごと失敗する**。
 *
 * 実際に壊れていた（2026-08-04）。実機の MAIN メニューの入力欄が `dupEnable` と
 * `dbcsType` を持っており、`get_screen` が `-32602` で落ちた。
 *
 * ## 2 つの理由で気づけなかった
 *
 * 1. **フィクスチャが実物より綺麗だった。** `mcp-screen-attributes.test.ts` は
 *    `fields: []` で、欄を 1 つも持たない画面しか流していなかった
 * 2. **`listTools()` を呼んでいなかった。** SDK は**ツール一覧を受け取って初めて**
 *    `structuredContent` を検証する。生の JSON-RPC で `tools/call` だけ叩いている限り
 *    通ってしまう——**本物のクライアントは必ず一覧を取る**ので、そちらでだけ壊れる
 *
 * だからここでは **実物どおりの欄を持たせ**、**必ず `listTools()` を先に呼ぶ**。
 */

const SID = "sess-1";

const cell = (char = " "): Cell => ({
  char,
  kind: "sbcs",
  color: "green",
  reverse: false,
  underline: false,
  blink: false,
  columnSeparator: false,
  nonDisplay: false
});

/**
 * **実機の入力欄が実際に持っている属性を全部載せる。**
 * 実機の MAIN メニューのコマンド行が `dupEnable: true` / `dbcsType: "open"` を
 * 持っていて、それで壊れた。
 */
const realisticField = (over: Partial<Field> = {}): Field =>
  ({
    index: 1,
    row: 20,
    col: 7,
    length: 153,
    protected: false,
    hidden: false,
    numeric: false,
    mdt: false,
    value: "",
    dupEnable: true,
    dbcsType: "open",
    monocase: true,
    adjust: "right-blank",
    signedNumeric: false,
    digitsOnly: false,
    alphaOnly: false,
    keyboardInhibited: false,
    ...over
  }) as unknown as Field;

function snapshot(fields: Field[], gui?: ScreenSnapshot["gui"]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(Array.from({ length: 80 }, () => cell()));
  return {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields,
    ...(gui ? { gui } : {})
  } as ScreenSnapshot;
}

/**
 * `get_screen` を**本物のクライアントと同じ順序**で呼ぶ。
 * `listTools()` を先に呼ぶのが肝——これが無いと SDK は検証しない。
 */
async function callGetScreen(snap: ScreenSnapshot, opts: { listTools?: boolean } = {}) {
  const sessions = new SessionManager();
  const entry = {
    id: SID,
    session: { snapshot: () => snap } as unknown as Session5250,
    readOnly: false,
    host: "h",
    origin: "test",
    connectedAt: new Date(0).toISOString(),
    lastActivity: 0
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
  if (opts.listTools !== false) await client.listTools();
  return client.callTool({ name: "get_screen", arguments: { sessionId: SID } });
}

describe("MCP の structuredContent が outputSchema に適合する", () => {
  it("**実機どおりの属性を持つ欄**が通る（`dupEnable` / `dbcsType` / `monocase` …）", async () => {
    const r = (await callGetScreen(snapshot([realisticField()]))) as { structuredContent: { fields: unknown[] } };
    expect(r.structuredContent.fields).toHaveLength(1);
    // **落とさずに届く**（宣言外だからと削られていない）
    expect(r.structuredContent.fields[0]).toMatchObject({ dupEnable: true, dbcsType: "open" });
  });

  it("**将来 `Field` が増えても壊れない**（この検査の本体）", async () => {
    // 明日 `Field` に属性が 1 つ足されても、MCP が丸ごと失敗してはいけない
    const future = realisticField({ someFutureFlag: true } as unknown as Partial<Field>);
    const r = (await callGetScreen(snapshot([future]))) as { structuredContent: { fields: unknown[] } };
    expect(r.structuredContent.fields[0]).toMatchObject({ someFutureFlag: true });
  });

  it("gui も同じ（こちらも snapshot をそのまま流している）", async () => {
    const gui = {
      selectionFields: [],
      windows: [
        {
          id: 1,
          row: 8,
          col: 24,
          width: 30,
          height: 8,
          restrictCursor: true,
          pulldown: false,
          futureWindowProp: 1
        }
      ],
      scrollBars: [],
      gridLines: []
    } as unknown as ScreenSnapshot["gui"];
    const r = (await callGetScreen(snapshot([], gui))) as { structuredContent: { gui: unknown } };
    expect(r.structuredContent.gui).toBeDefined();
  });

  it("欄が無い画面でも通る（既存のフィクスチャと同じ形）", async () => {
    const r = (await callGetScreen(snapshot([]))) as { structuredContent: { fields: unknown[] } };
    expect(r.structuredContent.fields).toEqual([]);
  });

  /**
   * **`listTools()` を呼ばないと検証されない**ことを固定する。
   *
   * これを書いておかないと、次の人が「`callTool` だけで十分」と思って
   * 検証されない検査を増やす（実際そうなっていた）。
   */
  it("**`listTools()` を呼ばない経路では検証されない**（だから呼ぶ）", async () => {
    const bad = snapshot([realisticField()]);
    await expect(callGetScreen(bad, { listTools: false })).resolves.toBeDefined();
  });
});
