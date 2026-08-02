import { describe, it, expect } from "vitest";
import { WsConnection } from "../src/ws-handler.js";
import type { SessionManager, PrinterEntry } from "../src/session-manager.js";
import type { ConfigResolver } from "../src/config-resolver.js";
import type { WsServerMessage } from "../src/ws-messages.js";
import type { AuthUser } from "../src/auth.js";
import { As400Error } from "@ts5250/base";

/**
 * **拒否は利用者に返す**（`20260801-service-auth-e2e`）。
 *
 * 認証を有効にした実機 E2E で、一般利用者が他人のサービスを止めようとしたときに
 * **何も返らず、サーバープロセスが落ちた**。原因は `void withAudit(...)` で
 * promise を捨てていたこと——`handle()` の catch が `error` を送る経路を迂回し、
 * 未処理の rejection になっていた。
 *
 * 「認可が効いている」だけでは足りない。**効いたことが呼んだ側に届く**必要がある。
 */
const alice: AuthUser = { username: "alice", role: "user" };

function conn(opts: { throwOn?: string } = {}) {
  // **`send` に届くのは JSON 文字列**（`WsSender` はそのまま流す）。解いて突き合わせる
  const sent: WsServerMessage[] = [];
  const push = (m: WsServerMessage | string): void => {
    sent.push(typeof m === "string" ? (JSON.parse(m) as WsServerMessage) : m);
  };
  const sessions = {
    stopPrinter: () => {
      if (opts.throwOn === "stop") throw new As400Error("FORBIDDEN", "forbidden: not the owner of this session");
      return {} as PrinterEntry;
    },
    startPrinter: async () => {
      if (opts.throwOn === "start") throw new As400Error("FORBIDDEN", "forbidden: not the owner of this session");
      return {} as PrinterEntry;
    }
  } as unknown as SessionManager;
  const resolver = {
    resolve: () => {
      throw new As400Error("FORBIDDEN", "forbidden: server settings are admin only");
    }
  } as unknown as ConfigResolver;
  const ws = new WsConnection({ sessions, resolver }, { send: push }, alice);
  return { ws, sent };
}

describe("サービス操作の拒否が利用者に返る", () => {
  it("**`printer-stop` の拒否が `error` で返る**（`void` で捨てると届かない）", async () => {
    const { ws, sent } = conn({ throwOn: "stop" });
    await ws.handle(JSON.stringify({ type: "printer-stop", sessionId: "e1" }));
    expect(sent).toContainEqual(expect.objectContaining({ type: "error", code: "FORBIDDEN" }));
  });

  it("**投げ返さない**（未処理の rejection でプロセスを落とさない）", async () => {
    const { ws } = conn({ throwOn: "stop" });
    await expect(ws.handle(JSON.stringify({ type: "printer-stop", sessionId: "e1" }))).resolves.toBeUndefined();
  });

  it("`printer-start` の拒否も返る", async () => {
    const { ws, sent } = conn({ throwOn: "start" });
    await ws.handle(JSON.stringify({ type: "printer-start", sessionId: "e1" }));
    expect(sent).toContainEqual(expect.objectContaining({ type: "error", code: "FORBIDDEN" }));
  });

  it("`printer-service-start` の拒否も返る（サーバー設定は admin だけ）", async () => {
    const { ws, sent } = conn();
    await ws.handle(JSON.stringify({ type: "printer-service-start", session: "srv:p1" }));
    expect(sent).toContainEqual(expect.objectContaining({ type: "error", code: "FORBIDDEN" }));
  });
});
