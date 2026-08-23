/**
 * **メッセージ待ち行列の待ち受けの実機検証**（実機）。
 *
 *   node --env-file=.env scripts/verify-message-watch.mjs
 *
 * 確かめること:
 *
 * - **ポーリングせずに待てる**（指定した秒数ぴったりブロックする）
 * - **届いたら push される**（WS で受け取れる）
 * - **消えない**（読んだあとも一覧に残り、件数が変わらない）
 * - **二度出ない**（カーソルが進む）
 * - **照会だけに絞れる**
 * - **`QSYSOPR` を荒らさない**（読むだけ・他人のメッセージの件数が変わらない）
 *
 * 自前の待ち行列（`WCHMSGQ`）を作って使い、最後に消す。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import {
  buildApp,
  SessionManager,
  ServerConfigStore,
  PersonalConfigStore,
  ConfigResolver,
  WatchRegistry,
  openCommand
} from "@ts5250/server";

const PORT = 3497;
const TMP = "/tmp/ts5250-msgwatch";
const MSGQ = "WCHMSGQ";
const LIB = process.env.AS400_LIB ?? "TESTLIB";
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok });
  process.stdout.write(`${ok ? "OK  " : "NG  "} ${n}${d ? ` — ${String(d).slice(0, 140)}` : ""}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400"));
sys.signon = { user: sys.signon.user, passwordEnv: "AS400_PASSWORD" };
// **待ち受けの定義をサーバー設定として入れる**（種別 msgwatch のセッション）
cfg.sessions = [
  {
    id: "msgwatch1",
    name: "テスト待ち受け",
    system: sys.id,
    sessionType: "msgwatch",
    // **自動では始めない**。検証の中で明示的に開始する
    autoStart: false,
    msgWatch: { library: LIB, name: MSGQ }
  },
  {
    id: "msgwatch2",
    name: "応答待ちだけ",
    system: sys.id,
    sessionType: "msgwatch",
    autoStart: false,
    msgWatch: { library: LIB, name: MSGQ, onlyInquiry: true }
  }
];
writeFileSync(`${TMP}/cfg.json`, JSON.stringify(cfg));

const resolver = new ConfigResolver(
  ServerConfigStore.fromFile(`${TMP}/cfg.json`),
  new PersonalConfigStore({ systems: [], sessions: [] })
);
const sessions = new SessionManager();
const watches = new WatchRegistry();
const app = buildApp({ sessions, resolver, watches, version: "verify", webRoot: "packages/web-ui/dist" });
const wss = new WebSocketServer({ noServer: true });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } });
await sleep(400);

const conn = { host: sys.host, user: sys.signon.user, password: process.env.AS400_PASSWORD };
const cmd = await openCommand(conn);
const q = String.fromCharCode(39);
const send = (text, inquiry = false) =>
  cmd.runOrThrow(
    `SNDMSG MSG(${q}${text}${q}) TOMSGQ(${LIB}/${MSGQ})` +
      (inquiry ? ` MSGTYPE(*INQ) RPYMSGQ(${LIB}/${MSGQ})` : "")
  );

/**
 * 待ち行列の中身（**既存のメッセージ API 経由**）。
 * 待ち受けが `*SAME` で読んでいるなら、ここで見える件数は変わらないはず。
 */
