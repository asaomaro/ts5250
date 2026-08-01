import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { registerConfigRoutes } from "../src/config-routes.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser, AuthVars } from "../src/auth.js";
import type { PublicSession } from "../src/config-types.js";

/**
 * **printer 設定の往復**（`20260801-service-control-ui`）。
 *
 * 更新は**オブジェクトごと置き換え**（`updateSession`）なので、編集フォームが値を
 * 持ち帰れないと**保存のたびに設定が消える**——名前を直しただけで PDF 保存先が失われていた。
 * `pcCommand` で同じ問題を直したときの理屈をそのまま printer にも当てる。
 *
 * **返す相手は「その値を書ける相手」と同じ集合**（`canEditServer`）なので信頼境界は動かない。
 * 一般利用者には従来どおりフラグ（`service` / `hasOutput`）だけ。
 */
const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const admin: AuthUser = { username: "root", role: "admin" };

/**
 * **サーバー設定は読むのも admin だけ**（`assertProfileAccess`）。だから一般ユーザーは
 * そもそも一覧に出ない——「フラグだけ返る」相手は *admin だが編集できない* 場合、
 * すなわち `canEditServer` が false（設定ファイルの裏付けが無く保存できない）ときである。
 */

const PRINTER = {
  service: true,
  autoPdfDir: "/var/spool/out",
  autoPrint: "LP1",
  pdfFontName: "IPAGothic"
};

function store(): ServerConfigStore {
  return new ServerConfigStore(
    {
      systems: [{ id: "sys", name: "sys", host: "h" }],
      sessions: [
        { id: "p", name: "p", system: "sys", sessionType: "printer", printer: { ...PRINTER } }
      ]
    },
    crypto
  );
}

describe("printer 設定の露出（信頼境界）", () => {
  it("**編集できる相手には中身ごと返る**（返さないと保存で消える）", () => {
    const [pub] = store().listSessions(admin, { includeTrusted: true });
    expect(pub!.printer).toEqual(PRINTER);
  });

  it("**編集できない相手にはフラグだけ**（パスもプリンター名も出さない）", () => {
    const [pub] = store().listSessions(admin); // includeTrusted を渡さない＝定義の一覧と同じ経路
    expect(pub!.printer).toBeUndefined();
    // 「サービスか」「出力を持つか」は定義の一覧に要るので、これは出る
    expect(pub!.service).toBe(true);
    expect(pub!.hasOutput).toBe(true);
    const json = JSON.stringify(pub);
    expect(json).not.toContain("/var/spool/out");
    expect(json).not.toContain("LP1");
  });

  it("返した printer はストアの実体と別物（応答を書き換えても設定は変わらない）", () => {
    const s = store();
    const [pub] = s.listSessions(admin, { includeTrusted: true });
    pub!.printer!.autoPdfDir = "/etc";
    const [again] = s.listSessions(admin, { includeTrusted: true });
    expect(again!.printer!.autoPdfDir).toBe("/var/spool/out");
  });
});

describe("往復（読んで送り返すと消えない）", () => {
  it("**読んだ printer をそのまま送り返せば設定は残る**", () => {
    const s = store();
    const [pub] = s.listSessions(admin, { includeTrusted: true });
    // 画面がするのと同じこと: 名前だけ直して、printer は読んだものを送り返す
    s.updateSession(
      "p",
      { name: "改名", system: "sys", sessionType: "printer", printer: pub!.printer },
      admin
    );
    const [after] = s.listSessions(admin, { includeTrusted: true });
    expect(after!.name).toBe("改名");
    expect(after!.printer).toEqual(PRINTER);
  });

  it("printer を送らなければ消える（置き換え更新の仕様。だから読み込みが要る）", () => {
    const s = store();
    s.updateSession("p", { name: "p", system: "sys", sessionType: "printer" }, admin);
    const [after] = s.listSessions(admin, { includeTrusted: true });
    expect(after!.printer).toBeUndefined();
    expect(after!.service).toBeUndefined();
  });

  it("`service` だけを外しても出力設定は残る（軸が別）", () => {
    const s = store();
    const { service: _dropped, ...rest } = PRINTER;
    s.updateSession("p", { name: "p", system: "sys", sessionType: "printer", printer: rest }, admin);
    const [after] = s.listSessions(admin, { includeTrusted: true });
    expect(after!.service).toBeUndefined();
    expect(after!.printer!.autoPdfDir).toBe("/var/spool/out");
  });
});

