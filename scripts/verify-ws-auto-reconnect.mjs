// **サーバー経由（ブラウザと同じ /ws）で、ホストに切られたら自動で繋ぎ直すか**を実機で確かめる（`20260921-auto-reconnect`）。
//
// 実サーバー（packages/server/dist）を起動し、ブラウザと同じ /ws で開いてサインオンし、
// `SIGNOFF ENDCNN(*YES)` でホストに切らせる。`host-reconnecting` → 施錠した `screen` →
// `host-reconnected` → 新しいサインオン画面の `screen` が届くか、`closed` にならないかを見る。
// コア単体の確認は `scripts/verify-auto-reconnect.mjs`。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-ws-auto-reconnect.mjs
//   AS400_HOST / AS400_USER / AS400_PASSWORD（`.env`）。資格情報は出力しない。
//   先に `npm run build`（server の dist と web-ui の dist が要る）。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const log = (s) => process.stdout.write(`${new Date().toISOString().slice(11, 23)} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = join(REPO, "packages/server/dist/main.js");
const WEB_ROOT = join(REPO, "packages/web-ui/dist");
if (!existsSync(SERVER)) { log(`${SERVER} がありません（npm run build）`); process.exit(2); }

async function freePort() {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}
const profiles = join(mkdtempSync(join(tmpdir(), "ts5250-reconnect-e2e-")), "profiles.json");
writeFileSync(profiles, JSON.stringify({ systems: [], sessions: [] }));
const port = await freePort();
const child = spawn(process.execPath, [SERVER, "--http", String(port), "--web-root", WEB_ROOT, "--profiles", profiles], {
  stdio: ["ignore", "ignore", "inherit"]
});
const deadline = Date.now() + 15000;
for (;;) {
  if (child.exitCode !== null) throw new Error("server が起動前に落ちた");
  try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.status === 200) break; } catch {}
  if (Date.now() > deadline) throw new Error("server が待ち受けを始めなかった");
  await sleep(150);
}
log(`server ready on :${port}`);

const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");
const head = (snap) => text(snap).split("\n").filter((l) => l.trim()).slice(0, 2).join(" | ").slice(0, 120);
const ws = await new Promise((res, rej) => {
  const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  w.addEventListener("open", () => res(w));
  w.addEventListener("error", () => rej(new Error("ws error")));
});
let snap = null, sessionId = null;
const seen = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "opened") { sessionId = m.sessionId; snap = m.screen; }
  if (m.type === "screen" || m.type === "key-done") snap = m.screen;
  if (m.type === "ping") return;
  const extra = m.type === "screen" ? ` locked=${m.screen.keyboardLocked} "${head(m.screen)}"`
    : m.type === "host-reconnecting" ? ` attempt=${m.attempt} reason=${m.reason}`
    : m.type === "jobinfo" ? ` job=${m.job?.name}` : m.type === "closed" ? ` reason=${m.reason} ended=${m.ended}` : "";
  seen.push(m.type);
  if (["host-reconnecting", "host-reconnected", "jobinfo", "closed", "screen"].includes(m.type)) log(`WS ${m.type}${extra}`);
});
ws.send(JSON.stringify({ type: "open", host, port: 23, ccsid, screenSize: "24x80" }));
for (let i = 0; i < 100 && !sessionId; i++) await sleep(50);
if (!sessionId) { log("opened が来ませんでした"); process.exit(1); }

for (let i = 0; i < 10; i++) {
  const t = text(snap);
  if (/===>/.test(t)) break;
  const inputs = snap.fields.filter((f) => !f.protected);
  const fields = [];
  if (t.includes("サイン・オン") || t.includes("Sign On")) {
    fields.push({ field: inputs[0].index, value: user }, { field: inputs[1].index, value: password });
  } else if (t.includes("回復")) fields.push({ field: inputs[inputs.length - 1].index, value: "90" });
  ws.send(JSON.stringify({ type: "key", key: "Enter", fields }));
  await sleep(900);
}
log(`signed on: ${head(snap)}`);
seen.length = 0;
const cmd = snap.fields.filter((f) => !f.protected).find((f) => f.length > 20);
ws.send(JSON.stringify({ type: "key", key: "Enter", fields: [{ field: cmd.index, value: "SIGNOFF ENDCNN(*YES)" }] }));
for (let i = 0; i < 60 && !seen.includes("host-reconnected") && !seen.includes("closed"); i++) await sleep(250);
await sleep(2500);
const ok = seen.includes("host-reconnecting") && seen.includes("host-reconnected") && !seen.includes("closed")
  && !snap.keyboardLocked && /サイン・オン|Sign On/.test(text(snap));
log(`final: locked=${snap.keyboardLocked} "${head(snap)}"`);
log(`RESULT: ${ok ? "サーバー経由でも自動で繋ぎ直し、新しいサインオン画面が届いた" : "期待どおりでない"} (${seen.filter((t) => t !== "ping").join(",")})`);
ws.send(JSON.stringify({ type: "close" }));
await sleep(500);
ws.close();
child.kill("SIGTERM");
process.exit(ok ? 0 : 1);
