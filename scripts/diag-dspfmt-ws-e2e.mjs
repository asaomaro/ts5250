// DSPFMT の罫線のみ表示バグを、実際にブラウザが辿る経路(packages/server の WS層)で再現するか
// 切り分ける診断。scripts/diag-dspfmt-reconnect-blank.mjs は @ts5250/tn5250 の Session5250 を
// 直接使うため web-ui/server 層を経由しない——それで6回とも正常だったので、コア層は無罪と分かった。
// この script は 実サーバー(packages/server) を起動し、ブラウザと同じ /ws プロトコルで接続して、
// 受信する "screen" メッセージの列を生JSONごと記録する。
// .aidev/works/20260915-dspfmt-reconnect-blank-redraw/research.md
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-dspfmt-ws-e2e.mjs [回数]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const ITERS = Number(process.argv[2] ?? 6);
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVER = join(REPO, "packages/server/dist/main.js");
const WEB_ROOT = join(REPO, "packages/web-ui/dist");
if (!existsSync(SERVER)) { log(`${SERVER} がありません（npm run build -w @ts5250/server）`); process.exit(2); }

async function freePort() {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

const profiles = join(mkdtempSync(join(tmpdir(), "ts5250-dspfmt-e2e-")), "profiles.json");
writeFileSync(profiles, JSON.stringify({ systems: [], sessions: [] }));
const port = await freePort();
const child = spawn(process.execPath, [SERVER, "--http", String(port), "--web-root", WEB_ROOT, "--profiles", profiles], {
  stdio: ["ignore", "inherit", "inherit"]
});
async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server が起動前に落ちた");
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.status === 200) return; } catch {}
    await sleep(150);
  }
  throw new Error("server が待ち受けを始めなかった");
}
await waitReady();
log(`server ready on :${port}`);

const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");
const BORDER_CHARS = /^[\s─-╿+\-|_]*$/u;
function isBorderOnly(snap) {
  const t = text(snap);
  const nonBorderLines = t.split("\n").filter((l) => l.trim() && !BORDER_CHARS.test(l));
  return { blank: nonBorderLines.length === 0, nonBorderLines };
}

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error("ws error: " + e?.message)));
  });
}

async function runOnce(iter) {
  log(`\n================ 試行 #${iter} (WS層経由、フレッシュ接続) ================`);
  const ws = await openWs();
  const events = []; // {t, type, screenSummary?}
  let currentSnap = null;
  let sessionId = null;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const t = Date.now();
    if (msg.type === "opened") { sessionId = msg.sessionId; currentSnap = msg.screen; }
    if (msg.type === "screen") currentSnap = msg.screen;
    if (msg.type === "key-done") currentSnap = msg.screen;
    events.push({ t, type: msg.type, keyboardLocked: msg.screen?.keyboardLocked });
  });

  ws.send(JSON.stringify({ type: "open", host, port: 23, ccsid: 5035, screenSize: "24x80" }));
  for (let i = 0; i < 50 && !sessionId; i++) await sleep(50);
  if (!sessionId) { log("  opened が来ませんでした"); ws.close(); return; }

  // --- サインオン（bare Session5250 診断と同じロジックを WsKey で再現） ---
  for (let i = 0; i < 10; i++) {
    const t = text(currentSnap);
    if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
    const inputs = currentSnap.fields.filter((f) => !f.protected);
    const fields = [];
    if (t.includes("サイン・オン") || t.includes("Sign On")) {
      if (inputs[0]) fields.push({ field: inputs[0].index, value: user });
      if (inputs[1]) fields.push({ field: inputs[1].index, value: password });
    } else if (t.includes("回復")) { if (inputs[0]) fields.push({ field: inputs[0].index, value: "90" }); }
    ws.send(JSON.stringify({ type: "key", key: "Enter", fields }));
    await sleep(700);
  }

  const cmdField = () => currentSnap.fields.filter((f) => !f.protected).find((f) => f.length > 20);
  const c = cmdField();
  events.length = 0;
  const t1 = Date.now();
  ws.send(JSON.stringify({
    type: "key", key: "Enter",
    fields: [{ field: c.index, value: `DSPFMT FILE(${LIB}/COMPLIST) OUTPUT(*)` }]
  }));

  const samples = [];
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (currentSnap) {
      const { blank, nonBorderLines } = isBorderOnly(currentSnap);
      samples.push({ dt: Date.now() - t1, blank, lines: nonBorderLines.length });
    }
  }
  log(`受信イベント数=${events.length}: ${events.map((e) => `${e.type}(t+${e.t - t1}ms,locked=${e.keyboardLocked})`).join(", ")}`);
  let prev = null;
  for (const sm of samples) {
    const state = sm.blank ? "BLANK(罫線のみ)" : `DATA(非罫線行${sm.lines})`;
    if (state !== prev) { log(`  t+${sm.dt}ms -> ${state}`); prev = state; }
  }
  const finalState = isBorderOnly(currentSnap);
  log(`>>> 最終状態: ${finalState.blank ? "罫線のみ（不具合再現！）" : "正常（データ表示あり）"}`);
  if (finalState.blank) {
    log("--- 罫線のみ状態のフルダンプ ---");
    text(currentSnap).split("\n").forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l); });
  }
  ws.close();
}

for (let i = 1; i <= ITERS; i++) {
  try { await runOnce(i); } catch (e) { log("エラー: " + (e?.stack ?? e)); }
  await sleep(300);
}
child.kill("SIGTERM");
process.exit(0);
