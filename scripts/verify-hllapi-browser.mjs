/**
 * **E2E: DLL から実機のエミュレータ画面を操作し、ブラウザで結果を見る。**
 *
 *   node --env-file=.env scripts/verify-hllapi-browser.mjs
 *
 * `verify-hllapi.mjs` は C ABI とサーバーの間だけを見る。こちらは**端から端まで**——
 * 共有ライブラリ（VBA が呼ぶのと同じ実体）→ HTTP → セッション → **実物のブラウザ**。
 *
 * ## ここでしか確かめられないこと
 *
 * 1. **どのシステムのどのセッションかを指定して繋げる**（`Connect` の拡張）。
 *    狙ったほうを掴んでいることを、ブラウザで開いた画面と突き合わせて確かめる
 * 2. **ブラウザに触らずに画面が描き直される**（DLL の操作が push で届く）
 * 3. **予約（`Reserve`）の覆いが実物のブラウザに出て、入力が止まる**
 *
 * 実機（`AS400_HOST`）と、ビルド済みの共有ライブラリ・web-ui が要る。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@ts5250/server";

const PORT = 3493;
const TMP = "/tmp/as400-verify-hllapi-e2e";
const LIB = "crates/hllapi/target/release/libts5250hllapi.so";
const WEB = "packages/web-ui/dist";
const SHOTS = `${TMP}/shots`;
mkdirSync(SHOTS, { recursive: true });

/** 2 つ定義して、**狙ったほうだけ**を掴めることを確かめる */
const SESSIONS = [
  { id: "s-honban", name: "本番" },
  { id: "s-kensho", name: "検証" }
];
/** 開くのは 2 つ目。1 つ目は**定義だけあって開いていない**——名前で指す意味が出る */
const PICK = SESSIONS[1];

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${String(d).slice(0, 120)}` : ""}\n`);
};

for (const [path, what] of [
  [LIB, "共有ライブラリ（docs/HLLAPI.md 参照）"],
  [`${WEB}/index.html`, "web-ui（npm run build -w @ts5250/web-ui）"]
]) {
  if (!existsSync(path)) {
    process.stderr.write(`${path} がありません: ${what}\n`);
    process.exit(1);
  }
}
if (!process.env["AS400_PASSWORD"]) {
  process.stderr.write("AS400_PASSWORD が未設定です\n");
  process.exit(1);
}

/** Python の ctypes 経由で 1 呼び出し（**VBA が呼ぶのと同じ C ABI**） */
function hllapi(fn, data = "", length = null) {
  const py = `
import ctypes, json
lib = ctypes.CDLL(${JSON.stringify(LIB)})
raw = ${JSON.stringify(data)}.encode("cp932")
n = ${length === null ? "len(raw)" : String(length)}
buf = ctypes.create_string_buffer(raw, max(n, 1))
f = ctypes.c_int(${fn}); l = ctypes.c_int(n); r = ctypes.c_int(0)
lib.hllapi(ctypes.byref(f), buf, ctypes.byref(l), ctypes.byref(r))
print(json.dumps({"rc": r.value, "len": l.value,
                  "data": buf.raw[:max(l.value,0)].decode("cp932","replace")}))
`;
  return new Promise((resolve) => {
    const p = spawn("python3", ["-c", py], {
      env: { ...process.env, TS5250_HLLAPI_URL: `http://127.0.0.1:${PORT}/api/hllapi` }
    });
    let o = "";
    p.stdout.on("data", (d) => (o += d));
    p.on("close", () => resolve(JSON.parse(o.trim() || '{"rc":-1,"data":""}')));
  });
}

