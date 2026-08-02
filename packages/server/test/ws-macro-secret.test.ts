import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { MacroStore } from "../src/macro-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";
import type { CreateMacroBody } from "../src/macro-types.js";

/**
 * 再生時の秘密の差し込み（spec D11）を ws 経路で確認する。
 *
 * 守りたい不変条件は 2 つ:
 *   1. 解決できたときだけホストへ書く（所有者違い・復号失敗は**キー送信ごと落とす**）
 *   2. 失敗時に**空文字で代替しない**——空のパスワードがホストに届くと、
 *      サインオン失敗の原因が分からなくなる
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signonTrace = (): ReturnType<typeof parseTraceJsonl> =>
  parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };

const DUMMY_SECRET = "dummy-secret-value";

class InjectingManager extends SessionManager {
  constructor(private readonly makeTransport: () => Transport) {
    super();
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: this.makeTransport() });
  }
}

/**
 * signon 画面の実データに合わせる（フィールド index は **1 始まり**）:
 *   index 1 = ユーザー欄（row 5 col 25 len 10）
 *   index 2 = パスワード欄（row 6 col 25、`hidden: true`）
 */
function macroBody(): CreateMacroBody {
  return {
    name: "サインオン",
    steps: [
      {
        screen: {
          rows: 24,
          cols: 80,
          targets: [
            { field: 1, row: 5, col: 25, len: 10 },
            { field: 2, row: 6, col: 25, len: 128 }
          ]
        },
        fields: [{ field: 1, value: "USER" }],
        plainSecrets: [{ field: 2, value: DUMMY_SECRET }],
        key: "Enter",
        cursor: { row: 5, col: 25 }
      }
    ]
  };
}

/** ws 接続を用意し、`setField` の呼び出しを覗けるようにする */
async function setup(opts: {
  macros?: MacroStore;
  user?: AuthUser;
} = {}): Promise<{
  conn: WsConnection;
  sent: WsServerMessage[];
  setField: ReturnType<typeof vi.fn>;
  sessionId: string;
}> {
  const sent: WsServerMessage[] = [];
  const mgr = new InjectingManager(() => new ReplayTransport(signonTrace()));
  const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
  const deps = { sessions: mgr, resolver, ...(opts.macros ? { macros: opts.macros } : {}) };
  const conn = new WsConnection(deps, { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} }, opts.user);
  await conn.handle(JSON.stringify({ type: "open", host: "h" }));
  const opened = sent[0] as { type: "opened"; sessionId: string };
  const entry = mgr.get(opened.sessionId, opts.user);
  // 実際にホストへ書かれた値を覗く（平文が届いたか／そもそも書かれなかったか）
  const setField = vi.fn(entry.session.setField.bind(entry.session));
  entry.session.setField = setField as unknown as typeof entry.session.setField;
  // **sendAid は差し替える**。replay トレースに signon 後の往復が無く、本物を呼ぶと
  // ホスト応答待ちで止まってしまう。ここで確かめたいのは「どの値が欄に書かれたか」なので、
  // 送信そのものは即座に完了させて切り離す。
  entry.session.sendAid = (async () => ({
    screen: entry.session.snapshot(),
    timedOut: false
  })) as unknown as typeof entry.session.sendAid;
  return { conn, sent, setField, sessionId: opened.sessionId };
}

function keyWithSecret(macroId: string): string {
  return JSON.stringify({
    type: "key",
    key: "Enter",
    fields: [
      { field: 1, value: "USER" },
      { field: 2, secretRef: { macroId, step: 0, field: 2 } }
    ]
  });
}

describe("ws: マクロの秘密の差し込み", () => {
  it("所有者なら復号した平文がホストへ書かれる", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const { conn, sent, setField } = await setup({ macros, user: alice });

    await conn.handle(keyWithSecret(macro.id));

    expect(sent.at(-1)?.type).toBe("key-done");
    expect(setField).toHaveBeenCalledTimes(2);
    expect(setField).toHaveBeenNthCalledWith(1, { index: 1 }, "USER");
    expect(setField).toHaveBeenNthCalledWith(2, { index: 2 }, DUMMY_SECRET);
  });

  it("他人のマクロを指す参照は拒否され、**1 欄も書かれない**", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const { conn, sent, setField } = await setup({ macros, user: bob });

    await conn.handle(keyWithSecret(macro.id));

    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(sent.some((m) => m.type === "key-done")).toBe(false);
    // 先に解決してから書くので、平文でない欄（USER）も書かれない＝中途半端な状態を残さない
    expect(setField).not.toHaveBeenCalled();
  });

  it("復号に失敗する（鍵が違う）と拒否され、空文字で代替しない", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    // 同じレコードを別の鍵のストアへ移す＝鍵ローテーション後の状況
    const other = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
    const moved = new MacroStore([macros.get(macro.id, alice)], other);
    const { conn, sent, setField } = await setup({ macros: moved, user: alice });

    await conn.handle(keyWithSecret(macro.id));

    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(setField).not.toHaveBeenCalled();
  });

  it("マクロストアが無い構成では秘密参照を拒否する", async () => {
    const { conn, sent, setField } = await setup({ user: alice });
    await conn.handle(keyWithSecret("m-whatever"));
    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(setField).not.toHaveBeenCalled();
  });

  it("存在しないステップ / 欄への参照も拒否する", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const { conn, sent, setField } = await setup({ macros, user: alice });

    await conn.handle(
      JSON.stringify({
        type: "key",
        key: "Enter",
        fields: [{ field: 2, secretRef: { macroId: macro.id, step: 5, field: 2 } }]
      })
    );

    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(setField).not.toHaveBeenCalled();
  });

  it("壊れた secretRef は PROTOCOL_ERROR で弾く（素の TypeError を漏らさない）", async () => {
    const macros = new MacroStore([], crypto);
    const { conn, sent, setField } = await setup({ macros, user: alice });

    // secretRef を持たない・形が違う 3 パターン
    for (const bad of [{}, { macroId: "m-1" }, { macroId: 1, step: "x", field: null }]) {
      await conn.handle(
        JSON.stringify({ type: "key", key: "Enter", fields: [{ field: 2, secretRef: bad }] })
      );
      expect(sent.at(-1)).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    }
    // secretRef キー自体が無い場合も同じ扱い（value も secretRef も無い欄）
    await conn.handle(JSON.stringify({ type: "key", key: "Enter", fields: [{ field: 2 }] }));
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });

    expect(setField).not.toHaveBeenCalled();
  });

  it("秘密を含まない従来どおりの fields は影響を受けない（回帰）", async () => {
    const { conn, sent, setField } = await setup({ user: alice });
    await conn.handle(
      JSON.stringify({ type: "key", key: "Enter", fields: [{ field: 1, value: "USER" }] })
    );
    expect(sent.at(-1)?.type).toBe("key-done");
    expect(setField).toHaveBeenCalledWith({ index: 1 }, "USER");
  });

  it("readOnly セッションでは秘密参照の解決以前に弾かれる", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signonTrace()));
    const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
    const conn = new WsConnection(
      { sessions: mgr, resolver, macros },
      { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} },
      alice
    );
    await conn.handle(JSON.stringify({ type: "open", host: "h", readOnly: true }));
    await conn.handle(keyWithSecret(macro.id));
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "READ_ONLY_SESSION" });
  });
});
