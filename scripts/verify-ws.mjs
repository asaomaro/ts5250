// T2: WebSocket E2E（実機）— サーバーを起動し、WS クライアントで /ws に接続して
// open(profile)→opened(メニュー)→key(F1)→screen→jobinfo を実機 PUB400 で検証する。
// 実行: node --env-file=.env scripts/verify-ws.mjs
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { buildApp, SessionManager, ProfileStore } from "@as400web/server";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3455;

const sessions = new SessionManager();
const profiles = ProfileStore.fromFile("profiles.local.json");
const app = buildApp({ sessions, profiles, version: "test" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 400));

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const inbox = [];
const waitFor = (type, ms = 15000) =>
  new Promise((resolve, reject) => {
    const check = () => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      if ((check.t = (check.t ?? 0) + 1) * 50 > ms) return reject(new Error(`timeout waiting ${type}`));
      setTimeout(check, 50);
    };
    check();
  });

ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));

let ok = true;
try {
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.send(JSON.stringify({ type: "open", profile: "pub400" }));
  const opened = await waitFor("opened");
  const onMenu = opened.screen.cells[0].map((c) => c.char).join("").includes("Main Menu");
  log(`opened: sessionId=${opened.sessionId.slice(0, 8)}… onMenu=${onMenu} fields=${opened.screen.fields.length}`);
  ok = ok && onMenu;

  ws.send(JSON.stringify({ type: "jobinfo" }));
  const job = await waitFor("jobinfo");
  log(`jobinfo: ${job.job.number}/${job.job.user}/${job.job.name}`);
  ok = ok && /^\d+$/.test(job.job.number);

  ws.send(JSON.stringify({ type: "key", key: "F1" }));
  const screen = await waitFor("screen");
  log(`screen after F1: keyboardLocked=${screen.screen.keyboardLocked} rows=${screen.screen.rows}`);

  ws.send(JSON.stringify({ type: "close" }));
  await waitFor("closed");
  log("closed ok");
} catch (err) {
  ok = false;
  log("WS E2E ERROR: " + err.message);
} finally {
  ws.close();
  server.close();
}
log(ok ? "T2: OK — WS E2E 成功" : "T2: NG");
process.exit(ok ? 0 : 1);