describe("GET /api/sessions-config", () => {
  const app = (editable: boolean) => {
    const resolver = new ConfigResolver(store(), undefined);
    const a = new Hono<{ Variables: AuthVars }>();
    a.use("*", async (c, next) => {
      c.set("user", admin);
      await next();
    });
    registerConfigRoutes(a, { resolver, canEditServer: () => editable });
    return a;
  };
  const get = async (editable: boolean) =>
    (await (await app(editable).request("/api/sessions-config")).json()) as {
      sessions: PublicSession[];
      editable: boolean;
    };

  it("編集権限があれば printer の中身が返る", async () => {
    const body = await get(true);
    expect(body.editable).toBe(true);
    expect(body.sessions[0]!.printer).toEqual(PRINTER);
  });

  it("**編集権限が無ければ返らない**（フラグだけ）", async () => {
    // 例: admin だが設定ファイルの裏付けが無く保存できない（`canEditServer` が false）
    const body = await get(false);
    expect(body.editable).toBe(false);
    expect(body.sessions[0]!.printer).toBeUndefined();
    expect(body.sessions[0]!.service).toBe(true);
  });
});

describe("autoStart（信頼設定ではない）", () => {
  it("**フラグだけの相手にも返る**。未設定はキーごと無い＝既定の「自動で始める」", () => {
    const s = new ServerConfigStore(
      {
        systems: [{ id: "sys", name: "sys", host: "h" }],
        sessions: [
          { id: "a", name: "a", system: "sys", sessionType: "printer", autoStart: false },
          { id: "b", name: "b", system: "sys", sessionType: "printer" }
        ]
      },
      crypto
    );
    const list = s.listSessions(admin);
    expect(list.find((x) => x.name === "a")!.autoStart).toBe(false);
    expect(list.find((x) => x.name === "b")!.autoStart).toBeUndefined();
  });
});

/**
 * **サービス定義の名札**（`20260801-services-pane`）。
 *
 * サーバー設定は読むのも admin だけ（`assertProfileAccess`）だが、**この狭い口だけは
 * 一般利用者にも開く**——「いま何が動いているか」が分からないと、帳票が来ない理由を
 * 問い合わせるしかない（利用者の判断: 見るだけは許す）。
 *
 * 開いてよい理由は**返す形が狭いから**。ホストもパスも装置名も入っていない。
 */
describe("listServiceDefs（名札だけ）", () => {
  const s = () =>
    new ServerConfigStore(
      {
        systems: [{ id: "sys", name: "sys", host: "secret-host.example", port: 992 }],
        sessions: [
          {
            id: "p",
            name: "帳票",
            system: "sys",
            sessionType: "printer",
            deviceName: "PRT_SECRET",
            printer: { ...PRINTER }
          },
          { id: "w", name: "受注", system: "sys", sessionType: "dtaqwatch", dtaqWatch: { library: "L", name: "Q" } },
          { id: "d", name: "端末", system: "sys", sessionType: "display" }
        ]
      },
      crypto
    );

  it("**一般ユーザーにも返る**（`listSessions` は 0 件のまま）", () => {
    const store = s();
    const plain = { username: "alice", role: "user" } as const;
    expect(store.listSessions(plain)).toHaveLength(0); // 既存の規則は緩めていない
    expect(store.listServiceDefs(plain).map((d) => d.name).sort()).toEqual(["受注", "帳票"]);
  });

  it("**ホスト・パス・装置名は入らない**", () => {
    const json = JSON.stringify(s().listServiceDefs({ username: "alice", role: "user" }));
    expect(json).not.toContain("secret-host.example");
    expect(json).not.toContain("PRT_SECRET");
    expect(json).not.toContain("/var/spool/out");
    expect(json).not.toContain("LP1");
  });

  it("`display` は入らない（サービスではない）", () => {
    expect(s().listServiceDefs(admin).some((d) => d.sessionType === "display")).toBe(false);
  });

  it("意図のフラグは入る（一覧の出し分けに要る）", () => {
    const p = s().listServiceDefs(admin).find((d) => d.name === "帳票");
    expect(p).toMatchObject({ service: true, hasOutput: true });
  });
});

