import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import type { ServerSession } from "../src/config-types.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";

/**
 * **関連付けプリンター**（`associatedPrinter`。`20260921-associated-printer`）。
 *
 * 5250 の表示セッションが telnet で IBMASSOCPRT として申告する装置名。信頼設定ではない（印刷先を決めて権限を見るのはホスト）ので
 * 両方の保存先に書ける。**5250 の表示以外に書いても何も起きない**ので、保存の時点で弾く。
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const admin: AuthUser = { username: "root", role: "admin" };

const personal = (): PersonalConfigStore =>
  new PersonalConfigStore({ systems: [{ id: "s-1", name: "sys", host: "h", owner: "alice" }], sessions: [] }, crypto);
const server = (sessions: ServerSession[] = []): ServerConfigStore =>
  new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions }, crypto);

describe("関連付けプリンター: 保存", () => {
  it("自分の設定に書け、一覧にも出る（信頼設定ではない）", () => {
    const s = personal().addSession({ name: "d", system: "s-1", sessionType: "display", associatedPrinter: "PRT01" }, alice);
    expect(s.associatedPrinter).toBe("PRT01");
  });

  it("サーバー設定にも書ける。値は加工しない（ACS も検査・大文字化しない）", () => {
    const s = server().addSession({ name: "d", system: "sys", sessionType: "display", associatedPrinter: " prt01" }, admin);
    expect(s.associatedPrinter).toBe(" prt01");
  });

  it("5250（terminal 省略・明示）の表示だけ。**プリンター・3270・VT・監視に書いたら弾く**", () => {
    const st = server();
    expect(() =>
      st.addSession({ name: "d", system: "sys", sessionType: "display", terminal: "5250", associatedPrinter: "PRT01" }, admin)
    ).not.toThrow();
    for (const bad of [
      { sessionType: "printer" as const },
      { sessionType: "display" as const, terminal: "3270" as const },
      { sessionType: "display" as const, terminal: "vt" as const },
      { sessionType: "dtaqwatch" as const, dtaqWatch: { library: "L", name: "Q" } }
    ]) {
      expect(() => st.addSession({ name: "x", system: "sys", associatedPrinter: "PRT01", ...bad }, admin), JSON.stringify(bad)).toThrow(
        /associatedPrinter/
      );
    }
  });
});

describe("関連付けプリンター: 解決", () => {
  const resolve = (s: ServerSession) =>
    new ConfigResolver(server([s]), personal()).resolve({ session: `srv:${s.id}` }, admin, () => {}).connect;

  it("5250 の表示なら接続の選択肢に載る", () => {
    expect(resolve({ id: "d", name: "d", system: "sys", sessionType: "display", associatedPrinter: "PRT01" }).associatedPrinter).toBe("PRT01");
  });

  it("書いていなければ載らない", () => {
    expect(resolve({ id: "d", name: "d", system: "sys", sessionType: "display" })).not.toHaveProperty("associatedPrinter");
  });

  it("**手で書き換えたファイルでも、5250 の表示以外の申告には混ぜない**（スキーマを通らない読み込み経路の保険）", () => {
    expect(resolve({ id: "p", name: "p", system: "sys", sessionType: "printer", associatedPrinter: "PRT01" })).not.toHaveProperty(
      "associatedPrinter"
    );
    expect(
      resolve({ id: "t", name: "t", system: "sys", sessionType: "display", terminal: "3270", associatedPrinter: "PRT01" })
    ).not.toHaveProperty("associatedPrinter");
  });
});
