// **「長い処理のあいだ出したローディングが、終わったら消えるか」**を実ブラウザ＋実機で確かめる。
//
//   node --env-file=.env --env-file=.env.verify scripts/verify-browser-msgloop-loading.mjs
//
// 応答タイムアウトを廃した（#388）あと「**ローディングが解除されない**」という報告が出た。
// 待ちを解く合図は 2 つしかない:
//
//   `screen` で**施錠が解けた画面**が届く（`session-controller` の `if (!keyboardLocked)`）
//   `key-done` が届く（`sendAid` が解決した＝ホストが Read を出した）
//
// どちらも来なければスピナーは出たままになる。**その途中でホストが何を送ってくるか**は
// 実機でしか分からないので、60 秒走る CL を 2 通り呼んで比べる
// （どちらも `scripts/build-msgloop.mjs` で作る）:
//
//   MSGLOOP … 1 秒ごとに `SNDMSG`（利用者の待ち行列へ）。**画面には何も来ない**
//   STSLOOP … 1 秒ごとに状況メッセージ（`TOPGMQ(*EXT) MSGTYPE(*STATUS)`）。
//             **施錠されたままの画面がホストから降ってくる**——#388 で入れた
//             「施錠された画面では待ちを解かない」規則を実際に通る唯一の経路
//
// 見るもの:
//   A. 押した直後（0.5 秒超）に**スピナーが出る**か
//   B. 待っているあいだ、スピナーと入力プロテクトが**出たまま**か
//   C. 何秒待たされても**こちらからは何も言わない**か（ACS 準拠。30 秒通知は廃止した）
//   D. **プログラムが終わったらローディングが消え、入力できるようになるか**  ← 報告の主題
//   E. 途中で降ってくる**施錠されたままの画面で待ちを解いていない**か（STSLOOP のみ）
//
// 判定材料として、**ブラウザが実際に受け取った WS フレーム**（`screen` の `keyboardLocked` と
// `key-done`）を時刻つきで残す——「消えない」ときに、ホストが解錠を送っていないのか、
// 送っているのに画面側が解いていないのかを分けるため。
//
// 前提: npm run build && npm run build -w @ts5250/web-ui 済み。
//       profiles.local.json に実機（AS400_SYSTEM）と表示セッション（AS400_SESSION）。
//       実機に MSGLOOP / STSLOOP（scripts/build-msgloop.mjs）。
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildApp, SessionManager, ServerConfigStore, PersonalConfigStore, ConfigResolver } from "@ts5250/server";
import { CommandConnection, DbConnection, queryLimited } from "@ts5250/hostserver";
import { SecretCrypto } from "../packages/server/dist/secret-crypto.js";
import { chromium } from "playwright";