describe("個人設定のサービス定義は所有者だけ", () => {
  it("**他人のものは名札さえ返さない**（サーバー設定と扱いが違う）", () => {
    const store = new PersonalConfigStore(
      {
        systems: [{ id: "s1", name: "s1", host: "h", owner: "alice" }],
        sessions: [
          { id: "w1", name: "alice の監視", system: "s1", sessionType: "dtaqwatch", dtaqWatch: { library: "L", name: "Q" }, owner: "alice" }
        ]
      },
      crypto
    );
    expect(store.listServiceDefs({ username: "alice", role: "user" })).toHaveLength(1);
    expect(store.listServiceDefs({ username: "bob", role: "user" })).toHaveLength(0);
  });
});

/**
 * **転送設定の信頼境界**（`20260801-dtaq-webhook`）。
 *
 * Webhook は**サーバーから外へ出ていくデータ経路**なので、個人設定に置けてはならない
 * ——一般利用者が「サーバーが読めるキューの中身を自分の URL へ送る」設定を作れてしまう。
 */
describe("webhook（信頼設定）", () => {
  const withHook = () =>
    new ServerConfigStore(
      {
        systems: [{ id: "sys", name: "sys", host: "h" }],
        sessions: [
          {
            id: "w",
            name: "受注",
            system: "sys",
            sessionType: "dtaqwatch",
            dtaqWatch: { library: "L", name: "Q" },
            webhook: { url: "https://hook.example/x", secretEnc: "v1:a:b:c", maxAttempts: 3 }
          }
        ]
      },
      crypto
    );

  it("**個人設定は webhook を持てない**（スキーマが弾く＝信頼境界 1 層目）", () => {
    const store = new PersonalConfigStore(
      { systems: [{ id: "s1", name: "s1", host: "h", owner: "alice" }], sessions: [] },
      crypto
    );
    expect(() =>
      store.addSession(
        {
          name: "w",
          system: "s1",
          sessionType: "dtaqwatch",
          dtaqWatch: { library: "L", name: "Q" },
          webhook: { url: "https://evil.example/x" }
        },
        { username: "alice", role: "user" }
      )
    ).toThrow();
  });

  it("**`dtaqwatch` 以外には付けられない**（種別との整合を parse で強制）", () => {
    const store = new ServerConfigStore(
      { systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [] },
      crypto
    );
    expect(() =>
      store.addSession({ name: "p", system: "sys", sessionType: "printer", webhook: { url: "https://x/y" } }, admin)
    ).toThrow(/webhook/);
  });

  it("**秘密の値は決して返らない**（有無だけ）", () => {
    const [pub] = withHook().listSessions(admin, { includeTrusted: true });
    expect(pub!.webhook).toMatchObject({ url: "https://hook.example/x", hasSecret: true, maxAttempts: 3 });
    expect(JSON.stringify(pub)).not.toContain("v1:a:b:c");
  });

  it("編集できない相手には転送設定そのものが返らない（URL も出さない）", () => {
    const [pub] = withHook().listSessions(admin);
    expect(pub!.webhook).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain("hook.example");
  });

  it("**サービス定義の名札にも URL は入らない**（一般利用者に見える口）", () => {
    const json = JSON.stringify(withHook().listServiceDefs({ username: "alice", role: "user" }));
    expect(json).not.toContain("hook.example");
    expect(json).not.toContain("v1:a:b:c");
  });
});

