import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { parseRef } from "../src/config-types.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

/** SessionManager が transport を注入できるよう、open のたびに新しい ReplayTransport を返すよう細工した Manager */
class InjectingManager extends SessionManager {
  constructor(private readonly makeTransport: () => Transport) {
    super();
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: this.makeTransport() });
  }
}

function setup(readOnly = false) {
  const sent: WsServerMessage[] = [];
  const mgr = new InjectingManager(() => new ReplayTransport(signon()));
  const server = new ServerConfigStore({
    systems: [{ id: "p", name: "p", host: "h" }],
    sessions: []
  });
  const resolver = new ConfigResolver(server, new PersonalConfigStore());
  const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
  return { conn, sent, mgr, readOnly };
}

describe("WsConnection", () => {
  it("open で opened＋初期画面を返す", async () => {
    const { conn, sent } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    expect(sent[0]?.type).toBe("opened");
    const opened = sent[0] as { type: "opened"; sessionId: string; screen: { fields: unknown[] } };
    expect(opened.sessionId).toBeTruthy();
    expect(opened.screen.fields.length).toBeGreaterThan(0);
  });

  it("open 前の key は SESSION_NOT_FOUND エラー", async () => {
    const { conn, sent } = setup();
    await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "SESSION_NOT_FOUND" });
  });

  it("不正な JSON は error を返す", async () => {
    const { conn, sent } = setup();
    await conn.handle("{ not json");
    expect(sent[0]).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
  });

  it("readOnly セッションの key(Enter) は READ_ONLY_SESSION", async () => {
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
    const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    await conn.handle(JSON.stringify({ type: "open", host: "h", readOnly: true }));
    await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "READ_ONLY_SESSION" });
  });

  it("close でセッションが破棄され closed を返す", async () => {
    const { conn, sent, mgr } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    expect(mgr.size).toBe(1);
    await conn.handle(JSON.stringify({ type: "close" }));
    expect(sent.some((m) => m.type === "closed")).toBe(true);
    expect(mgr.size).toBe(0);
  });

  it("onSocketClose でセッションが破棄される", async () => {
    const { conn, mgr } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    expect(mgr.size).toBe(1);
    conn.onSocketClose();
    expect(mgr.size).toBe(0);
  });
});

describe("WsConnection: 保存済み接続の ID 参照 open", () => {
  const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
  const alice: AuthUser = { username: "alice", role: "user" };
  const bob: AuthUser = { username: "bob", role: "user" };

  function setupConn(user: AuthUser) {
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const personal = new PersonalConfigStore({ systems: [], sessions: [] }, crypto);
    const system = personal.addSystem({ name: "pub400", host: "pub400.com" }, alice);
    const session = personal.addSession(
      { name: "pub400", system: parseRef(system.ref)!.id, sessionType: "display" },
      alice
    );
    const conn = new WsConnection(
      { sessions: mgr, resolver: new ConfigResolver(new ServerConfigStore(), personal) },
      { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
      user
    );
    return { conn, sent, ref: session.ref };
  }

  it("owner 本人は session 参照で開ける", async () => {
    const { conn, sent, ref } = setupConn(alice);
    await conn.handle(JSON.stringify({ type: "open", session: ref }));
    expect(sent[0]?.type).toBe("opened");
  });

  it("他人の session 参照は FORBIDDEN", async () => {
    const { conn, sent, ref } = setupConn(bob);
    await conn.handle(JSON.stringify({ type: "open", session: ref }));
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "FORBIDDEN" });
  });

  it("個人設定ストア未配線での参照は CONFIG_ERROR", async () => {
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const conn = new WsConnection(
      { sessions: mgr, resolver: new ConfigResolver(new ServerConfigStore(), undefined) },
      { send: (d) => sent.push(JSON.parse(d)), close: () => {} }
    );
    await conn.handle(JSON.stringify({ type: "open", session: "own:c-x" }));
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "CONFIG_ERROR" });
  });
});

/**
 * **予約中はブラウザから打てない。**
 *
 * この検査が要る理由: 締め出しは `SessionManager.assertKeyAllowed` の内側に置いてあり、
 * ws-handler には予約を見るコードが 1 行も無い。**構造で効いていること**を経路側から確かめる。
 */
