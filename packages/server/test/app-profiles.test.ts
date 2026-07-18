import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ProfileStore } from "../src/profiles.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "../src/auth.js";

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;

/** 保存時に autoPdfDir が検証されるため、テストでは実在する書き込み可能なディレクトリを使う */
const OUT_DIR = mkdtempSync(join(tmpdir(), "prof-out-"));

/** signon + printer（信頼設定）を持つプロファイル 1 件のファイルを作る */
function profilesFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "prof-"));
  const path = join(dir, "profiles.json");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [
        {
          name: "pub400",
          host: "pub400.com",
          port: 23,
          signon: { user: "USER", passwordEnv: "PUB400_PASSWORD" },
          printer: { autoPdfDir: "/var/spool/out" }
        }
      ]
    })
  );
  return path;
}

function deps(path: string, auth?: AuthContext) {
  return {
    sessions: new SessionManager(),
    profiles: ProfileStore.fromFile(path, crypto),
    version: "test",
    ...(auth ? { auth } : {})
  };
}
function authCtx(): AuthContext {
  return {
    enabled: true,
    users: new UserStore([
      { username: "admin", role: "admin", passwordHash: hashPassword("adminpw") },
      { username: "alice", role: "user", passwordHash: hashPassword("alicepw") }
    ]),
    sessions: new SessionStore()
  };
}
async function login(app: ReturnType<typeof buildApp>, u: string, p: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("/api/profiles 編集（認証オフ）", () => {
  let path: string;
  beforeEach(() => (path = profilesFile()));

  it("GET は editable=true を返す", async () => {
    const app = buildApp(deps(path));
    const body = await (await app.request("/api/profiles")).json();
    expect(body.editable).toBe(true);
  });

  it("PUT で接続情報を更新でき、signon/printer（信頼設定）は保持される", async () => {
    const app = buildApp(deps(path));
    const res = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "example.com", port: 992, tls: true })
    });
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles[0];
    expect(saved.host).toBe("example.com");
    expect(saved.tls).toBe(true);
    // 信頼設定はブラウザ入力に無くてもサーバーが保持
    expect(saved.signon.passwordEnv).toBe("PUB400_PASSWORD");
    expect(saved.printer.autoPdfDir).toBe("/var/spool/out");
  });

  it("signon の生オブジェクトや未知キーは strict で 400 拒否", async () => {
    const app = buildApp(deps(path));
    // signon の生オブジェクトは受理しない（signonUser/password/autoSignon のみ）
    const bad1 = await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", host: "h", signon: { user: "u", passwordEnv: "SECRET" } })
    });
    expect(bad1.status).toBe(400);
    // 未知キーも strict で拒否
    const bad2 = await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "y", host: "h", bogus: 1 })
    });
    expect(bad2.status).toBe(400);
  });

  it("編集者は UI から printer 出力設定を保存でき、GET で printer が露出する", async () => {
    const app = buildApp(deps(path));
    const res = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "pub400",
        host: "pub400.com",
        printer: { autoPdfDir: OUT_DIR, autoPrint: "Office", fontSize: 9 }
      })
    });
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles[0];
    expect(saved.printer.autoPdfDir).toBe(OUT_DIR);
    expect(saved.printer.autoPrint).toBe("Office");
    expect(saved.printer.fontSize).toBe(9);
    // GET は editable のとき printer を返す
    const list = await (await app.request("/api/profiles")).json();
    expect(list.profiles[0].printer.autoPdfDir).toBe(OUT_DIR);
    expect(list.profiles[0].sessionType).toBe("printer");
  });

  it("種別は新規で確定し、更新では変更されない（不変）", async () => {
    const app = buildApp(deps(path));
    // 新規 display プロファイル
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "disp", host: "h", sessionType: "display" })
    });
    // 更新で sessionType=printer を送っても display のまま
    await app.request("/api/profiles/disp", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "disp", host: "h2", sessionType: "printer" })
    });
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles.find((p: { name: string }) => p.name === "disp");
    expect(saved.sessionType).toBe("display");
  });

  it("display 種別には printer 出力設定を付けられない（落とされる）", async () => {
    const app = buildApp(deps(path));
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "disp2", host: "h", sessionType: "display", printer: { autoPdfDir: "/x" } })
    });
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles.find((p: { name: string }) => p.name === "disp2");
    expect(saved.sessionType).toBe("display");
    expect(saved.printer).toBeUndefined();
  });

  it("printer 種別なら printer 出力設定を保持できる", async () => {
    const app = buildApp(deps(path));
    await app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "prt", host: "h", sessionType: "printer", printer: { autoPdfDir: OUT_DIR } })
    });
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles.find((p: { name: string }) => p.name === "prt");
    expect(saved.sessionType).toBe("printer");
    expect(saved.printer.autoPdfDir).toBe(OUT_DIR);
  });

  it("printer を空にするとブロックが消える（自動蓄積/印刷を無効化）", async () => {
    const app = buildApp(deps(path));
    await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "pub400.com", printer: { autoPdfDir: "", autoPrint: "" } })
    });
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles[0];
    expect(saved.printer).toBeUndefined();
    expect(saved.host).toBe("pub400.com");
  });

  it("DELETE でプロファイルを削除できる", async () => {
    const app = buildApp(deps(path));
    const res = await app.request("/api/profiles/pub400", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(path, "utf8")).profiles).toHaveLength(0);
  });

  it("UI でパスワードを設定すると passwordEnc（暗号化）で保存され平文は残らない", async () => {
    const app = buildApp(deps(path));
    const res = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "pub400.com", autoSignon: true, signonUser: "USER", password: "pw@1" })
    });
    expect(res.status).toBe(200);
    const raw = readFileSync(path, "utf8");
    const saved = JSON.parse(raw).profiles[0];
    expect(saved.signon.user).toBe("USER");
    expect(saved.signon.passwordEnc).toMatch(/^v1:/);
    expect(saved.signon.password).toBeUndefined();
    // 平文パスワードはファイルにもレスポンスにも現れない
    expect(raw).not.toContain("pw@1");
    // GET は signonUser を返すがパスワードは返さない
    const list = await (await app.request("/api/profiles")).json();
    expect(list.profiles[0].signonUser).toBe("USER");
    expect(JSON.stringify(list)).not.toContain("passwordEnc");
  });

  it("autoSignon をオフにすると signon が解除される", async () => {
    const app = buildApp(deps(path));
    await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "pub400.com", autoSignon: false })
    });
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles[0];
    expect(saved.signon).toBeUndefined();
  });
});

