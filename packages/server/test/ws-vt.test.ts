import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { VtManager } from "../src/vt-manager.js";
import type { WsServerMessage } from "../src/ws-messages.js";

/**
 * **VT 端末を Web の口から使う**（`terminal: "vt"`）。
 *
 * 相手は**最小の telnet サーバー**（このファイル内）。ここで確かめるのは配管——
 * 開く・画面が来る・打鍵が届く・5250 / 3270 の経路を汚さない。
 * エスケープ列の解釈そのものは `@ts5250/vt` 側で実機と突き合わせ済み。
 */

const IAC = 255;
const WILL = 251;
const ECHO = 1;
const SGA = 3;

interface Mini {
  port: number;
  close: () => Promise<void>;
  /** クライアントから届いたバイト（交渉を含む生のまま） */
  received: number[];
  /** つながっているソケットへ流す */
  push: (text: string) => void;
}

/**
 * ECHO / SGA を握る最小の telnet サーバー（＝文字モードが成立する）。
 *
 * ⚠ **繋がる前の `push` を捨てない。** `sock?.write` の楽観連鎖にしていたら、
 * 接続直後に押した `ESC[?2004h` が黙って消えて「貼り付けが包まれない」に見えた。
 * ソケットが立つまで溜めておく。
 */
async function startMiniTelnet(greeting = ""): Promise<Mini> {
  const received: number[] = [];
  let sock: Socket | undefined;
  const pending: Buffer[] = [];
  const server: Server = createServer((s) => {
    sock = s;
    s.on("data", (b) => {
      for (const x of b) received.push(x);
    });
    s.on("error", () => undefined);
    s.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA]));
    if (greeting !== "") s.write(Buffer.from(greeting, "utf8"));
    for (const b of pending.splice(0)) s.write(b);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    received,
    push: (t) => {
      const b = Buffer.from(t, "utf8");
      if (sock === undefined) pending.push(b);
      else sock.write(b);
    },
    close: () =>
      new Promise<void>((r) => {
        sock?.destroy();
        server.close(() => r());
      })
  };
}

function setup(): { conn: WsConnection; sent: WsServerMessage[]; vt: VtManager } {
  const sent: WsServerMessage[] = [];
  const server = new ServerConfigStore({ systems: [], sessions: [] });
  const resolver = new ConfigResolver(server, new PersonalConfigStore());
  const vt = new VtManager();
  const conn = new WsConnection(
    { sessions: new SessionManager(), resolver, vt },
    { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => undefined }
  );
  return { conn, sent, vt };
}

const waitFor = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
};

/** クライアントが送った「アプリのデータ」（交渉を除く）を文字列で */
const appBytes = (received: readonly number[]): string => {
  const out: number[] = [];
  let i = 0;
  while (i < received.length) {
    const b = received[i]!;
    if (b !== IAC) { out.push(b); i++; continue; }
    const c = received[i + 1];
    if (c === undefined) break;
    if (c === IAC) { out.push(IAC); i += 2; continue; }
    if (c === 250) {
      // SB … IAC SE
      let j = i + 2;
      while (j + 1 < received.length && !(received[j] === IAC && received[j + 1] === 240)) j++;
      i = j + 2;
      continue;
    }
    i += 3;
  }
  return Buffer.from(out).toString("utf8");
};

let mini: Mini | undefined;
afterEach(async () => {
  await mini?.close();
  mini = undefined;
});

describe("VT のセッションを開く", () => {
  it("開くと画面が届き、差分が続く", async () => {
    mini = await startMiniTelnet("hello\r\n");
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(
        JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
      );
      expect(await waitFor(() => sent.some((m) => m.type === "vt-opened"))).toBe(true);
      const opened = sent.find((m) => m.type === "vt-opened");
      expect(opened).toMatchObject({ type: "vt-opened", encoding: "utf-8", ibmI: false });

      mini.push("second line\r\n");
      // **「フレームが 1 通来た」では足りない**——最初の 1 通は greeting のぶん。
      // 中身が届くまで待つ
      const arrived = await waitFor(() =>
        JSON.stringify(sent.filter((m) => m.type === "vt-frame")).includes("second line")
      );
      expect(arrived).toBe(true);
    } finally {
      vt.closeAll();
    }
  }, 20_000);

  it("**5250 の経路を汚さない**（`key` は VT では断る）", async () => {
    mini = await startMiniTelnet();
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(
        JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
      );
      expect(await waitFor(() => sent.some((m) => m.type === "vt-opened"))).toBe(true);
      sent.length = 0;
      await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
      expect(sent[0]).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
      expect((sent[0] as { message: string }).message).toContain("vt-input");
    } finally {
      vt.closeAll();
    }
  }, 20_000);

  it("**VT が無効なサーバーでは断る**", async () => {
    const sent: WsServerMessage[] = [];
    const server = new ServerConfigStore({ systems: [], sessions: [] });
    const conn = new WsConnection(
      { sessions: new SessionManager(), resolver: new ConfigResolver(server, new PersonalConfigStore()) },
      { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => undefined }
    );
    await conn.handle(JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1" }));
    expect(sent[0]).toMatchObject({ type: "error", code: "CONFIG_ERROR" });
  });
});

