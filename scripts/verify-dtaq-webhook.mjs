// **待ち行列サービスの Webhook 転送**を実機で通しで確かめる（`20260801-dtaq-webhook`）。
//
// 単体テストは偽の送信なので、**実際のキューから読んだものが実際の HTTP で届くか**は測れない。
// さらに測りたいのはこの 2 つ:
//
//   1. **受け手が落ちていても監視が止まらない**——止まるとホスト側のキューが溢れ、
//      受け手の障害がホスト側の業務の障害になる
//   2. 諦めた分が**未達として残る**（監視は消費するので、黙って消えたら気づけない）
//
// 実行: node --env-file=.env scripts/verify-dtaq-webhook.mjs
//   （事前に `npm run build` が要る）
//
// 副作用: `TESTLIB/DTQHOOK` を**自動で作って消す**。受け口はこのプロセス内に立てる。
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver,
  WatchRegistry,
  makeWatchSink
} from "@ts5250/server";
import { DtaqConnection } from "@ts5250/hostserver";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const QUEUE = "DTQHOOK";
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 3491);
const APP_PORT = Number(process.env.PORT ?? 3492);
const SECRET = "verify-hook-token";

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};
async function until(fn, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(300);
  }
  return false;
}

// ---- 受け口（このプロセス内に立てる） ----
const received = [];
let respondWith = 200;
let hook = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ body: JSON.parse(body), headers: req.headers });
    res.writeHead(respondWith).end();
  });
});
await new Promise((r) => hook.listen(HOOK_PORT, "127.0.0.1", r));

const conn = () =>
  DtaqConnection.connect({ host, user, password });

const crypto = SecretCrypto.fromEnv();
const store = new ServerConfigStore(
  {
    systems: [{ id: "AS400", name: "AS400", host, ccsid: 5035, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
    sessions: [
      {
        id: "HOOKQ",
        name: "HOOKQ",
        system: "AS400",
        sessionType: "dtaqwatch",
        dtaqWatch: { library: LIB, name: QUEUE, encoding: "utf8" },
        webhook: {
          url: `http://127.0.0.1:${HOOK_PORT}/hook`,
          secretEnc: crypto.encrypt(SECRET),
          secretHeader: "X-Hook-Token",
          timeoutMs: 3000,
          maxAttempts: 3
        }
      }
    ]
  },
  crypto
);
const resolver = new ConfigResolver(store, new PersonalConfigStore({ systems: [], sessions: [] }, crypto));
const watches = new WatchRegistry();
const app = buildApp({ sessions: new SessionManager(), resolver, watches, version: "verify" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: APP_PORT, websocket: { server: wss } });
await sleep(400);

/** 別接続からエントリを送る（監視中の接続は待機中で使えない） */
async function send(text) {
  const c = await conn();
  try {
    await c.write(QUEUE, LIB, new TextEncoder().encode(text));
  } finally {
    c.close();
  }
}

try {
  const setup = await conn();
  await setup.deleteQueue(QUEUE, LIB).catch(() => undefined);
  await setup.create({ name: QUEUE, library: LIB, maxEntryLength: 100, type: "FIFO" });
  setup.close();
  log(`${LIB}/${QUEUE} を作成`);

  const t = resolver.resolve({ session: "srv:HOOKQ" }, undefined, (m) => log("  warn: " + m));
  check(t.webhook?.secret === SECRET, "**秘密が復号されて解決に載る**");
  const sink = makeWatchSink("srv:HOOKQ", t.webhook);
  const view = await watches.start({
    ref: "srv:HOOKQ",
    label: `${LIB}/${QUEUE}`,
    spec: t.session.dtaqWatch,
    connect: t.connect,
    sink
  });
  check(view.hasWebhook === true, "転送ありとして立ち上がる");

  // ---- 1. 実キュー → 実 HTTP ----
  log("\n### 1. 届く");
  await send("ORD-0001");
  check(await until(() => received.length >= 1), "**実キューのエントリが実際の HTTP で届く**");
  const first = received[0];
  check(first?.body.text === "ORD-0001", `本文が載る（${first?.body.text}）`);
  check(first?.body.queue === `${LIB}/${QUEUE}`, "キュー名が載る");
  check(first?.headers["x-hook-token"] === SECRET, "**秘密が設定したヘッダーで届く**");
  check(/^sha256=[0-9a-f]{64}$/.test(first?.headers["x-as400-signature"] ?? ""), "本文の署名が付く");
  check(typeof first?.headers["x-as400-delivery"] === "string", "配送 id が付く");

  // ---- 2. 受け手が落ちても監視は止まらない ----
  log("\n### 2. 受け手を落とす");
  await new Promise((r) => hook.close(r));
  await send("ORD-0002");
  await sleep(1500);
  const listing = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/watches`)).json();
  const row = listing.watches.find((w) => w.ref === "srv:HOOKQ");
  check(row?.state === "listening", `**受け手が落ちても監視は止まらない**（実際: ${row?.state}）`);
  check(row?.received >= 2, `キューからは読めている（受信 ${row?.received} 件）`);

  // ---- 3. 諦めたら未達に残る ----
  log("\n### 3. 諦める");
  check(
    await until(async () => {
      const l = await (await fetch(`http://127.0.0.1:${APP_PORT}/api/watches`)).json();
      return (l.watches.find((w) => w.ref === "srv:HOOKQ")?.undelivered ?? 0) >= 1;
    }, 40_000),
    "**諦めた分が「未達」として一覧に出る**（黙って消えない）"
  );

  // ---- 4. 受け手が戻れば再開する ----
  log("\n### 4. 受け手を戻す");
  hook = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body: JSON.parse(body), headers: req.headers });
      res.writeHead(respondWith).end();
    });
  });
  await new Promise((r) => hook.listen(HOOK_PORT, "127.0.0.1", r));
  await send("ORD-0003");
  check(
    await until(() => received.some((r) => r.body.text === "ORD-0003"), 40_000),
    "**受け手が戻れば、その後のエントリは届く**"
  );

  // ---- 5. 4xx は再試行しない ----
  log("\n### 5. 受け手が 400 を返す");
  respondWith = 400;
  const before = received.length;
  await send("ORD-0004");
  check(await until(() => received.length > before), "1 回は送る");
  await sleep(3000);
  check(
    received.filter((r) => r.body.text === "ORD-0004").length === 1,
    `**4xx は再試行しない**（実際: ${received.filter((r) => r.body.text === "ORD-0004").length} 回）`
  );
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
  log(e?.stack ?? "");
} finally {
  watches.closeAll();
  try {
    const c = await conn();
    await c.deleteQueue(QUEUE, LIB).catch(() => undefined);
    c.close();
  } catch { /* 後片付けの失敗は結論に影響しない */ }
  await new Promise((r) => hook.close(r)).catch(() => {});
  server.close();
  wss.close();
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