describe("WsConnection: 予約中の締め出し", () => {
  const open = async (): Promise<ReturnType<typeof setup> & { id: string }> => {
    const s = setup();
    await s.conn.handle(JSON.stringify({ type: "open", host: "h" }));
    const opened = s.sent[0] as { sessionId: string };
    s.sent.length = 0;
    return { ...s, id: opened.sessionId };
  };

  it("**予約中の key は SESSION_RESERVED**（打ちかけが別の画面へ載るのを防ぐ）", async () => {
    const { conn, sent, mgr, id } = await open();
    mgr.reserve(id, "auto", "HLLAPI");
    sent.length = 0;
    await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "SESSION_RESERVED" });
    mgr.closeAll();
  });

  it("**予約の開始・解除が push される**（画面を変えずに起きるので別メッセージ）", async () => {
    const { sent, mgr, id } = await open();
    mgr.reserve(id, "auto", "HLLAPI");
    mgr.release(id, "auto");
    expect(sent.filter((m) => m.type === "reserved")).toEqual([
      { type: "reserved", by: "HLLAPI" },
      { type: "reserved" }
    ]);
    mgr.closeAll();
  });

  it("**利用者は強制解除できる**（自動化が落ちて Release が来ないときの非常口）", async () => {
    const { conn, mgr, id } = await open();
    mgr.reserve(id, "auto", "HLLAPI");
    await conn.handle(JSON.stringify({ type: "reserve-break" }));
    expect(mgr.reservationOf(id)).toBeUndefined();
    mgr.closeAll();
  });

  // 「解除後はまた打てる」は**ここでは検査しない**——Enter がホストの応答を待って
  // 5 秒止まる（ReplayTransport に続きが無い）。解除の意味は session-manager.test.ts が持つ
});

/**
 * **在席の勘定**。MCP が予約を取るかの判断に使う——数え間違えると、
 * 誰も見ていないのに覆いが出る／見ているのに出ない。
 */
describe("WsConnection: 見ている人を数える", () => {
  it("**開けば増え、閉じれば減る**", async () => {
    const { conn, sent, mgr } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    const id = (sent[0] as { sessionId: string }).sessionId;
    expect(mgr.hasViewer(id)).toBe(true);
    conn.onSocketClose();
    expect(mgr.hasViewer(id)).toBe(false);
    mgr.closeAll();
  });

  it("**二重に閉じても壊れない**（下限 0）", async () => {
    const { conn, sent, mgr } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    const id = (sent[0] as { sessionId: string }).sessionId;
    conn.onSocketClose();
    conn.onSocketClose();
    expect(mgr.hasViewer(id)).toBe(false);
    mgr.closeAll();
  });

  it("**誰も繋いでいないセッションは在席 0**（MCP が開いた場合がこれ）", async () => {
    const { mgr } = setup();
    const entry = await mgr.open({ host: "h" }).catch(() => undefined);
    if (entry) {
      expect(mgr.hasViewer(entry.id)).toBe(false);
      mgr.closeAll();
    }
  });
});

/**
 * **留守中に実行された PC コマンドを、繋ぎ直しで渡す**
 * （backlog `pc-command.md`「常駐セッションでの扱い」）。
 *
 * `pc-command` の push は**購読者にしか届かない**。ブラウザを閉じている間に届いた
 * STRPCCMD は**実行はされる**が、通知は誰にも配られず記録だけが残っていた。
 * 「黙って実行しない」という約束は、繋ぎ直しでも守られていないといけない。
 */
describe("PC コマンドの留守番", () => {
  /** セッションを開き、購読を切ってから PC コマンドの記録を積む */
  async function withHistory() {
    const s = setup();
    await s.conn.handle(JSON.stringify({ type: "open", host: "h" }));
    const id = (s.sent[0] as { sessionId: string }).sessionId;
    // 実行係を通さずに履歴だけ積む（実行の中身はここの関心ではない）
    const mgr = s.mgr as unknown as {
      pushPcCommandEvent: (id: string, e: unknown) => void;
    };
    mgr.pushPcCommandEvent(id, {
      command: "notepad a.txt",
      wait: false,
      at: 1,
      hostname: "pc",
      outcome: { status: "started" }
    });
    return { ...s, id };
  }

  it("**attach の opened に留守中の実行が載る**", async () => {
    const { mgr, id } = await withHistory();
    const sent: WsServerMessage[] = [];
    const server = new ServerConfigStore({ systems: [], sessions: [] });
    const conn2 = new WsConnection(
      { sessions: mgr, resolver: new ConfigResolver(server, new PersonalConfigStore()) },
      { send: (d) => sent.push(JSON.parse(d)), close: () => {} }
    );
    // 既存セッションへ繋ぐのは `open` に `sessionId` を添える形（別の型は無い）
    await conn2.handle(JSON.stringify({ type: "open", sessionId: id }));
    const opened = sent.find((m) => m.type === "opened") as { pcCommands?: { command: string }[] };
    expect(opened.pcCommands, "留守中の実行が届く").toHaveLength(1);
    expect(opened.pcCommands?.[0]?.command).toBe("notepad a.txt");
  });

  it("**記録が無ければ欄ごと載せない**（空配列を送らない）", async () => {
    const { conn, sent } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    expect(sent[0]).not.toHaveProperty("pcCommands");
  });

  it("履歴は取り出しても消えない（別のタブも同じものを見る）", async () => {
    const { mgr, id } = await withHistory();
    expect(mgr.pcCommandHistory(id)).toHaveLength(1);
    expect(mgr.pcCommandHistory(id)).toHaveLength(1);
  });

  it("**取り出した配列を触っても本体は変わらない**（複製を返す）", async () => {
    const { mgr, id } = await withHistory();
    mgr.pcCommandHistory(id).length = 0;
    expect(mgr.pcCommandHistory(id)).toHaveLength(1);
  });
});

