/**
 * 監視の WS 経路（`20260723-dtaq-watch-notify`）。
 *
 * 守るのはこの 3 点で、どれも要件の核心:
 *
 * 1. **`watch-*` は `open`（5250 セッション）を要さない**——監視コンソールは pane タブで
 *    セッションを持たないので、`requireSession()` を通すと一切使えない（research F6）
 * 2. **WS が切れても監視は止まらない**——`dispose()` は購読を外すだけ（research F1）
 * 3. 他人の監視は見えない・配られない
 */
import { describe, it, expect } from "vitest";
import { As400Error } from "@as400web/base";
import { type DtaqConnection } from "@as400web/hostserver";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { WatchRegistry } from "../src/watch-registry.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import type { WsServerMessage } from "../src/ws-messages.js";
import type { AuthUser } from "../src/auth.js";

const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };

/** 手で解決できる偽の DTAQ 接続（無限待ちを表現するため） */
class FakeConn {
  closed = false;
  private pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined;
  read(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve: resolve as (v: unknown) => void, reject };
    });
  }
  close(): void {
    this.closed = true;
    this.pending?.reject(new As400Error("SESSION_CLOSED", "closed"));
    this.pending = undefined;
  }
  deliver(text: string): void {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve({ data: new TextEncoder().encode(text) });
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** 監視設定を 1 本持つ個人設定 */
function personal(owner?: string) {
  return new PersonalConfigStore({
    systems: [{ id: "s", name: "s", host: "h", ...(owner ? { owner } : {}), signon: { user: "u" } }],
    sessions: [
      {
        id: "w1",
        name: "注文キュー",
        system: "s",
        sessionType: "dtaqwatch",
        dtaqWatch: { library: "MYLIB", name: "ORDERQ" },
        ...(owner ? { owner } : {})
      },
      // 監視でない設定（種別違いを弾けることの確認用）
      { id: "d1", name: "端末", system: "s", sessionType: "display", ...(owner ? { owner } : {}) }
    ]
  });
}

function setup(opts: { user?: AuthUser; owner?: string } = {}) {
  const sent: WsServerMessage[] = [];
  const conn = new FakeConn();
  const watches = new WatchRegistry({
    connect: async () => conn as unknown as DtaqConnection,
    delay: async () => undefined
  });
  const resolver = new ConfigResolver(new ServerConfigStore(), personal(opts.owner));
  const ws = new WsConnection(
    { sessions: new SessionManager(), resolver, watches },
    { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} },
    opts.user
  );
  const last = <T extends WsServerMessage["type"]>(type: T) =>
    [...sent].reverse().find((m) => m.type === type) as Extract<WsServerMessage, { type: T }> | undefined;
  return { ws, sent, conn, watches, last };
}

describe("watch-* は open を要さない", () => {
  it("`open` していない WS で購読できる（一覧が返る）", async () => {
    const { ws, last } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    expect(last("watch-list")?.watches).toEqual([]);
  });

  it("`open` していない WS で監視を始められる", async () => {
    const { ws, last, watches } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    expect(last("watch-list")?.watches).toHaveLength(1);
    expect(last("watch-list")?.watches[0]).toMatchObject({ label: "MYLIB/ORDERQ", state: "listening" });
    watches.closeAll();
  });

  it("種別が dtaqwatch でない設定は CONFIG_ERROR", async () => {
    const { ws, sent } = setup();
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:d1" }));
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "CONFIG_ERROR" });
  });
});

describe("到着の push と履歴", () => {
  it("届いたエントリが watch-entry で飛ぶ", async () => {
    const { ws, conn, last, watches } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    await settle();
    conn.deliver("ORD-1");
    await settle();
    expect(last("watch-entry")).toMatchObject({ received: 1, entry: { seq: 1, text: "ORD-1" } });
    watches.closeAll();
  });

  it("履歴を取り直せる（タブを開き直したとき）", async () => {
    const { ws, conn, last, watches } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    await settle();
    conn.deliver("ORD-1");
    await settle();
    const id = last("watch-list")!.watches[0]!.id;
    await ws.handle(JSON.stringify({ type: "watch-history", watchId: id }));
    expect(last("watch-history")?.entries.map((e) => e.text)).toEqual(["ORD-1"]);
    watches.closeAll();
  });

  it("停止しても一覧に残り、`stopped` になる（再開できるように）", async () => {
    const { ws, last, watches } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    const id = last("watch-list")!.watches[0]!.id;
    await ws.handle(JSON.stringify({ type: "watch-stop", watchId: id }));
    // **消さない**——消すと画面から開始ボタンを押せなくなる（`20260801-service-start-stop`）
    expect(last("watch-list")?.watches).toHaveLength(1);
    expect(last("watch-list")?.watches[0]?.state).toBe("stopped");
    expect(watches.size).toBe(1);
  });
});

