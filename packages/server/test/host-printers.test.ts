import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerHostPrinterRoutes } from "../src/host-printers.js";
import type { AuthVars } from "../src/auth.js";
import type { PrinterEntry, SessionManager } from "../src/session-manager.js";

/**
 * 常駐プリンターの一覧（`20260801-printer-session-residency` design D2）。
 *
 * **主目的は出力の失敗を見せること。** 常駐にすると「ブラウザが居ない時間」が
 * 普通になるので、`outputWarnings` に溜まるだけでは誰も気づけない。
 */
const entry = (over: Partial<PrinterEntry> & { id: string }): PrinterEntry =>
  ({
    host: "h",
    origin: "profile",
    connectedAt: "2026-08-01T00:00:00.000Z",
    lastActivity: 0,
    reports: [],
    delivered: 0,
    waiters: [],
    outputEnabled: true,
    outputWarnings: [],
    outputStatuses: [],
    resident: false,
    session: {} as PrinterEntry["session"],
    ...over
  }) as PrinterEntry;

function appWith(printers: PrinterEntry[], user?: { username: string; role: string }) {
  const sessions = {
    listPrinters: (u?: { username: string; role: string }) =>
      !u || u.role === "admin" ? printers : printers.filter((p) => p.owner === u.username)
  } as unknown as SessionManager;
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user as never);
    await next();
  });
  registerHostPrinterRoutes(app, { sessions });
  return app;
}

const get = async (app: Hono<{ Variables: AuthVars }>) =>
  (await app.request("/api/printers")).json() as Promise<{ printers: Record<string, unknown>[] }>;

describe("GET /api/printers", () => {
  it("常駐かどうかを出す（一覧の存在理由）", async () => {
    const body = await get(appWith([entry({ id: "a", resident: true }), entry({ id: "b" })]));
    expect(body.printers.map((p) => [p.id, p.resident])).toEqual([
      ["a", true],
      ["b", false]
    ]);
  });

  it("出力の警告を新しい順で出す（溜まった古い失敗より今を先に）", async () => {
    const body = await get(
      appWith([
        entry({
          id: "a",
          outputWarnings: [
            { at: 1, message: "古い" },
            { at: 2, message: "新しい" }
          ]
        })
      ])
    );
    expect(body.printers[0]!.warnings).toEqual([
      { at: 2, message: "新しい" },
      { at: 1, message: "古い" }
    ]);
  });

  it("未読の帳票数が分かる（reports と delivered の差）", async () => {
    const body = await get(
      appWith([entry({ id: "a", reports: [{}, {}, {}] as PrinterEntry["reports"], delivered: 1 })])
    );
    expect(body.printers[0]).toMatchObject({ reports: 3, delivered: 1 });
  });

  it("出力設定の中身は出さない（パス・プリンター名は信頼設定）", async () => {
    const body = await get(
      appWith([entry({ id: "a", output: { autoPdfDir: "/srv/secret", autoPrint: "PRT1" } })])
    );
    expect(body.printers[0]).toMatchObject({ hasOutput: true });
    expect(JSON.stringify(body.printers[0])).not.toContain("/srv/secret");
    expect(JSON.stringify(body.printers[0])).not.toContain("PRT1");
  });

  it("一般ユーザーには自分のものだけ（警告文にパスが載りうる）", async () => {
    const app = appWith(
      [entry({ id: "mine", owner: "u1" }), entry({ id: "theirs", owner: "u2" })],
      { username: "u1", role: "user" }
    );
    const body = await get(app);
    expect(body.printers.map((p) => p.id)).toEqual(["mine"]);
  });
});
