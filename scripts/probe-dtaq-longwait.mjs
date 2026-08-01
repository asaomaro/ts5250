// 実機で **DTAQ の無限待ち接続が長時間アイドルを越えられるか**を実測する。
//
// 問い（`.aidev/works/20260723-dtaq-watch-notify/research.md` の R3・残った未確定）:
//   `wait=-1` は実機で成立済みだが、確かめたのは **7.6 秒**まで。
//   `host-connection.ts` は `socket.setKeepAlive()` を**呼んでいない**うえ、
//   `wait < 0` では read タイムアウトを無効化している。つまり
//   **相手が黙って消えても永久に待ち続ける**。分〜時間のアイドルで
//   ホスト側／経路（NAT・ファイアウォール）が接続を回収するかは誰も測っていない。
//
// ここで確かめること: **N 分（既定 45）放置したあとに送ったエントリを受け取れるか。**
//   受け取れる → 常駐監視は張りっぱなしで成立する（心拍・張り直しは要らない）
//   受け取れない → 監視には keepalive か定期的な張り直しが要る（spec に反映する）
//
// 実行: AS400_PASSWORD=... node scripts/probe-dtaq-longwait.mjs [--minutes 45] [--keepalive]
import { readFileSync } from "node:fs";
import { DtaqConnection } from "@as400web/tn5250";

const out = (s) => process.stdout.write(s + "\n");
const conns = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = conns.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD;
if (!password) { out("AS400_PASSWORD が未設定です"); process.exit(1); }

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const MINUTES = Number(argOf("--minutes", "45"));
const LIB = argOf("--library", "TESTLIB");
const Q = "DTQLONG";
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

const connect = () =>
  DtaqConnection.connect({
    host: sys.host,
    user: sys.signon.user,
    password,
    ...(sys.tls !== undefined ? { tls: sys.tls } : {})
  });

const started = process.hrtime.bigint();
const elapsedMs = () => Number((process.hrtime.bigint() - started) / 1_000_000n);
const mmss = (ms) => `${Math.floor(ms / 60000)}分${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}秒`;

let waitConn;
let ok = false;
try {
  const setup = await connect();
  await setup.deleteQueue(Q, LIB).catch(() => undefined);
  await setup.create({ name: Q, library: LIB, maxEntryLength: 100, type: "FIFO" });
  setup.close();
  out(`${LIB}/${Q} を作成`);

  waitConn = await connect();
  out(`wait=-1 で受信を張る。**${MINUTES} 分後**に別接続から送る`);

  // 別接続からの送信を予約。**待機中の接続では他の要求を出せない**ので必ず別接続
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const c2 = await connect();
        await c2.write(Q, LIB, enc(`after-${MINUTES}min`));
        c2.close();
        out(`  ${mmss(elapsedMs())} 経過: 別接続から送信した`);
      } catch (e) {
        out(`  送信に失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, MINUTES * 60_000);
  timer.unref?.();

  // 進捗を 5 分ごとに出す（生きているかを外から見るため）
  const tick = setInterval(() => out(`  … ${mmss(elapsedMs())} 待機中`), 5 * 60_000);
  tick.unref?.();

  const e = await waitConn.read({ name: Q, library: LIB, wait: -1 });
  clearInterval(tick);
  out(`\n受信: ${e ? JSON.stringify(dec(e.data)) : "(空)"} / ${mmss(elapsedMs())} 待った`);
  ok = Boolean(e);
  out(ok ? "【結論】長時間アイドルを越えて受信できた" : "【結論】空で戻った（想定外）");
} catch (e) {
  out(`\n【結論】${mmss(elapsedMs())} で失敗した: ${e instanceof Error ? e.message : String(e)}`);
  out("→ 常駐監視には keepalive か定期的な張り直しが要る");
} finally {
  try {
    waitConn?.close();
    const cleanup = await connect();
    await cleanup.deleteQueue(Q, LIB).catch(() => undefined);
    cleanup.close();
  } catch {
    /* 後片付けの失敗は結論に影響しない */
  }
}
process.exit(ok ? 0 : 1);