describe("/api/profiles 編集（認証オン・admin ゲート）", () => {
  it("一般ユーザーは editable=false・書き込みは 403", async () => {
    const app = buildApp(deps(profilesFile(), authCtx()));
    const cookie = await login(app, "alice", "alicepw");
    const get = await (await app.request("/api/profiles", { headers: { cookie } })).json();
    expect(get.editable).toBe(false);
    const put = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "pub400", host: "h" })
    });
    expect(put.status).toBe(403);
  });

  it("admin は editable=true・書き込み可", async () => {
    const app = buildApp(deps(profilesFile(), authCtx()));
    const cookie = await login(app, "admin", "adminpw");
    const get = await (await app.request("/api/profiles", { headers: { cookie } })).json();
    expect(get.editable).toBe(true);
    const put = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "pub400", host: "h2" })
    });
    expect(put.status).toBe(200);
  });

  it("一般ユーザーには一覧が空で返り、printer 付き書き込みも 403", async () => {
    const app = buildApp(deps(profilesFile(), authCtx()));
    const cookie = await login(app, "alice", "alicepw");
    // GET: サーバー設定は admin 専用なので存在ごと見せない（空配列）
    const get = await (await app.request("/api/profiles", { headers: { cookie } })).json();
    expect(get.profiles).toEqual([]);
    expect(get.editable).toBe(false);
    // printer を含む書き込みも 403（ルートゲートで拒否）
    const put = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "pub400", host: "h", printer: { autoPdfDir: "/evil" } })
    });
    expect(put.status).toBe(403);
  });

  it("admin は printer を編集でき、露出される", async () => {
    const path = profilesFile();
    const app = buildApp(deps(path, authCtx()));
    const cookie = await login(app, "admin", "adminpw");
    const get = await (await app.request("/api/profiles", { headers: { cookie } })).json();
    expect(get.profiles[0].printer.autoPdfDir).toBe("/var/spool/out");
    const put = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "pub400", host: "h", printer: { autoPrint: "AdminPrinter" } })
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(readFileSync(path, "utf8")).profiles[0].printer.autoPrint).toBe("AdminPrinter");
  });
});