describe("打鍵", () => {
  it("文字とキーがホストへ届く", async () => {
    mini = await startMiniTelnet();
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(
        JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
      );
      expect(await waitFor(() => sent.some((m) => m.type === "vt-opened"))).toBe(true);
      await conn.handle(JSON.stringify({ type: "vt-input", text: "ls" }));
      await conn.handle(JSON.stringify({ type: "vt-input", key: "Enter" }));
      expect(await waitFor(() => appBytes(mini!.received).includes("ls\r"))).toBe(true);
    } finally {
      vt.closeAll();
    }
  }, 20_000);

  it("**カーソルキーはモードで変わる**（符号化はサーバーが持つ）", async () => {
    mini = await startMiniTelnet();
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(
        JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
      );
      expect(await waitFor(() => sent.some((m) => m.type === "vt-opened"))).toBe(true);
      await conn.handle(JSON.stringify({ type: "vt-input", key: "ArrowUp" }));
      expect(await waitFor(() => appBytes(mini!.received).includes("\x1b[A"))).toBe(true);
      // ホストが DECCKM を立てると application 様式になる
      mini.push("\x1b[?1h");
      await new Promise((r) => setTimeout(r, 300));
      await conn.handle(JSON.stringify({ type: "vt-input", key: "ArrowUp" }));
      expect(await waitFor(() => appBytes(mini!.received).includes("\x1bOA"))).toBe(true);
    } finally {
      vt.closeAll();
    }
  }, 20_000);

  it("貼り付けは bracketed paste が有効なら包まれる", async () => {
    mini = await startMiniTelnet();
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(
        JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
      );
      expect(await waitFor(() => sent.some((m) => m.type === "vt-opened"))).toBe(true);
      mini.push("\x1b[?2004h");
      await new Promise((r) => setTimeout(r, 300));
      await conn.handle(JSON.stringify({ type: "vt-input", paste: "ls" }));
      expect(await waitFor(() => appBytes(mini!.received).includes("\x1b[200~ls\x1b[201~"))).toBe(true);
    } finally {
      vt.closeAll();
    }
  }, 20_000);
});

describe("大きさ", () => {
  it("`vt-resize` が NAWS としてホストへ届く", async () => {
    mini = await startMiniTelnet();
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(
        JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
      );
      expect(await waitFor(() => sent.some((m) => m.type === "vt-opened"))).toBe(true);
      await conn.handle(JSON.stringify({ type: "vt-resize", rows: 40, cols: 132 }));
      expect(await waitFor(() => sent.some((m) => m.type === "vt-frame"))).toBe(true);
      const frames = sent.filter((m) => m.type === "vt-frame");
      const last = frames[frames.length - 1] as { frame: { rows: number; cols: number } };
      expect(last.frame).toMatchObject({ rows: 40, cols: 132 });
    } finally {
      vt.closeAll();
    }
  }, 20_000);
});

describe("エラーの伝え方", () => {
  /**
   * **`fatal` は状態で決める**（`ws-lifetime.test.ts`「error の fatal は状態で決まる」）。
   *
   * その状態は端末の種類ごとに別の欄へ入る（`sessionId` / `session3270` / `sessionVt`）。
   * **3270 を足したときに `session3270` を見落として同じ不具合を出した**（PR #339）ので、
   * VT でも同じ形を繰り返さないことをここで固定する。
   */
  it("**生きている VT セッションのエラーは fatal でない**", async () => {
    mini = await startMiniTelnet();
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(
        JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
      );
      expect(await waitFor(() => sent.some((m) => m.type === "vt-opened"))).toBe(true);
      sent.length = 0;
      // VT では使えない操作＝**セッションは無事なまま**のエラー
      await conn.handle(JSON.stringify({ type: "key", key: "Enter" }));
      expect(sent[0]).toMatchObject({ type: "error", fatal: false });
    } finally {
      vt.closeAll();
    }
  }, 20_000);

  it("セッションを開く前の `vt-input` は fatal（この接続にセッションが無い）", async () => {
    const { conn, sent, vt } = setup();
    try {
      await conn.handle(JSON.stringify({ type: "vt-input", text: "x" }));
      expect(sent[0]).toMatchObject({ type: "error", code: "SESSION_NOT_FOUND", fatal: true });
    } finally {
      vt.closeAll();
    }
  });
});