/**
 * **画面（ws）の応答待ちは期限を設けない**（`aid-response-timeout`）。
 *
 * 原典（tn5250j / lib5250）にも実機の OIA にも「時間で諦めて施錠を解く」動作は無い。
 * 30 秒で切っていたころは、時間の掛かる CALL のたびに「応答がありません」と嘘をつき、
 * 施錠を偽って解いていた。代わりに**抜ける口を Attn / SysReq に置く**——ws は 1 通ずつ
 * 独立に処理される（`app.ts` の `void handle`）ので、待っている最中の 1 通も先に通る。
 */
describe("WsConnection: 応答待ちと逃げ道", () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));

  /** open 済みで、Enter を送って**ホストが黙っている**（＝施錠されたまま）状態を作る */
  async function waiting() {
    const { conn, sent } = setup();
    await conn.handle(JSON.stringify({ type: "open", host: "h" }));
    sent.length = 0;
    // **await しない**——期限を設けずに待つので、この promise は解決しない
    void conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
    await tick();
    return { conn, sent };
  }

  it("応答が来なければ key-done を返さずに待ち続ける（30 秒で諦めない）", async () => {
    // **時計を進めて確かめる**——旧実装（既定 30 秒）ならここで timedOut の key-done が返る。
    // 心拍は止めておく（`deadMs` を無限大に）——半開き判定でセッションが閉じると、
    // `handleClose` が待ちを `timedOut: true` で解いて**別の理由の key-done**が混ざる
    vi.useFakeTimers();
    try {
      const sent: WsServerMessage[] = [];
      const mgr = new InjectingManager(() => new ReplayTransport(signon()));
      const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
      const conn = new WsConnection(
        { sessions: mgr, resolver },
        { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
        undefined,
        { deadMs: Number.MAX_SAFE_INTEGER }
      );
      await conn.handle(JSON.stringify({ type: "open", host: "h" }));
      sent.length = 0;
      void conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sent.filter((m) => m.type === "key-done")).toHaveLength(0);
      expect(sent.filter((m) => m.type === "error")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("応答待ちの最中でも Attn は通る（施錠中の逃げ道）", async () => {
    const { conn, sent } = await waiting();
    await conn.handle(JSON.stringify({ type: "key", key: "Attn" }));
    await tick();
    expect(sent.filter((m) => m.type === "error")).toHaveLength(0);
    // **フラグキーには key-done を返さない**——返すと元の待ちの busy が解けてしまう
    expect(sent.filter((m) => m.type === "key-done")).toHaveLength(0);
  });

  it("応答待ちの最中の SysReq は、打ちかけの欄が付いていても通る", async () => {
    // 画面は打った文字を必ず添えて送ってくる。欄を書こうとすると `setField` が
    // KEYBOARD_LOCKED を投げ、**逃げ道が未送信の入力だけで塞がる**
    const { conn, sent } = await waiting();
    await conn.handle(
      JSON.stringify({
        type: "key",
        key: "SysReq",
        sysReqText: "2",
        fields: [{ field: 1, value: "X" }]
      })
    );
    await tick();
    expect(sent.filter((m) => m.type === "error")).toHaveLength(0);
  });

  it("応答待ちの最中の通常キーは施錠で断る（逃げ道を広げすぎない）", async () => {
    const { conn, sent } = await waiting();
    await conn.handle(JSON.stringify({ type: "key", key: "F3" }));
    await tick();
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "KEYBOARD_LOCKED" });
  });
});
