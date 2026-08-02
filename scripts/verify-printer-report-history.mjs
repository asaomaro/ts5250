// **閉じている間に届いた帳票が、開き直したときにブラウザまで届くか**
// （`20260802-printer-report-history`）。
//
// サーバーは `20260801-printer-attach-by-ref` から `printer-opened.reports` に載せていたが、
// **受け手（web-ui）が捨てていた**——常駐が夜のうちに受け取った帳票が、朝ブラウザを開くと
// 1 件も無かった。捨てていた側は vitest で直したので、ここでは**電文の側**を実機で見る。
//
// `SessionManager` を直接叩く既存スクリプト（residency / startstop）と違い、
// **`WsConnection` を通す**——壊れていたのがこの層（電文の投影）だから。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/verify-printer-report-history.mjs
//
// 副作用: 既存の仮想プリンター装置を借り（既定 PRT_TEST）、自分のジョブのスプールを 1 件流す。
// ライターは必ず止め、スプールは消す。**装置は作らない・消さない。**
import { SessionManager, WsConnection, ConfigResolver, ServerConfigStore, PersonalConfigStore } from "@ts5250/server";
import { CommandConnection } from "@ts5250/hostserver";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

const PRTDEV = process.env.AS400_PRTDEV ?? "PRT_TEST";
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, msg) => {
  if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); }
};

// **パスワードは env のまま渡す**（`passwordEnv`）。設定オブジェクトにも平文を置かない
const server = new ServerConfigStore({
  systems: [{ id: "sys", name: "verify", host, signon: { user, passwordEnv: "AS400_PASSWORD" } }],
  sessions: [
    {
      id: "p",
      name: "帳票検証",
      system: "sys",
      sessionType: "printer",
      deviceName: PRTDEV,
      // **サービス ✅ で常駐**——WS が切れても待ち受けを続ける（これが前提）
      printer: { service: true }
    }
  ]
});
const resolver = new ConfigResolver(server, new PersonalConfigStore());
const sessions = new SessionManager();

/** ブラウザ 1 枚ぶんの WS。届いた電文を全部ためる */
function openBrowser() {
  const got = [];
  const conn = new WsConnection({ sessions, resolver }, { send: (d) => got.push(JSON.parse(d)), close: () => {} });
  return { conn, got, find: (t) => got.find((m) => m.type === t) };
}

let cc;
let entry;
try {
  cc = await CommandConnection.connect({ host, user, password });
  // **前の実行の残骸を先に落とす。** ライターが古いセッションを掴んだままだと
  // スプールは READY のまま溜まり、こちらには何も届かない
  await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`).catch(() => {});
  await cc.run(`CLROUTQ OUTQ(${PRTDEV})`).catch(() => {});
  await sleep(2000);
  await cc.run(`VRYCFG CFGOBJ(${PRTDEV}) CFGTYPE(*DEV) STATUS(*ON)`).catch(() => {});

  // ---- 1. 1 枚目のブラウザで開く ----
  log("### 1. ブラウザで開く（待ち受け開始）");
  const first = openBrowser();
  await first.conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
  const opened1 = first.find("printer-opened");
  entry = sessions.listPrinters()[0];
  log(`  id=${entry?.id} state=${opened1?.state} startupCode=${opened1?.startupCode} resident=${entry?.resident}`);
  check(opened1 !== undefined, "printer-opened が返る");
  check(entry?.resident === true, "サービス ✅ なので常駐する");
  check(Array.isArray(opened1?.reports) && opened1.reports.length === 0, "最初は帳票 0 件");

  await cc.run(`STRPRTWTR DEV(${PRTDEV}) OUTQ(${PRTDEV})`).catch(() => {});

  // ---- 2. ブラウザを閉じる ----
  log("\n### 2. ブラウザを閉じる（WS 切断。**待ち受けは続く**）");
  const closedAt = Date.now();
  first.conn.onSocketClose();
  check(entry.onReport === undefined, "push のフックが外れる（＝誰も見ていない）");
  check(sessions.listPrinters().length === 1, "エントリは残る（常駐）");

  // ---- 3. 閉じている間にスプールを流す ----
  log("\n### 3. 閉じている間にスプールを流す");
  await sleep(1000);
  await cc.run(`CHGJOB OUTQ(${PRTDEV})`);
  // **用紙タイプはずらさない**（ずらすと MSGW で止まる。ここは素通しさせたい）
  await cc.run("DSPLIBL OUTPUT(*PRINT)");
  const t0 = Date.now();
  while (Date.now() - t0 < 45_000 && entry.reports.length === 0) await sleep(1000);
  const arrivedBy = Date.now();
  log(`  受信した帳票: ${entry.reports.length} 件`);
  check(entry.reports.length >= 1, "ブラウザが居なくても受信する");
  check(typeof entry.reports[0]?.receivedAt === "number", "**サーバーが受信時刻を刻んでいる**");

  // ---- 4. 開き直す ----
  log("\n### 4. 開き直す（別のブラウザ）");
  await sleep(1500);
  const reopenAt = Date.now();
  const second = openBrowser();
  await second.conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
  const opened2 = second.find("printer-opened");
  const got = opened2?.reports ?? [];
  log(`  printer-opened.reports=${got.length} receivedTotal=${opened2?.receivedTotal}`);
  check(got.length >= 1, "**閉じている間に届いたぶんが電文に載る**");
  check(opened2?.receivedTotal === entry.receivedTotal, `累計が一致（${opened2?.receivedTotal}）`);
  check(got[0]?.pages?.length >= 1, "本文（ページ）が載っている");

  // ---- 5. 時刻が「届いた時刻」であること ----
  log("\n### 5. 受信時刻");
  const at = got[0]?.receivedAt;
  log(`  閉じた=${new Date(closedAt).toISOString()}`);
  log(`  受信=${at === undefined ? "(なし)" : new Date(at).toISOString()}`);
  log(`  開き直し=${new Date(reopenAt).toISOString()}`);
  check(typeof at === "number", "電文に receivedAt が載る");
  // **これが本題**——開いた時刻で押していると、この 2 つが両方とも成り立たない
  check(at > closedAt && at <= arrivedBy, "**閉じている間の時刻**である（開き直した時刻ではない）");
  check(at < reopenAt, "開き直しより前の時刻");

  second.conn.onSocketClose();
} catch (e) {
  fail++;
  log(`  FAIL 例外: ${e?.message ?? e}`);
} finally {
  try { if (entry) await sessions.close(entry.id); } catch { /* 良い */ }
  try { if (cc) await cc.run(`ENDWTR WTR(${PRTDEV}) OPTION(*IMMED)`); } catch { /* 良い */ }
  // **自分が作ったスプールは消す**（READY のまま溜めない）
  try { if (cc) await cc.run(`CLROUTQ OUTQ(${PRTDEV})`); } catch { /* 良い */ }
  cc?.close?.();
}

log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