const PORT = Number(process.env.MSGLOOP_PORT ?? 3491);
const SYSTEM = process.env.AS400_SYSTEM ?? "AS400";
const SESSION = process.env.AS400_SESSION ?? "DEV1";
const LIB = process.env.AS400_LIB ?? "TESTLIB";
/** サインオン画面に落ちたときの手打ち用（自動サインオンが効かない実機がある） */
const USER = process.env.AS400_USER ?? "";
const PASSWORD = process.env.AS400_PASSWORD ?? "";
/** MSGLOOP / STSLOOP が回る秒数（`build-msgloop.mjs` の `MSGLOOP_SECS` と合わせる） */
const SECS = Number(process.env.MSGLOOP_SECS ?? 60);
/** 見限るまで。プログラムの秒数＋余裕（往復・画面の揺れを吸収） */
const WATCH_MS = (SECS + 40) * 1000;
const TMP = process.env.MSGLOOP_TMP ?? "/tmp/ts5250-msgloop";
mkdirSync(TMP, { recursive: true });

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${name}${detail ? " — " + detail : ""}\n`);
};

// ---- サーバー（実アプリ構成。web-ui の dist をそのまま配る）----
const crypto = SecretCrypto.fromEnv();
if (!crypto) log("WARN: AS400_SECRET_KEY 未設定——自動サインオンが効かず、手打ちに落ちます");
const sessions = new SessionManager();
const resolver = new ConfigResolver(
  ServerConfigStore.fromFile("profiles.local.json", crypto),
  new PersonalConfigStore({ systems: [], sessions: [] }, crypto)
);
const app = buildApp({ sessions, resolver, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(600);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => log("PAGEERR " + e.message));

// ---- WS フレームの記録（判定の根拠。中身は要点だけ残す）----
const t0 = Date.now();
const frames = [];
const note = (dir, msg) => {
  const rec = { ms: Date.now() - t0, dir, type: msg.type };
  if (msg.type === "screen") rec.locked = msg.screen?.keyboardLocked;
  if (msg.type === "key-done") {
    rec.locked = msg.screen?.keyboardLocked;
    rec.timedOut = msg.timedOut;
  }
  if (msg.type === "key") rec.key = msg.key;
  if (msg.type === "error") rec.detail = `${msg.code}: ${msg.message}`;
  frames.push(rec);
};
page.on("websocket", (ws) => {
  ws.on("framereceived", ({ payload }) => {
    try {
      note("<-", JSON.parse(String(payload)));
    } catch {
      /* テキストでないフレームは見ない */
    }
  });
  ws.on("framesent", ({ payload }) => {
    try {
      note("->", JSON.parse(String(payload)));
    } catch {
      /* 同上 */
    }
  });
});

/** いまの画面の状態を 1 つにまとめて取る（スピナー・施錠・操作員メッセージ・入力可否・カーソル） */
const probe = () =>
  page.evaluate(() => ({
    busy: document.querySelector(".busy-overlay") !== null,
    loading: document.querySelector(".busy-overlay.loading") !== null,
    // **待ちの最中にマウスカーソルが何になっているか。** 砂時計（`wait` / `progress`）は
    // 「このアプリが固まっている」の合図なので、ホストを待っているだけの場面で出してはいけない
    cursor: (() => {
      const el = document.querySelector(".busy-overlay");
      return el ? getComputedStyle(el).cursor : "";
    })(),
    lock: document.querySelector(".oia .lock") !== null,
    opmsg: document.querySelector(".opmsg")?.textContent?.trim() ?? "",
    editable: document.querySelectorAll("input.grid-input:not([readonly])").length,
    grid: document.querySelector(".grid")?.textContent ?? ""
  }));

const shot = async (name) => {
  const p = `${TMP}/${name}.png`;
  await page.screenshot({ path: p });
  log(`shot: ${p}`);
};

/** コマンド行に打って Enter（メインメニューの最初の入力欄＝コマンド行） */
async function typeCommand(text) {
  const el = page.locator("input.grid-input:not([readonly])").first();
  await el.click();
  await page.keyboard.press("Home");
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press("Enter");
}

/**
 * `CALL <pgm>` を打ってから待ちが解けるまで観測する。
 * 250ms ごとの標本と、その間に届いた WS フレームを返す。
 */
async function runAndWatch(pgm, tag) {
  const cmd = `CALL ${LIB}/${pgm}`;
  const mark = frames.length;
  const sentAt = Date.now();
  frames.push({ ms: sentAt - t0, dir: "**", type: cmd });
  await typeCommand(cmd);

  const samples = [];
  let firstLoading, clearedAt, grid35;
  let shot10 = false, shot35 = false;
  while (Date.now() - sentAt < WATCH_MS) {
    const s = await probe();
    const ms = Date.now() - sentAt;
    samples.push({ ms, busy: s.busy, loading: s.loading, cursor: s.cursor, lock: s.lock, opmsg: s.opmsg, editable: s.editable });
    if (s.loading && firstLoading === undefined) firstLoading = ms;
    // **消えた瞬間**を拾う。スピナーも通信中プロテクトも消えたところで待ちが解けたとみなす
    if (!s.busy && !s.loading && firstLoading !== undefined && clearedAt === undefined) {
      clearedAt = ms;
      await shot(`${tag}-cleared`);
      break;
    }
    if (!shot10 && ms > 10_000) { shot10 = true; await shot(`${tag}-during-10s`); }
    // **30 秒を越えた時点の画面**を採っておく。旧実装はここで自前の通知を出し、
    // ホストが書いている進捗表示を押しのけていた（`MSG_WAITING_LONG`。利用者の指摘で廃止）
    if (!shot35 && ms > 35_000) { shot35 = true; grid35 = s.grid; await shot(`${tag}-during-35s`); }
    await sleep(250);
  }
  if (clearedAt === undefined) await shot(`${tag}-stuck`);
  const last = await probe();
  const rx = frames.slice(mark).filter((f) => f.dir === "<-" && f.type !== "ping" && f.type !== "pong");
  return { pgm, sentAt, samples, firstLoading, clearedAt, grid35, last, rx };
}

/** 観測結果を A〜D で判定する（E は画面へ来る STSLOOP だけ別に見る） */
function judge(r, label) {
  const at = (ms) => r.samples.filter((s) => s.ms <= ms).at(-1) ?? r.samples[0];
  const s10 = at(10_000), s35 = at(35_000);
  check(`${label} A 押した直後にローディング（スピナー）が出る`,
    r.firstLoading !== undefined && r.firstLoading < 3000,
    r.firstLoading === undefined ? "一度も出なかった" : `${r.firstLoading}ms`);
  check(`${label} B 10 秒後もスピナーと入力プロテクトが出たまま`,
    s10?.busy === true && s10?.loading === true,
    JSON.stringify({ busy: s10?.busy, loading: s10?.loading, 施錠表示: s10?.lock, 入力欄: s10?.editable }));
  check(`${label} B' 30 秒を越えても待ちを打ち切らない（旧実装はここで諦めていた）`,
    s35?.busy === true && s35?.loading === true,
    JSON.stringify({ busy: s35?.busy, loading: s35?.loading, 施錠表示: s35?.lock }));
  // **待たされている間、こちらからは何も言わない**（ACS と同じ）。以前は 30 秒で
  // 「ホストの応答を待っています…」を出していたが、ACS にも実機にも無い動きなのでやめた
  const noticed = r.samples.filter((s) => /待っています/.test(s.opmsg));
  check(`${label} C 何秒待たされても操作員メッセージを出さない（ACS 準拠）`,
    noticed.length === 0,
    noticed.length === 0 ? "1 度も出ない" : `${noticed[0].ms}ms に「${noticed[0].opmsg}」`);
  check(`${label} D ${SECS} 秒のプログラムが終わったらローディングが解除される`,
    r.clearedAt !== undefined,
    r.clearedAt === undefined
      ? `${Math.round(WATCH_MS / 1000)} 秒待っても消えない（busy=${r.last.busy} loading=${r.last.loading} lock=${r.last.lock}）`
      : `${(r.clearedAt / 1000).toFixed(1)} 秒で解除`);
  // **待っているのはホストで、ts5250 が応答しなくなっている訳ではない**（利用者の指摘）。
  // 砂時計を出すと事実と違う——待ちの最中でも Attn / SysReq は押せ、タブ切り替えも動く
  const hourglass = r.samples.filter((s) => s.busy && /wait|progress/.test(s.cursor));
  check(`${label} G 待ちの最中もマウスカーソルが砂時計にならない`,
    hourglass.length === 0,
    hourglass.length === 0
      ? `cursor=${JSON.stringify(r.samples.find((s) => s.busy)?.cursor)} のまま`
      : `${hourglass[0].ms}ms に cursor=${hourglass[0].cursor}`);
  check(`${label} D' 解除後は打てる状態に戻っている（施錠も解けている）`,
    r.clearedAt !== undefined && r.last.editable > 0 && r.last.lock === false,
    JSON.stringify({ 入力欄: r.last.editable, 施錠表示: r.last.lock, 通知: r.last.opmsg }));

  const screens = r.rx.filter((f) => f.type === "screen");
  const locked = screens.filter((f) => f.locked === true);
  const unlocked = screens.filter((f) => f.locked === false);
  const keyDone = r.rx.filter((f) => f.type === "key-done");
  log(`\n[${label}] 送信後に届いたフレーム ${r.rx.length} 件（screen ${screens.length}＝施錠 ${locked.length}／解錠 ${unlocked.length}、key-done ${keyDone.length}）`);
  for (const f of r.rx.slice(0, 40)) {
    log(`  ${String(f.ms).padStart(6)}ms  ${f.type}` +
      `${f.locked === undefined ? "" : ` locked=${f.locked}`}` +
      `${f.timedOut === undefined ? "" : ` timedOut=${f.timedOut}`}${f.detail ? " " + f.detail : ""}`);
  }
  if (r.rx.length > 40) log(`  …ほか ${r.rx.length - 40} 件`);
  return { screens, locked, unlocked, keyDone };
}

