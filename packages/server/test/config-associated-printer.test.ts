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

/**
 * **プリンターセッションを指す関連付け**（`associatedPrinterSession`。`20260921-associated-printer-session`）。
 * 同じファイルのプリンターの設定を指し、装置名の方式とは排他。待ち時間・一緒に閉じるは、これを指したときだけ書ける
 */
describe("関連付けるプリンターセッション: 保存と検査", () => {
  const prt = { id: "prt", name: "prt", system: "sys", sessionType: "printer" } as ServerSession;
  const disp = { id: "d0", name: "d0", system: "sys", sessionType: "display" } as ServerSession;

  it("同じファイルのプリンターを指せる。公開では**参照**（`srv:`）で返る", () => {
    const st = server([prt]);
    const s = st.addSession(
      { name: "d", system: "sys", sessionType: "display", associatedPrinterSession: "prt", associatedPrinterTimeout: 10, closeAssociatedPrinterWithLastSession: true },
      admin
    );
    expect(s.associatedPrinterSession).toBe("srv:prt");
    expect(s.associatedPrinterTimeout).toBe(10);
    expect(s.closeAssociatedPrinterWithLastSession).toBe(true);
  });

  it("**指した先が無い・プリンターでないなら弾く**（同じファイルの外は指せない）", () => {
    const st = server([prt, disp]);
    for (const id of ["ghost", "d0"]) {
      expect(() => st.addSession({ name: "x", system: "sys", sessionType: "display", associatedPrinterSession: id }, admin), id).toThrow(
        /missing printer session/
      );
    }
  });

  it("更新でも検査する（先に指した先を消しても、書き換えでは通らない）", () => {
    const st = server([prt]);
    const s = st.addSession({ name: "d", system: "sys", sessionType: "display", associatedPrinterSession: "prt" }, admin);
    const id = s.ref.replace(/^srv:/, "");
    expect(() =>
      st.updateSession(id, { name: "d", system: "sys", sessionType: "display", associatedPrinterSession: "ghost" }, admin)
    ).toThrow(/missing printer session/);
  });

  it("**個人設定では同じ持ち主のプリンターだけ**（他人のプリンターを起こさせない）", () => {
    const st = new PersonalConfigStore(
      {
        systems: [{ id: "s-1", name: "sys", host: "h", owner: "alice" }],
        sessions: [{ id: "bob-prt", name: "bob-prt", system: "s-1", sessionType: "printer", owner: "bob" } as never]
      },
      crypto
    );
    expect(() => st.addSession({ name: "d", system: "s-1", sessionType: "display", associatedPrinterSession: "bob-prt" }, alice)).toThrow(
      /missing printer session/
    );
  });

  it("装置名の方式とは同時に書けない。待ち時間・一緒に閉じるは、プリンターセッションを指したときだけ", () => {
    const st = server([prt]);
    expect(() =>
      st.addSession({ name: "x", system: "sys", sessionType: "display", associatedPrinter: "PRT01", associatedPrinterSession: "prt" }, admin)
    ).toThrow(/同時に指定できません/);
    for (const k of [{ associatedPrinterTimeout: 5 }, { closeAssociatedPrinterWithLastSession: true }]) {
      expect(() => st.addSession({ name: "y", system: "sys", sessionType: "display", ...k }, admin), JSON.stringify(k)).toThrow(/だけ指定できます/);
    }
  });

  it("5250 の表示だけ（3270・プリンターには書けない）", () => {
    const st = server([prt]);
    for (const bad of [{ sessionType: "printer" as const }, { sessionType: "display" as const, terminal: "3270" as const }]) {
      expect(() => st.addSession({ name: "z", system: "sys", associatedPrinterSession: "prt", ...bad }, admin), JSON.stringify(bad)).toThrow(
        /associatedPrinterSession/
      );
    }
  });

  it("**設定ファイルの読み込みでも、指した先が無ければ起動を止める**", () => {
    const bad = { id: "d", name: "d", system: "sys", sessionType: "display", associatedPrinterSession: "ghost" } as ServerSession;
    const st = new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [bad] }, crypto);
    expect(() => (st as unknown as { assertIntegrity(): void }).assertIntegrity()).toThrow(/missing printer session/);
  });
});

describe("関連付けるプリンターセッション: 解決", () => {
  const prt = { id: "prt", name: "prt", system: "sys", sessionType: "printer" } as ServerSession;
  const resolve = (over: Partial<ServerSession>) =>
    new ConfigResolver(
      server([prt, { id: "d", name: "d", system: "sys", sessionType: "display", ...over } as ServerSession]),
      personal()
    ).resolve({ session: "srv:d" }, admin, () => {});

  it("参照と一緒に閉じるを返す。**待ち時間は既定 5 秒**", () => {
    expect(resolve({ associatedPrinterSession: "prt" }).associatedPrinterSession).toEqual({ ref: "srv:prt", timeoutMs: 5000, closeWithLast: false });
    expect(resolve({ associatedPrinterSession: "prt", closeAssociatedPrinterWithLastSession: true }).associatedPrinterSession?.closeWithLast).toBe(true);
  });

  it("**待ち時間は ACS と同じ丸め**: 1〜4 は 5 秒・600 超は 600 秒・0 は待ち続ける（timeoutMs を付けない）", () => {
    const ms = (t: number) => resolve({ associatedPrinterSession: "prt", associatedPrinterTimeout: t }).associatedPrinterSession?.timeoutMs;
    expect(ms(1)).toBe(5000);
    expect(ms(4)).toBe(5000);
    expect(ms(5)).toBe(5000);
    expect(ms(30)).toBe(30000);
    expect(ms(600)).toBe(600000);
    expect(ms(601)).toBe(600000);
    expect(ms(0)).toBeUndefined();
    expect(resolve({ associatedPrinterSession: "prt", associatedPrinterTimeout: 0 }).associatedPrinterSession).toEqual({ ref: "srv:prt", closeWithLast: false });
  });

  it("指していなければ返さない", () => {
    expect(resolve({})).not.toHaveProperty("associatedPrinterSession");
  });

  it("**手で書き換えたファイルでも、5250 の表示以外では返さない**", () => {
    expect(resolve({ terminal: "3270", associatedPrinterSession: "prt" } as Partial<ServerSession>)).not.toHaveProperty("associatedPrinterSession");
  });
});
