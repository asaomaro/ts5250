import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ServerConfigStore } from "../src/config-store.js";
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