// **実機の接続設定をそのまま借りる**（TLS・ポート・資格情報。手で組むと negotiation で落ちる）
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
if (!sys) {
  process.stderr.write("connections.json に実機がありません\n");
  process.exit(1);
}
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
// **この検証専用のセッション定義を足す**（名前で指せることを見るため 2 つ）
cfg.sessions = SESSIONS.map((x) => ({ ...x, system: sys.id, sessionType: "display" }));
writeFileSync(`${TMP}/cfg.json`, JSON.stringify(cfg));
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${TMP}/cfg.json`),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "verify", webRoot: WEB });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const screenText = () => page.locator(".screen-wrap").first().innerText();
const norm = (t) => t.replace(/\s+/gu, "");

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  // ---- 1. **利用者と同じ経路**で、名前の付いたセッションを開く ----
  // システムが複数あるので、まず対象のシステムを選ぶ（利用者の操作と同じ）
  await page
    .locator(".card", { hasText: sys.name })
    .first()
    .getByRole("button", { name: "選択" })
    .click();
  await page.waitForTimeout(800);
  const card = page.locator(".card", { hasText: PICK.name }).first();
  await card.getByRole("button", { name: "接続" }).click();
  await page.waitForSelector(".screen-wrap", { timeout: 45_000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${SHOTS}/1-signon.png` });
  const signon = await screenText();
  check(`ブラウザで「${PICK.name}」を開いた`, signon.trim().length > 30, signon.slice(0, 40).replace(/\n/gu, " "));
  check("サーバー側にセッションが 1 つ", sessions.size === 1, `${sessions.size} 件`);

  // ---- 2. **名前で指して繋ぐ** ----
  const wrong = await hllapi(1, `A ${SESSIONS[0].name}`, 64);
  check(`**開いていないセッション（${SESSIONS[0].name}）は掴めない（rc=1）**`, wrong.rc === 1, `rc=${wrong.rc}`);

  const conn = await hllapi(1, `A ${PICK.name}`, 64);
  check(`**名前で指して繋げる（"A ${PICK.name}"）**`, conn.rc === 0, `rc=${conn.rc}`);

  const qs = await hllapi(10, "", 256);
  check("**Query Sessions が指定の書き方を出す**", qs.data.includes(PICK.name), qs.data.trim());

  // 掴んだのが**ブラウザで開いた画面と同じもの**か——中身で突き合わせる
  const cells = 24 * 80;
  const copy = await hllapi(5, "", cells);
  check(
    "**掴んだ画面がブラウザの画面と一致する**（別のセッションを掴んでいない）",
    copy.rc === 0 && norm(copy.data).includes(norm(signon).slice(0, 20)),
    `rc=${copy.rc}`
  );

  // ---- 3. **DLL から操作 → ブラウザがその場で描き直す** ----
  const before = await screenText();
  const key = await hllapi(3, "@E", 8);
  check("DLL から Enter を送った", key.rc === 0, `rc=${key.rc}`);
  await page
    .waitForFunction((prev) => document.querySelector(".screen-wrap")?.innerText !== prev, before, {
      timeout: 20_000
    })
    .catch(() => {});
  const after = await screenText();
  await page.screenshot({ path: `${SHOTS}/2-after-dll-key.png` });
  check("**ブラウザに触らずに画面が描き直された**（DLL の操作が push で届く）", after !== before);

  // ---- 4. 予約の覆い ----
  const res = await hllapi(11, "", 8);
  check("Reserve (11)", res.rc === 0, `rc=${res.rc}`);
  await page.waitForSelector(".reserved-overlay", { timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/3-reserved.png` });
  check("**予約すると覆いが出る**", (await page.locator(".reserved-overlay").count()) === 1);
  const box = await page
    .locator(".reserved-box")
    .innerText()
    .catch(() => "");
  check("**誰が触っているか出る**", box.includes("HLLAPI"), box.replace(/\n/gu, " "));
  check(
    "**覆いが画面を塞いでいる**（クリックが下へ抜けない）",
    await page.evaluate(() => {
      const el = document.querySelector(".reserved-overlay");
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
    })
  );

  // ---- 4.5 **MCP も同じ経路を通る** ----
  // MCP の `send_key` も `entry.session.sendAid` を呼ぶだけ——ブラウザは同じ
  // `screen` イベントを購読しているので、**専用の仕掛け無しにその場で描き直る**はず。
  // 予約中は MCP も締め出される（holder を渡さない＝人間と同じ扱い）ことも見る。
  const mcp = async (name, args) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args }
      })
    });
    const body = await res.text();
    // Streamable HTTP は SSE で返ることがある（`data: {...}`）
    const line = body.split("\n").find((l) => l.startsWith("data:")) ?? body;
    return JSON.parse(line.replace(/^data:\s*/u, ""));
  };

  const listed = await mcp("list_sessions", {});
  const listedText = JSON.stringify(listed);
  check("**MCP がブラウザの開いたセッションを見つけられる**", listedText.includes(sessions.list()[0].id));

  // 予約したまま MCP から打つ → **断られる**
  const blockedByMcp = await mcp("send_key", { sessionId: sessions.list()[0].id, key: "Enter" });
  check(
    "**予約中は MCP も締め出される**（HLLAPI と人間だけの話ではない）",
    JSON.stringify(blockedByMcp).includes("SESSION_RESERVED"),
    JSON.stringify(blockedByMcp).slice(0, 90)
  );

  // ---- 5. 解除の口 ----
  await page.locator(".reserved-box button").click();
  await page.waitForSelector(".reserved-overlay", { state: "detached", timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/4-released.png` });
  check("**「解除して操作する」で覆いが消える**", (await page.locator(".reserved-overlay").count()) === 0);
  check("解除がサーバーにも効いている", sessions.reservationOf(sessions.list()[0]?.id ?? "") === undefined);

  // ---- 6. **MCP の操作もブラウザに映る** ----
  const beforeMcp = await screenText();
  const viaMcp = await mcp("send_key", { sessionId: sessions.list()[0].id, key: "Enter" });
  check("解除後は MCP から打てる", !JSON.stringify(viaMcp).includes("SESSION_RESERVED"));
  await page
    .waitForFunction((prev) => document.querySelector(".screen-wrap")?.innerText !== prev, beforeMcp, {
      timeout: 20_000
    })
    .catch(() => {});
  await page.screenshot({ path: `${SHOTS}/5-after-mcp-key.png` });
  check(
    "**MCP の操作もブラウザにその場で映る**（DLL と同じ経路——専用の仕掛けは無い）",
    (await screenText()) !== beforeMcp
  );

  // ---- 7. **MCP が自動で予約する**（見ている人が居るときだけ）----
  const sid = sessions.list()[0].id;
  check("**ブラウザが見ている**（在席が数えられている）", sessions.hasViewer(sid));

  const t0 = Date.now();
  const auto = await mcp("send_key", { sessionId: sid, key: "Enter" });
  const elapsed = Date.now() - t0;
  check("MCP から打てた", !JSON.stringify(auto).includes("error"), `${elapsed}ms`);

  // 予約は**書いている間だけ**。実機の 1 往復に対して期限が足りているかを測る
  const held = sessions.reservationOf(sid);
  check("**MCP が自動で予約した**（囲えと言われずに）", held?.label === "MCP", `label=${held?.label}`);
  check(
    `**1 往復（${elapsed}ms）に対して期限（${held?.ttlMs}ms）が足りている**`,
    (held?.ttlMs ?? 0) > elapsed * 2,
    `余裕 ${((held?.ttlMs ?? 0) / Math.max(elapsed, 1)).toFixed(1)} 倍`
  );

  await page.waitForSelector(".reserved-overlay", { timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/6-mcp-reserved.png` });
  const mcpBox = await page.locator(".reserved-box").innerText().catch(() => "");
  check("**画面に「MCP が自動操作中です」が出る**", mcpBox.includes("MCP"), mcpBox.replace(/\n/gu, " "));

  // **終われば自然に消える**（HLLAPI の 2 分と違い、短い期限）
  await page
    .waitForSelector(".reserved-overlay", { state: "detached", timeout: 30_000 })
    .catch(() => {});
  await page.screenshot({ path: `${SHOTS}/7-mcp-released.png` });
  check(
    "**放っておけば覆いが消える**（囲いを解く操作が要らない）",
    (await page.locator(".reserved-overlay").count()) === 0
  );

  sessions.closeAll?.();
} catch (e) {
  check("例外なく完走する", false, String(e));
  await page.screenshot({ path: `${SHOTS}/error.png` }).catch(() => {});
} finally {
  await browser.close();
  server.close();
  wss.close();
}

const ng = results.filter((r) => !r.ok).length;
process.stdout.write(`\n=== ${results.length} 件中 失敗 ${ng} 件 ===\n画像: ${SHOTS}\n`);
process.exit(ng === 0 ? 0 : 1);