describe("/api/profiles 編集（ファイル非由来）", () => {
  it("--profiles 未指定（persistable=false）は editable=false", async () => {
    const app = buildApp({ sessions: new SessionManager(), profiles: new ProfileStore([]), version: "test" });
    const body = await (await app.request("/api/profiles")).json();
    expect(body.editable).toBe(false);
  });
});

describe("ProfileStore: 平文 signon.password の廃止", () => {
  it("平文 password を含むファイルは読み込みで明示エラーになる", () => {
    const dir = mkdtempSync(join(tmpdir(), "prof-legacy-"));
    const path = join(dir, "profiles.json");
    writeFileSync(
      path,
      JSON.stringify({ profiles: [{ name: "old", host: "h", signon: { user: "U", password: "plain" } }] })
    );
    expect(() => ProfileStore.fromFile(path, crypto)).toThrow(/廃止|password/);
  });
});

describe("ProfileStore: signon 解決", () => {
  it("add した password は暗号化され resolve で復号される", () => {
    const store = new ProfileStore([], crypto);
    store.add({ name: "p", host: "h", autoSignon: true, signonUser: "U", password: "secret" });
    expect(store.resolveConnectOptions("p", undefined)).toMatchObject({ user: "U", password: "secret" });
  });

  it("鍵未設定では passwordEnc を復号できず auto-signon をスキップ（warn）", () => {
    const noKey = new ProfileStore(
      [{ name: "p", host: "h", signon: { user: "U", passwordEnc: crypto.encrypt("secret") } }],
      undefined
    );
    let warned = "";
    const opts = noKey.resolveConnectOptions("p", undefined, (m) => (warned = m));
    expect(opts.password).toBeUndefined();
    expect(warned).toMatch(/secret key|decrypt/i);
  });
});

/**
 * PDF 出力先は保存時に検証する（受信時まで失敗が分からない問題への対処）。
 * ディレクトリは**作成しない**方針なので、存在しなければエラーにする。
 */
describe("/api/profiles: PDF 出力先の保存時検証", () => {
  const printerBody = (dir: string) =>
    JSON.stringify({ name: "prt", host: "h", sessionType: "printer", printer: { autoPdfDir: dir } });
  const post = (app: ReturnType<typeof buildApp>, dir: string) =>
    app.request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: printerBody(dir)
    });

  it("存在しない出力先は 400 で、プロファイルは保存されない・フォルダも作られない", async () => {
    const path = profilesFile();
    const missing = join(mkdtempSync(join(tmpdir(), "novalid-")), "no-such-dir");
    const res = await post(buildApp(deps(path)), missing);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/見つかりません/);
    // 不正な設定を永続化しない
    const saved = JSON.parse(readFileSync(path, "utf8")).profiles;
    expect(saved.find((p: { name: string }) => p.name === "prt")).toBeUndefined();
    // 自動作成しない
    expect(existsSync(missing)).toBe(false);
  });

  it("正常な出力先なら保存でき、解決後の絶対パスを返す", async () => {
    const res = await post(buildApp(deps(profilesFile())), OUT_DIR);
    expect(res.status).toBe(201);
    expect((await res.json()).resolvedPdfDir).toBe(resolve(OUT_DIR));
  });

  it("display 種別なら検証しない（printer ブロックはどのみち破棄されるため）", async () => {
    const res = await buildApp(deps(profilesFile())).request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "d2",
        host: "h",
        sessionType: "display",
        printer: { autoPdfDir: "/definitely/not/here" }
      })
    });
    expect(res.status).toBe(201);
  });

  it("autoPdfDir 未指定の保存は従来どおり成功する", async () => {
    const res = await buildApp(deps(profilesFile())).request("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p2", host: "h" })
    });
    expect(res.status).toBe(201);
    expect((await res.json()).resolvedPdfDir).toBeUndefined();
  });

  it("PUT でも検証され、既存プロファイルは書き換わらない", async () => {
    const path = profilesFile();
    const app = buildApp(deps(path));
    const missing = join(mkdtempSync(join(tmpdir(), "novalid-")), "nope");
    const res = await app.request("/api/profiles/pub400", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pub400", host: "changed", printer: { autoPdfDir: missing } })
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(readFileSync(path, "utf8")).profiles[0].host).toBe("pub400.com");
  });
});
