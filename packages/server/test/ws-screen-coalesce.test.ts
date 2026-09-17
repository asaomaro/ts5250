import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { ReplayTransport, parseTraceJsonl, type ScreenSnapshot, type Session5250, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";

/**
 * **ホスト応答の途中経過（施錠されたままの画面）は間引いて最新だけを出し、鍵盤が開いた画面は即座に出す。**
 *
 * 実機 YB0140R の窓で PageUp すると、1 回の AID に 4 レコード（RESTORE → WTD → SAVE → 窓の再作成）が
 * 40ms の間に届き、1 レコードずつ push すると「窓が消えた画面」が 1 フレーム見えてちらついた。
 * ACS は受信経路で画面イベントを出さず、途中の状態は描かれないまま上書きされる。
 *
 * **警報（`alarm`）は間引かない**——画面を変えないレコードでも来て、続けて 2 回鳴ることもある。
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

class InjectingManager extends SessionManager {
  constructor(private readonly makeTransport: () => Transport) {
    super();
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: this.makeTransport() });
  }
}

/** セッションのイベントをテストから起こす（`emit` は protected なので型を外す） */
type Emitting = { emit(event: string, ...args: unknown[]): void };

async function openSession() {
  const sent: WsServerMessage[] = [];
  const mgr = new InjectingManager(() => new ReplayTransport(signon()));
  const resolver = new ConfigResolver(
    new ServerConfigStore({ systems: [{ id: "p", name: "p", host: "h" }], sessions: [] }),
    new PersonalConfigStore()
  );
  const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
  await conn.handle(JSON.stringify({ type: "open", host: "h" }));
  const sessionId = (sent[0] as { sessionId: string }).sessionId;
  const session: Session5250 = mgr.get(sessionId).session;
  const base = session.snapshot();
  /** 行番号を目印にした画面を 1 枚起こす */
  const screen = (mark: number, keyboardLocked: boolean): void =>
    (session as unknown as Emitting).emit("screen", {
      ...base,
      keyboardLocked,
      cursor: { row: mark, col: 1 }
    } satisfies ScreenSnapshot);
  const screens = (): number[] =>
    sent.filter((m) => m.type === "screen").map((m) => (m as { screen: ScreenSnapshot }).screen.cursor.row);
  sent.length = 0;
  return { conn, mgr, sent, session, screen, screens };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("施錠中の画面は間引いて出す", () => {
  it("鍵盤が開いた画面は待たずにすぐ出す", async () => {
    const { mgr, screen, screens } = await openSession();
    screen(1, false);
    expect(screens()).toEqual([1]);
    mgr.closeAll();
  });

  it("施錠中の画面が続いたら、一拍おいて最新の 1 枚だけを出す", async () => {
    const { mgr, screen, screens } = await openSession();
    vi.useFakeTimers();
    screen(1, true);
    screen(2, true);
    screen(3, true);
    expect(screens(), "途中経過はまだ出さない").toEqual([]);
    vi.advanceTimersByTime(50);
    expect(screens()).toEqual([3]);
    // 何も溜まっていなければ、それ以上は出さない
    vi.advanceTimersByTime(200);
    expect(screens()).toEqual([3]);
    mgr.closeAll();
  });

  it("待っている間に鍵盤が開いた画面が来たら、途中経過を捨ててそれをすぐ出す", async () => {
    const { mgr, screen, screens } = await openSession();
    vi.useFakeTimers();
    screen(1, true); // RESTORE SCREEN（窓が消えた背面）相当
    screen(2, true);
    screen(3, false); // 窓を作り直して入力待ち
    expect(screens()).toEqual([3]);
    vi.advanceTimersByTime(200);
    expect(screens(), "捨てた途中経過を後から出さない").toEqual([3]);
    mgr.closeAll();
  });

  it("時間の掛かる処理の途中経過（施錠のまま）も、握り潰さずに出す", async () => {
    const { mgr, screen, screens } = await openSession();
    vi.useFakeTimers();
    screen(1, true);
    vi.advanceTimersByTime(50);
    screen(2, true);
    vi.advanceTimersByTime(50);
    expect(screens()).toEqual([1, 2]);
    mgr.closeAll();
  });

  it("購読を外したら、待っている画面は出さない", async () => {
    const { conn, screen, screens } = await openSession();
    vi.useFakeTimers();
    screen(1, true);
    await conn.handle(JSON.stringify({ type: "close" }));
    vi.advanceTimersByTime(200);
    expect(screens()).toEqual([]);
  });
});

describe("警報は画面と別に、間引かずに流す", () => {
  it("alarm を受けるたびに alarm メッセージを送る", async () => {
    const { mgr, session, sent } = await openSession();
    (session as unknown as Emitting).emit("alarm");
    (session as unknown as Emitting).emit("alarm");
    expect(sent.filter((m) => m.type === "alarm")).toHaveLength(2);
    mgr.closeAll();
  });

  it("購読を外したら送らない", async () => {
    const { conn, session, sent } = await openSession();
    await conn.handle(JSON.stringify({ type: "close" }));
    (session as unknown as Emitting).emit("alarm");
    expect(sent.filter((m) => m.type === "alarm")).toHaveLength(0);
  });
});