/**
 * MSGLOOP が待ち行列へ積んだ分を**自分で片付ける**（`MSGLOOP` で始まる本文だけ・鍵で指定）。
 * 60 通が実機の利用者メッセージに残ると邪魔になる。**他のメッセージには触らない。**
 */
async function cleanupMessages() {
  let auth;
  if (process.env.AS400_HOST && USER && PASSWORD) {
    auth = { host: process.env.AS400_HOST, user: USER, password: PASSWORD };
  } else {
    const cfg = JSON.parse(readFileSync("profiles.local.json", "utf8"));
    const sys = (cfg.systems ?? []).find((s) => s.name === SYSTEM);
    if (!sys?.signon?.passwordEnc || !crypto) return "資格情報が引けないので片付けを飛ばしました";
    auth = { host: sys.host, user: sys.signon.user, password: crypto.decrypt(sys.signon.passwordEnc) };
  }
  const db = await DbConnection.connect(auth);
  const cmd = await CommandConnection.connect(auth);
  try {
    const r = await queryLimited(
      db,
      `SELECT HEX(MESSAGE_KEY) AS K FROM QSYS2.MESSAGE_QUEUE_INFO
        WHERE MESSAGE_QUEUE_LIBRARY = 'QUSRSYS' AND MESSAGE_QUEUE_NAME = '${auth.user}'
          AND MESSAGE_TEXT LIKE 'MSGLOOP%'`,
      { limit: 1000 }
    );
    for (const row of r.rows) {
      // **`RMVMSG` は直に打てない**（`CPD0031`。CL プログラムの中でしか許されていない）。
      // `build-msgloop.mjs` が置いた 1 通ぶんの CL に**待ち行列名と鍵**を渡して消す
      // （待ち行列名を渡すのは、サーバージョブでは `RTVJOBA USER()` が `QUSER` を返すため）
      await cmd.run(`CALL PGM(${LIB}/MSGCLR) PARM('${auth.user}' X'${row.K}')`);
    }
    // **消えたかどうかは数え直して確かめる。** `MSGCLR` は `MONMSG` で失敗を握るので、
    // 呼び出しの成否を見ても「消えた」ことにはならない
    const left = await queryLimited(
      db,
      `SELECT COUNT(*) AS N FROM QSYS2.MESSAGE_QUEUE_INFO
        WHERE MESSAGE_QUEUE_LIBRARY = 'QUSRSYS' AND MESSAGE_QUEUE_NAME = '${auth.user}'
          AND MESSAGE_TEXT LIKE 'MSGLOOP%'`,
      { limit: 1 }
    );
    return `MSGLOOP のメッセージ ${r.rows.length} 件を片付けました（残り ${left.rows[0].N} 件）`;
  } finally {
    db.close();
    cmd.close();
  }
}