/**
 * **秘密が保存で消えない**（`20260801-dtaq-webhook`）。
 *
 * 編集フォームには秘密が返らない（`hasSecret` だけ）ので、そのまま送り返すと
 * **名前を直して保存しただけで認証が外れる**——printer 出力で実際に起きていた壊れ方と同じ形。
 * `system.password` と同じ約束（空で送れば据え置き）で塞ぐ。
 */
describe("webhook の秘密の往復（ルート経由）", () => {
  const app = () => {
    const store = new ServerConfigStore(
      {
        systems: [{ id: "sys", name: "sys", host: "h" }],
        sessions: [
          {
            id: "w",
            name: "受注",
            system: "sys",
            sessionType: "dtaqwatch",
            dtaqWatch: { library: "L", name: "Q" },
            webhook: { url: "https://hook.example/x", secretEnc: crypto.encrypt("s3cret") }
          }
        ]
      },
      crypto
    );
    const resolver = new ConfigResolver(store, undefined);
    const a = new Hono<{ Variables: AuthVars }>();
    a.use("*", async (c, next) => {
      c.set("user", admin);
      await next();
    });
    registerConfigRoutes(a, { resolver, canEditServer: () => true });
    return { app: a, store };
  };
  const put = (a: Hono<{ Variables: AuthVars }>, body: unknown) =>
    a.request("/api/sessions-config/srv:w", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  const base = {
    source: "server",
    name: "受注",
    system: "srv:sys",
    sessionType: "dtaqwatch",
    dtaqWatch: { library: "L", name: "Q" }
  };

  it("**秘密を空で送れば据え置き**（画面が読めない値を消さない）", async () => {
    const { app: a, store } = app();
    const res = await put(a, { ...base, name: "改名", webhook: { url: "https://hook.example/x" } });
    expect(res.status).toBe(200);
    const saved = store.getSession("w") as { name: string; webhook?: { secretEnc?: string } };
    expect(saved.name).toBe("改名");
    expect(crypto.decrypt(saved.webhook!.secretEnc!)).toBe("s3cret");
  });

  it("平文を送ると**暗号化して保存**する（平文は残らない）", async () => {
    const { app: a, store } = app();
    await put(a, { ...base, webhook: { url: "https://hook.example/x", secret: "new-token" } });
    const saved = store.getSession("w") as { webhook?: { secretEnc?: string } };
    expect(saved.webhook!.secretEnc).not.toContain("new-token");
    expect(crypto.decrypt(saved.webhook!.secretEnc!)).toBe("new-token");
  });

  it("**入力から暗号文を持ち込ませない**（差し替えは平文経由だけ）", async () => {
    const { app: a, store } = app();
    await put(a, { ...base, webhook: { url: "https://hook.example/x", secretEnc: "v1:forged" } });
    const saved = store.getSession("w") as { webhook?: { secretEnc?: string } };
    expect(saved.webhook!.secretEnc).not.toBe("v1:forged");
    expect(crypto.decrypt(saved.webhook!.secretEnc!)).toBe("s3cret"); // 既存が保たれる
  });

  it("**壊れた URL は 400**（実行時に初めて失敗させない）", async () => {
    const { app: a } = app();
    const res = await put(a, { ...base, webhook: { url: "file:///etc/passwd" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("webhook url");
  });

  it("URL を空にすると転送設定ごと消える（＝転送しない）", async () => {
    const { app: a, store } = app();
    await put(a, { ...base });
    expect((store.getSession("w") as { webhook?: unknown }).webhook).toBeUndefined();
  });
});