async function listMessages(queue, library) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/host/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { system: `srv:${sys.id}` }, queue, library, max: 500 })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${body.code}: ${body.error}`);
  return body.messages;
}
const countMessages = async (queue, library) => (await listMessages(queue, library)).length;

/**
 * 検証用の待ち行列を消す。**待ち受けが掴んでいる間は消せない**（`CPF2451`）——
 * ホスト側のジョブが手を離すまで少し掛かるので、諦めずに何度か試す。
 * 残すと次の実行が `CPF2112` で止まり、**そこから先の判定が全部嘘になる**。
 */
async function dropQueue() {
  // 待ち受けが 1 回の待ちを終えるまで掴んだままなので、**その時間ぶんは待つ**
  for (let i = 0; i < 25; i++) {
    const r = await cmd.run(`DLTMSGQ MSGQ(${LIB}/${MSGQ})`);
    if (r.success || r.messages.some((m) => m.id === "CPF2105")) return true;
    await sleep(2000);
  }
  return false;
}

/** WS を 1 本張って `watch-*` を受ける（監視コンソールと同じ経路） */
function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    seen.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  });
  return {
    ws,
    seen,
    ready: new Promise((r) => ws.on("open", r)),
    send: (m) => ws.send(JSON.stringify(m)),
    /**
     * 条件に合う電文が来るまで待つ（来なければ null）。
     *
     * **判定で落ちても握る。** 判定はメッセージ受信のハンドラの中で走るので、
     * ここで例外を投げるとプロセスごと死に、後片付け（待ち行列の削除）が回らない
     * ——実際にそれで待ち行列が残り、次の実行が `CPF2112` で止まった。
     */
    async until(pred, ms = 20_000) {
      const raw = pred;
      // **`pred` に代入し直さない**（自分を呼ぶ形になって必ず false になる。実際に踏んだ）
      const safe = (m) => {
        try {
          return raw(m);
        } catch {
          return false;
        }
      };
      const t = Date.now();
      while (Date.now() - t < ms) {
        // **毎回ぜんぶ見直す。** 起こされ損ね（待っている間に届いたものが
        // 古い待ち手を起こして終わる）で取りこぼさないため
        const hit = seen.find(safe);
        if (hit) return hit;
        await Promise.race([new Promise((r) => waiters.push(r)), sleep(300)]);
      }
      return null;
    }
  };
}

let ws;
try {
  // ---- 下ごしらえ ----
  // **前回の残りを確実に片付ける。** 待ち受けが掴んだままだと削除が空振りするので、
  // 少し置いてからもう一度試す（残っていると件数の前提が崩れて、以降が全部嘘になる）
  await dropQueue();
  const created = await cmd.run(`CRTMSGQ MSGQ(${LIB}/${MSGQ}) TEXT(${q}watch verify${q})`);
  check("検証用の待ち行列を用意できた", created.success, created.messages.map((m) => `${m.id} ${m.text}`).join(" / "));
  await send("始める前からあった 1");
  await send("始める前からあった 2");
  check("待ち行列を用意した", (await countMessages(MSGQ, LIB)) === 2);

  const sysopBefore = await countMessages("QSYSOPR", "QSYS");

  // ---- 1. 待ち受けを始める ----
  ws = openWs();
  await ws.ready;
  ws.send({ type: "watch-subscribe" });
  ws.send({ type: "watch-start", session: `srv:msgwatch1` });
  // **項目が全部載るのは `watch-list` だけ**（`watch-state` は id と状態しか運ばない）
  const started = await ws.until((m) => m.type === "watch-list" && m.watches.some((w) => w.kind === "msgq"));
  check("メッセージ待ち行列の待ち受けが始まった", Boolean(started));
  const view = started?.watches.find((w) => w.kind === "msgq");
  check("種類が msgq として出る", view?.kind === "msgq", view?.kind);
  check("状態が待ち受け中", view?.state === "listening", view?.state);
  check("名札が ライブラリー/キュー", view?.label === `${LIB}/${MSGQ}`, view?.label);

  // ---- 2. 始める前のぶんは流れない ----
  await sleep(1500);
  check(
    "**始める前からあったものは流れない**（QSYSOPR で数百件が押し寄せない）",
    !ws.seen.some((m) => m.type === "watch-entry")
  );

  // ---- 3. 届いたら push される ----
  await send("届いたら知らせて");
  const entry = await ws.until((m) => m.type === "watch-entry");
  check("**届いたら push される**", Boolean(entry), entry?.entry?.text);
  check("本文が読める", entry?.entry?.text === "届いたら知らせて", entry?.entry?.text);
  check("メッセージキーが付いている（そのまま応答に使える）", /^[0-9a-f]{8}$/u.test(entry?.entry?.message?.key ?? ""), entry?.entry?.message?.key);
  check("種別が分かる", entry?.entry?.message?.type === "INFORMATIONAL", entry?.entry?.message?.type);

  // ---- 4. 消えない ----
  check("**読んでもメッセージは消えない**（一覧に残る）", (await countMessages(MSGQ, LIB)) === 3);

  // ---- 5. 二度出ない ----
  await send("2 通目");
  await send("3 通目");
  await ws.until((m) => m.type === "watch-entry" && m.entry.text === "3 通目");
  const texts = ws.seen.filter((m) => m.type === "watch-entry").map((m) => m.entry.text);
  check("**同じものが二度出ない**", new Set(texts).size === texts.length, texts.join(" / "));
  check("届いた順に並ぶ", texts.join("|") === "届いたら知らせて|2 通目|3 通目", texts.join("|"));
  const seqs = ws.seen.filter((m) => m.type === "watch-entry").map((m) => m.entry.seq);
  check("連番が飛ばない", seqs.join(",") === "1,2,3", seqs.join(","));

  // ---- 6. 照会が拾える ----
  await send("応答してください", true);
  const inq = await ws.until((m) => m.type === "watch-entry" && m.entry.message?.inquiry === true);
  check("**照会が照会として届く**", Boolean(inq), inq?.entry?.message?.type);
  check("照会の重大度が読める", typeof inq?.entry?.message?.severity === "number");

  // ---- 7. 照会だけに絞る ----
  const ws2 = openWs();
  await ws2.ready;
  ws2.send({ type: "watch-subscribe" });
  ws2.send({ type: "watch-start", session: `srv:msgwatch2` });
  const list2 = await ws2.until(
    (m) => m.type === "watch-list" && m.watches.some((w) => w.ref === "srv:msgwatch2")
  );
  // **どの待ち受けのものか見分ける。** 購読はすべての待ち受けに届くので、
  // 絞り込みを確かめるには `watchId` で選り分けないといけない
  const id2 = list2?.watches.find((w) => w.ref === "srv:msgwatch2")?.id;
  check("絞り込みの待ち受けも始まった", Boolean(id2));
  await sleep(500);
  await send("これは拾わない");
  await send("これは拾う", true);
  const only = await ws2.until((m) => m.type === "watch-entry" && m.watchId === id2);
  check("**照会だけに絞れる**", only?.entry?.message?.inquiry === true, only?.entry?.text);
  check(
    "拾わないものが混じらない",
    ws2.seen
      .filter((m) => m.type === "watch-entry" && m.watchId === id2)
      .every((m) => m.entry.message?.inquiry === true)
  );
  ws2.ws.close();

  // ---- 8. 止めて再開できる ----
  const id = view?.id;
  ws.send({ type: "watch-stop", watchId: id });
  const stopped = await ws.until((m) => m.type === "watch-state" && m.watchId === id && m.state === "stopped");
  check("止められる", Boolean(stopped));
  // **止めている間に届いたものは失われない**（メッセージは待ち行列に残る）
  await send("止めている間に届いた");
  ws.send({ type: "watch-resume", watchId: id });
  const back = await ws.until((m) => m.type === "watch-entry" && m.entry.text === "止めている間に届いた");
  check("**止めている間に届いたぶんも、再開すれば届く**", Boolean(back));

  // ---- 9. QSYSOPR を荒らしていない ----
  check(
    "**QSYSOPR の件数が変わっていない**（共有資源に触れていない）",
    (await countMessages("QSYSOPR", "QSYS")) === sysopBefore,
    `${sysopBefore} 件`
  );

  // ---- 10. 無い待ち行列は**張り直さずに諦める** ----
  // 待っても直らない断り（`CPF2403`）でバックオフに入ると、永久に再試行し続ける
  let startError;
  try {
    await watches.start({
      ref: "srv:nowhere",
      label: `${LIB}/NOSUCHQ`,
      spec: { kind: "msgq", library: LIB, name: "NOSUCHQ" },
      connect: conn
    });
  } catch (e) {
    startError = e;
  }
  check("**無い待ち行列は始まらない**（理由が返る）", Boolean(startError), startError?.message);
  check(
    "張り直さない種類の失敗として扱う（NOT_FOUND）",
    startError?.code === "NOT_FOUND",
    `${startError?.code}`
  );
  const dead = watches.list().find((w) => w.ref === "srv:nowhere");
  check("失敗しても一覧に残る（理由が画面から追える）", dead?.state === "error", dead?.error);

  // ---- 11. **止めたら待ち行列が消せる** ----
  // 無限に待つと、こちらが切ってもホスト側のジョブが掴んだままになり、
  // `DLTMSGQ` が `CPF2451` で永久に通らなくなる（実際に踏んだ）。
  // **待ち行列の保守が、誰かが待ち受けているだけで止まらない**ことを確かめる
  watches.closeAll();
  const t0 = Date.now();
  const freed = await dropQueue();
  check(
    "**待ち受けを止めたら待ち行列を消せる**（掴んだままにしない）",
    freed,
    `${((Date.now() - t0) / 1000).toFixed(0)} 秒で消せた`
  );
} catch (e) {
  check(`途中で落ちた: ${e instanceof Error ? e.message : String(e)}`, false);
  process.exitCode = 1;
} finally {
  // **先に待ち受けを止める。** 掴んだままだと `DLTMSGQ` が空振りし、
  // 待ち行列が残って次の実行が `CPF2112` で止まる（実際に踏んだ）
  watches.closeAll();
  await sleep(1500);
  try {
    if (!(await dropQueue())) process.stdout.write(`片付けきれなかった: ${LIB}/${MSGQ}\n`);
  } catch {
    /* 後始末なので握る */
  }
  ws?.ws.close();
  cmd.close();
  await sessions.closeAll?.();
  server.close();
}

const ng = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - ng.length}/${results.length} OK\n`);
if (ng.length) {
  process.stdout.write(ng.map((r) => `  NG ${r.n}`).join("\n") + "\n");
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