let ok = true;
try {
  // ---- 接続（システムを選ぶ → セッションを接続）----
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".launcher", { timeout: 20000 });
  // **名前は前方一致で拾わない。** `DEV1` は `DEV13270` / `DEV1VT` にも含まれるので、
  // カード見出しの**テキストノードだけ**（アイコンと種別チップを除いた本体）と突き合わせる
  const clickCard = (name, label) =>
    page.evaluate(
      ([nm, lb]) => {
        const body = (el) =>
          [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
        const hit = [...document.querySelectorAll(".card")].find(
          (c) => c.querySelector(".nm") && body(c.querySelector(".nm")) === nm
        );
        if (!hit) return `カードが見つかりません: ${nm}`;
        const btn = [...hit.querySelectorAll("button")].find((b) => new RegExp(lb).test(b.textContent ?? ""));
        if (!btn) return `ボタンが見つかりません: ${nm} / ${lb}`;
        btn.click();
        return "";
      },
      [name, label]
    );
  const e1 = await clickCard(SYSTEM, "選択|メニューへ");
  if (e1) throw new Error(e1);
  await page.waitForFunction(
    (nm) =>
      [...document.querySelectorAll(".card .nm")].some(
        (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("") === nm
      ),
    SESSION,
    { timeout: 10000 }
  );
  const e2 = await clickCard(SESSION, "接続|開く");
  if (e2) throw new Error(e2);
  await page.waitForFunction(() => (document.querySelector(".grid")?.textContent?.length ?? 0) > 100, {
    timeout: 30000
  });
  await sleep(1500);

  // サインオン直後はメニュー以外へ着地することがある（回復画面・サインオン情報・メッセージ）。
  // **押し方を画面で変える**——回復は「90」、サインオン欄があれば手打ち、あとは Enter
  for (let i = 0; i < 12; i++) {
    const s = await probe();
    if (/メインメニュー|Main Menu/.test(s.grid)) break;
    await page.locator(".grid").click({ position: { x: 5, y: 5 } });
    if (/対話式ジョブの回復/.test(s.grid)) {
      const el = page.locator("input.grid-input:not([readonly])").last();
      await el.click();
      await page.keyboard.press("Home");
      await page.keyboard.type("90", { delay: 30 });
      await page.keyboard.press("Enter");
    } else if (/パスワード|Password/.test(s.grid) && s.editable >= 2) {
      // **この実機は自動サインオンが効かない**（ホスト側の設定）。手で打つ。
      // 資格情報は環境変数から——スクリプトには書かない（AGENTS.md セキュリティ）。
      // **入力欄の有無で見分ける**——サインオン「情報」画面（`続行するには…`）には
      // 欄が 1 つも無く、文字列だけで判定すると打つ先の無い画面で待ち続ける
      if (!USER || !PASSWORD) throw new Error("サインオン画面。AS400_USER / AS400_PASSWORD を渡してください");
      const ins = page.locator("input.grid-input:not([readonly])");
      await ins.nth(0).click();
      await page.keyboard.press("Home");
      await page.keyboard.type(USER, { delay: 20 });
      await ins.nth(1).click();
      await page.keyboard.press("Home");
      await page.keyboard.type(PASSWORD, { delay: 20 });
      await page.keyboard.press("Enter");
    } else {
      // **迷ったら Enter。** F3 を撃つと「サインオン要求の終了」に当たってしまい、
      // サインオン画面へ押し戻される（実際に踏んだ）
      await page.keyboard.press("Enter");
    }
    await sleep(1800);
  }
  const menu = await probe();
  if (!/メインメニュー|Main Menu/.test(menu.grid)) {
    log("---- 到達できなかった画面 ----\n" + menu.grid.slice(0, 600));
    throw new Error("メインメニューに到達できませんでした");
  }
  check("実機のメインメニューに到達", true, `${SYSTEM} / ${SESSION}`);
  await shot("00-menu");

  // ---- 1. SNDMSG（待ち行列へ。画面には何も来ない）----
  const msg = await runAndWatch("MSGLOOP", "01-msgloop");
  const mStat = judge(msg, "MSGLOOP");
  check("MSGLOOP E `SNDMSG` は表示セッションに何も届けない（画面は 60 秒沈黙）",
    mStat.screens.length <= 1,
    `screen ${mStat.screens.length} 件（施錠 ${mStat.locked.length}／解錠 ${mStat.unlocked.length}）`);

  await sleep(2000);

  // ---- 2. 状況メッセージ（施錠されたままの画面が降ってくる）----
  const sts = await runAndWatch("STSLOOP", "02-stsloop");
  const sStat = judge(sts, "STSLOOP");
  check("STSLOOP E ホストは応答の途中で**施錠したまま**画面を書いてくる",
    sStat.locked.length > 0,
    `施錠された screen ${sStat.locked.length} 件`);
  check("STSLOOP E' その途中の画面で待ちを解いていない（#388 の規則）",
    sStat.locked.length === 0 ||
      sts.samples.filter((s) => s.ms < (sts.clearedAt ?? WATCH_MS) - 1000).every((s) => s.busy === true),
    "途中で busy が落ちた標本があれば NG");
  // **30 秒を越えてもホストの進捗が見えている。** 旧実装はここを自前の通知で覆っていた
  const prog35 = /STSLOOP\s*0\d\d/.test(sts.grid35 ?? "");
  check("STSLOOP F 30 秒を越えてもホストの進捗表示が画面に残る（通知で覆わない）",
    prog35,
    prog35 ? "最下行に STSLOOP nnn /060 が見えている" : `35 秒時点の最下行: ${JSON.stringify((sts.grid35 ?? "").slice(-90))}`);

  writeFileSync(`${TMP}/frames.json`, JSON.stringify(frames, null, 2));
  writeFileSync(`${TMP}/samples.json`, JSON.stringify({ msgloop: msg.samples, stsloop: sts.samples }, null, 2));
  log(`記録: ${TMP}/frames.json  ${TMP}/samples.json`);

  // ---- 後始末（装置を解放する。残すと次回が回復画面から始まる）----
  try {
    await typeCommand("SIGNOFF");
    await sleep(2500);
  } catch (e) {
    log("SIGNOFF できなかった: " + (e instanceof Error ? e.message : String(e)));
  }
} catch (err) {
  ok = false;
  log("ERROR: " + (err instanceof Error ? err.stack : String(err)));
  await shot("99-error").catch(() => undefined);
} finally {
  await browser.close().catch(() => undefined);
  server.close?.();
  // **自分が積んだメッセージは自分で片付ける**（他人のメッセージには触らない）
  await cleanupMessages()
    .then((m) => log(m))
    .catch((e) => log("片付けに失敗: " + (e instanceof Error ? e.message : String(e))));
}

const ng = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - ng.length}/${results.length} OK\n`);
process.exit(ok && ng.length === 0 ? 0 : 1);
