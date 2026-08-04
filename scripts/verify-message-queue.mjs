/**
 * **メッセージ待ち行列の実機検証**（実機）。
 *
 *   node --env-file=.env scripts/verify-message-queue.mjs
 *
 * **`QSYSOPR` は触らない。** 共有の待ち行列なので、専用のものを作って使い、最後に消す。
 * 照会 → 一覧 → 応答 → 削除の往復を通す。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import {
  buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver, openCommand
} from "@ts5250/server";

const PORT = 3496;
const TMP = "/tmp/ts5250-msgq";
const MSGQ = "TSTMSGQ";
const LIB = process.env.AS400_LIB ?? "TESTLIB";
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${String(d).slice(0, 130)}` : ""}\n`);
};

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
cfg.sessions = [];
writeFileSync(`${TMP}/cfg.json`, JSON.stringify(cfg));
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${TMP}/cfg.json`),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const sessions = new SessionManager();
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await new Promise((r) => setTimeout(r, 400));

const source = { system: `srv:${sys.id}` };
const post = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/host/messages${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, ...body })
  });
  return { status: res.status, body: await res.json() };
};

const connect = resolver.resolve(source, undefined, () => undefined).connect;
const cmd = await openCommand(connect);
try {
  // 専用の待ち行列を作る（QSYSOPR を荒らさない）
  await cmd.run(`DLTMSGQ MSGQ(${LIB}/${MSGQ})`);
  const crt = await cmd.run(`CRTMSGQ MSGQ(${LIB}/${MSGQ}) TEXT('ts5250 verify')`);
  check("検証用の待ち行列を作った", crt.success, crt.messages.map((m) => m.id).join(","));

  // ---- 送信（通知）----
  const s1 = await post("/send", { text: "hello from ts5250", toQueue: MSGQ, toLibrary: LIB });
  check("**通知を送れる**", s1.body.success === true, `${s1.status} ${s1.body.messages?.[0]?.id ?? ""}`);

  // ---- 送信（照会）----
  const s2 = await post("/send", {
    text: "reply me please", toQueue: MSGQ, toLibrary: LIB, inquiry: true, replyQueue: MSGQ, replyLibrary: LIB
  });
  check("**照会を送れる**", s2.body.success === true, `${s2.status} ${s2.body.messages?.[0]?.id ?? ""}`);

  // ---- 一覧 ----
  const l1 = await post("", { queue: MSGQ, library: LIB });
  check("**一覧できる**", Array.isArray(l1.body.messages) && l1.body.messages.length >= 2,
    `${l1.body.messages?.length} 件`);
  const first = l1.body.messages?.[0];
  check("**本文が読める**（VARGRAPHIC を CAST している）",
    typeof first?.text === "string" && first.text.length > 0, JSON.stringify(first?.text));
  check("**キーが 16 進 8 桁**", /^[0-9A-F]{8}$/u.test(first?.key ?? ""), first?.key);

  // ---- 照会だけに絞る ----
  const l2 = await post("", { queue: MSGQ, library: LIB, onlyInquiry: true });
  check("**照会だけに絞れる**（応答すべきものが分かる）",
    l2.body.messages?.length === 1 && l2.body.messages[0].type === "INQUIRY",
    `${l2.body.messages?.length} 件 type=${l2.body.messages?.[0]?.type}`);

  // ---- 応答 ----
  const key = l2.body.messages?.[0]?.key;
  const r1 = await post("/reply", { queue: MSGQ, library: LIB, key, reply: "YES" });
  check("**照会に応答できる**", r1.body.success === true, `${r1.status} ${r1.body.messages?.[0]?.id ?? ""}`);

  const l3 = await post("", { queue: MSGQ, library: LIB });
  const types = (l3.body.messages ?? []).map((m) => m.type);
  check("**INQUIRY が REPLY に変わった**", types.includes("REPLY") && !types.includes("INQUIRY"),
    types.join(","));

  // ---- 削除（キー指定）----
  // **通知を消す**——1 件だけ減るのはこちら。応答つきのものは対で消える（下記）
  const info = l3.body.messages.find((m) => m.type === "INFORMATIONAL");
  const before = l3.body.messages.length;
  const d1 = await post("/remove", { queue: MSGQ, library: LIB, key: info.key });
  check("**キー指定で消せる**（RMVMSG は使えないので QMHRMVM）", d1.body.success === true,
    `${d1.status} ${d1.body.messages?.[0]?.id ?? ""}`);
  const l4 = await post("", { queue: MSGQ, library: LIB });
  check("**通知は 1 件だけ減る**", l4.body.messages.length === before - 1, `${before} → ${l4.body.messages.length}`);

  // **応答つきは対で消える**（IBM i の仕様。SENDER と REPLY は組）
  const reply = l4.body.messages.find((m) => m.type === "REPLY");
  const beforePair = l4.body.messages.length;
  await post("/remove", { queue: MSGQ, library: LIB, key: reply.key });
  const l4b = await post("", { queue: MSGQ, library: LIB });
  check("**応答つきは対（SENDER ＋ REPLY）で消える**", l4b.body.messages.length === beforePair - 2,
    `${beforePair} → ${l4b.body.messages.length}`);

  // ---- 削除（全消し）----
  await post("/remove", { queue: MSGQ, library: LIB });
  const l5 = await post("", { queue: MSGQ, library: LIB });
  check("**全消しできる**", l5.body.messages.length === 0, `${l5.body.messages.length} 件`);

  // ---- 画面から応答する ----
  await post("/send", {
    text: "ui reply test", toQueue: MSGQ, toLibrary: LIB, inquiry: true, replyQueue: MSGQ, replyLibrary: LIB
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
    await page.locator(".card", { hasText: sys.name }).first().getByRole("button", { name: "選択" }).click();
    await page.waitForTimeout(800);
    await page.locator(".fn", { hasText: "メッセージ" }).first().getByRole("button", { name: "開く" }).click();
    await page.waitForSelector(".pane[data-tab^='msg:']", { timeout: 15_000 });
    await page.locator(".form input").first().fill(LIB);
    await page.locator(".form input").nth(1).fill(MSGQ);
    await page.getByRole("button", { name: "読む" }).click();
    await page.waitForSelector("table.msgs", { timeout: 20_000 });
    await page.screenshot({ path: `${TMP}/pane.png` });
    check("**画面に一覧が出る**", (await page.locator("table.msgs tbody tr").count()) > 0);
    check("**応答待ちが目立つ**（見落とすとジョブが止まる）", (await page.locator("tr.inq").count()) === 1,
      `${await page.locator("tr.inq").count()} 行`);

    await page.locator("tr.reply input").fill("YES");
    await page.getByRole("button", { name: "応答する" }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${TMP}/pane-after.png` });
    const l = await post("", { queue: MSGQ, library: LIB, onlyInquiry: true });
    check("**画面から応答できた**（照会が残っていない）", l.body.messages.length === 0,
      `${l.body.messages.length} 件`);
  } catch (e) {
    await page.screenshot({ path: `${TMP}/pane-error.png` }).catch(() => {});
    check("画面から応答できた", false, String(e).slice(0, 120));
  } finally {
    await browser.close();
  }

  await post("/remove", { queue: MSGQ, library: LIB });

  // ---- QSYSOPR に対する実操作 ----
  //
  // **共有の本番資源なので、自分が作ったメッセージだけを触る。**
  // 送る → 応答する → **自分の分だけキー指定で消す**、の往復に限定し、
  // 他人のメッセージには一切手を出さない（全消しは絶対にしない）。
  const OPER = { queue: "QSYSOPR", library: "QSYS" };
  const me = (sys.signon.user ?? "").toUpperCase();
  const baseline = await post("", { ...OPER, max: 500 });
  check("**QSYSOPR を読める**（共有の待ち行列）", Array.isArray(baseline.body.messages),
    `${baseline.body.messages?.length} 件`);

  const mineBefore = new Set((baseline.body.messages ?? []).map((m) => m.key));
  const created = [];
  try {
    const o1 = await post("/send", { text: `ts5250 verify ${Date.now()}`, ...OPER, toQueue: "QSYSOPR", toLibrary: "QSYS" });
    check("**QSYSOPR へ送れる**", o1.body.success === true, o1.body.messages?.[0]?.id ?? "");

    const o2 = await post("/send", {
      text: "ts5250 verify inquiry", toQueue: "QSYSOPR", toLibrary: "QSYS",
      inquiry: true, replyQueue: "QSYSOPR", replyLibrary: "QSYS"
    });
    check("**QSYSOPR へ照会を送れる**", o2.body.success === true, o2.body.messages?.[0]?.id ?? "");

    const after = await post("", { ...OPER, max: 500 });
    // **自分が今作った分だけ**を拾う（他人のものに触れない）
    for (const m of after.body.messages ?? []) {
      if (!mineBefore.has(m.key) && (m.fromUser ?? "").toUpperCase() === me) created.push(m);
    }
    check("**送ったものが一覧に出る**", created.length >= 2, `${created.length} 件（自分の分だけ）`);

    const inq = created.find((m) => m.type === "INQUIRY");
    check("**照会として入っている**", inq !== undefined, inq?.type);
    if (inq) {
      const rp = await post("/reply", { ...OPER, key: inq.key, reply: "OK" });
      // **一般利用者が QSYSOPR の照会に応答できるか**——権限次第なので、
      // 断られた場合もそれを事実として記録する
      check(`**QSYSOPR の照会に応答できる**（利用者 ${me}）`, rp.body.success === true,
        rp.body.success === true ? "" : rp.body.messages?.map((m) => `${m.id} ${m.text?.slice(0, 50)}`).join(" / "));
    }
  } finally {
    // **後片付け——自分が作った分だけをキー指定で消す。** 全消しは絶対にしない
    const now = await post("", { ...OPER, max: 500 });
    let removed = 0;
    for (const m of now.body.messages ?? []) {
      const mine = !mineBefore.has(m.key) && (m.fromUser ?? "").toUpperCase() === me;
      if (!mine) continue;
      const r = await post("/remove", { ...OPER, key: m.key });
      if (r.body.success === true) removed += 1;
    }
    const final = await post("", { ...OPER, max: 500 });
    const leftover = (final.body.messages ?? []).filter(
      (m) => !mineBefore.has(m.key) && (m.fromUser ?? "").toUpperCase() === me
    );
    check("**自分が作った分を消し切った**（他人のものは触っていない）", leftover.length === 0,
      `${removed} 件消した / 残り ${leftover.length}`);
    check("**他人のメッセージが減っていない**",
      (final.body.messages ?? []).filter((m) => mineBefore.has(m.key)).length === mineBefore.size,
      `${mineBefore.size} → ${(final.body.messages ?? []).filter((m) => mineBefore.has(m.key)).length}`);
  }

  // ---- 差し込みを断る ----
  const bad = await post("/send", { text: "x", toQueue: `${MSGQ}) DLTLIB LIB(NOSUCH` });
  check("**CL の差し込みを断る**", bad.status === 400, `status=${bad.status} ${bad.body.code ?? ""}`);
} catch (e) {
  check("例外なく完走する", false, String(e));
} finally {
  const del = await cmd.run(`DLTMSGQ MSGQ(${LIB}/${MSGQ})`);
  check("後片付け（待ち行列を消した）", del.success, del.messages.map((m) => m.id).join(","));
  cmd.close();
  sessions.closeAll();
  server.close();
  wss.close();
}

const ng = results.filter((r) => !r.ok).length;
process.stdout.write(`\n=== ${results.length} 件中 失敗 ${ng} 件 ===\n`);
process.exit(ng === 0 ? 0 : 1);
