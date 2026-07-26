// WebSocket 経路の Attn / SysReq 検証（実機）。
//
// **ユニットテストで埋まらない穴はここ**——ws-handler が `sysReqText` を core まで渡せているか、
// Cancel Invite の ack がサーバー経由でも成立するかは、実際に繋がないと分からない。
// 実行: node --env-file=.env scripts/verify-ws-sysreq.mjs
//   SRQ_DEV=QPADEV000x（既定 QPADEV0002）
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver
} from "@as400web/server";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";

const log = (s) => process.stderr.write(s + "\n");
const PORT = 3466;
const DEV = process.env.SRQ_DEV ?? "QPADEV0002";
const CONF = join(tmpdir(), "as400web-conn-srq.json");

// 装置名だけ差し替えた設定を作る（利用者が使っている DEV1 を奪わない）
const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
cfg.sessions = [
  { id: "srq", name: "SRQ", system: sys.id, sessionType: "display", deviceName: DEV, screenSize: "24x80", ccsid: 939 }
];
writeFileSync(CONF, JSON.stringify(cfg));

const sessions = new SessionManager();
const crypto = SecretCrypto.fromEnv();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(CONF, crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions, resolver, version: "test" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 400));

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const inbox = [];
const waitFor = (type, ms = 20000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting ${type}`));
      setTimeout(check, 50);
    };
    check();
  });
const rowsOf = (screen) => screen.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, ""));
const textOf = (screen) => rowsOf(screen).join("\n");

ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));

let ok = true;
const check = (label, cond) => {
  log(`${cond ? "OK  " : "NG  "} ${label}`);
  ok = ok && cond;
};

try {
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.send(JSON.stringify({ type: "open", session: "srv:srq" }));
  const opened = await waitFor("opened");
  let screen = opened.screen;

  log("--- 接続直後の画面 ---");
  rowsOf(screen).forEach((t, i) => { if (t) log(String(i + 1).padStart(2) + "|" + t); });

  // 前回のジョブが残っていると「対話式ジョブの回復」が出る。既定（実行キー）で進める
  while (/回復|ジョブの再開/.test(textOf(screen))) {
    ws.send(JSON.stringify({ type: "key", key: "Enter" }));
    screen = (await waitFor("key-done")).screen;
  }

  /**
   * メインメニューまで進める。出うる画面を 1 つのループで捌く:
   *  - サイン・オン          … 自動サインオンが効かない設定なので手で埋める
   *  - 対話式ジョブの回復の試み … **前回を切断で終えると出る**。選べるのは 1（回復）か 90（サインオフ）だけで、
   *                            素の実行キーでは抜けられない。90 で前ジョブを畳む（後片付けも兼ねる）
   *  - サインオン情報 等      … 実行キーで送る
   */
  const password = crypto.decrypt(sys.signon.passwordEnc);
  for (let i = 0; i < 8 && !textOf(screen).includes("メインメニュー"); i++) {
    const t = textOf(screen);
    log(`  進行 #${i}: ${rowsOf(screen).find((r) => r) ?? "(空)"}`);
    const inputs = screen.fields.filter((f) => !f.protected);
    let fields;
    if (t.includes("サイン・オン") && inputs.length >= 2) {
      fields = [
        { field: inputs[0].index, value: sys.signon.user },
        { field: inputs[1].index, value: password }
      ];
    } else if (/回復の試み/.test(t) && inputs[0]) {
      fields = [{ field: inputs[0].index, value: "90" }]; // 90 = 前のジョブのサイン・オフ
    }
    ws.send(JSON.stringify({ type: "key", key: "Enter", ...(fields ? { fields } : {}) }));
    screen = (await waitFor("key-done")).screen;
  }
  log(`  到達: ${rowsOf(screen).find((t) => t) ?? "(空)"}`);
  check("メインメニューに到達", textOf(screen).includes("メインメニュー"));

  // --- Attn（ATNPGM の窓が出る＝Cancel Invite の ack がサーバー経由でも成立している） ---
  ws.send(JSON.stringify({ type: "key", key: "Attn" }));
  const attnDone = await waitFor("key-done");
  check("Attn がタイムアウトしない", attnDone.timedOut === false);
  check("Attn でコマンド入力の窓が出る", textOf(attnDone.screen).includes("コマンド入力"));
  ws.send(JSON.stringify({ type: "key", key: "F3" }));
  screen = (await waitFor("key-done")).screen;
  check("F3 で背面（メインメニュー）が戻る", textOf(screen).includes("メインメニュー"));

  // --- SysReq（sysReqText が core まで届いているか） ---
  ws.send(JSON.stringify({ type: "key", key: "SysReq", sysReqText: "3" }));
  const srqDone = await waitFor("key-done");
  check("SysReq がタイムアウトしない", srqDone.timedOut === false);
  // "3" = 現行ジョブの表示。メニューではなくジョブ表示へ直行していれば文字列が届いている
  check("sysReqText \"3\" が届いてジョブの表示へ直行する", textOf(srqDone.screen).includes("ジョブの表示"));
  check("システム要求メニューを経由していない", !textOf(srqDone.screen).includes("2 次ジョブのサインオンの表示"));

  ws.send(JSON.stringify({ type: "close" }));
  await waitFor("closed");
} catch (err) {
  ok = false;
  log("ERROR: " + err.message);
} finally {
  ws.close();
  server.close();
}
log(ok ? "RESULT: OK — WS 経路の Attn / SysReq 成功" : "RESULT: NG");
process.exit(ok ? 0 : 1);