describe("**WS が切れても監視は止まらない**（要件の核心）", () => {
  it("onSocketClose で監視が残る", async () => {
    const { ws, watches } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    expect(watches.size).toBe(1);
    ws.onSocketClose();
    expect(watches.size).toBe(1); // 止まっていない
    expect(watches.list()[0]?.state).toBe("listening");
    watches.closeAll();
  });

  it("切断後は push が飛ばない（購読だけ外れる）", async () => {
    const { ws, conn, sent, watches } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    await settle();
    ws.onSocketClose();
    sent.length = 0;
    conn.deliver("after-close");
    await settle();
    expect(sent.filter((m) => m.type === "watch-entry")).toEqual([]);
    // それでも履歴には入っている（開き直せば読める）
    expect(watches.list()[0]?.received).toBe(1);
    watches.closeAll();
  });

  it("開き直すと一覧が配り直され、閉じていた間の履歴が読める", async () => {
    const { ws, conn, watches, last } = setup();
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    await ws.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    await settle();
    ws.onSocketClose();
    conn.deliver("while-closed");
    await settle();

    // 別の WS で開き直す（同じレジストリを共有）
    const sent2: WsServerMessage[] = [];
    const ws2 = new WsConnection(
      { sessions: new SessionManager(), resolver: new ConfigResolver(new ServerConfigStore(), personal()), watches },
      { send: (d) => sent2.push(JSON.parse(d) as WsServerMessage), close: () => {} }
    );
    await ws2.handle(JSON.stringify({ type: "watch-subscribe" }));
    const list = sent2.find((m) => m.type === "watch-list") as { watches: { id: string }[] };
    expect(list.watches).toHaveLength(1);
    await ws2.handle(JSON.stringify({ type: "watch-history", watchId: list.watches[0]!.id }));
    const hist = sent2.find((m) => m.type === "watch-history") as { entries: { text: string }[] };
    expect(hist.entries.map((e) => e.text)).toEqual(["while-closed"]);
    void last;
    watches.closeAll();
  });
});

describe("所有者", () => {
  it("他人の監視は一覧に出ない・push も飛ばない", async () => {
    const sentB: WsServerMessage[] = [];
    const conn = new FakeConn();
    const watches = new WatchRegistry({
      connect: async () => conn as unknown as DtaqConnection,
      delay: async () => undefined
    });
    // alice が始める
    const wsA = new WsConnection(
      { sessions: new SessionManager(), resolver: new ConfigResolver(new ServerConfigStore(), personal("alice")), watches },
      { send: () => {}, close: () => {} },
      alice
    );
    await wsA.handle(JSON.stringify({ type: "watch-subscribe" }));
    await wsA.handle(JSON.stringify({ type: "watch-start", session: "own:w1" }));
    await settle();

    // bob が購読しても見えない
    const wsB = new WsConnection(
      { sessions: new SessionManager(), resolver: new ConfigResolver(new ServerConfigStore(), personal("alice")), watches },
      { send: (d) => sentB.push(JSON.parse(d) as WsServerMessage), close: () => {} },
      bob
    );
    await wsB.handle(JSON.stringify({ type: "watch-subscribe" }));
    const list = sentB.find((m) => m.type === "watch-list") as { watches: unknown[] };
    expect(list.watches).toEqual([]);
    sentB.length = 0;
    conn.deliver("secret");
    await settle();
    expect(sentB.filter((m) => m.type === "watch-entry")).toEqual([]);
    watches.closeAll();
  });
});

describe("レジストリが未配線のとき", () => {
  it("CONFIG_ERROR で断る（黙って無視しない）", async () => {
    const sent: WsServerMessage[] = [];
    const ws = new WsConnection(
      {
        sessions: new SessionManager(),
        resolver: new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore())
      },
      { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} }
    );
    await ws.handle(JSON.stringify({ type: "watch-subscribe" }));
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "CONFIG_ERROR" });
  });
});
