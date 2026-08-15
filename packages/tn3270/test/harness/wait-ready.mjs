/**
 * TK4- が **E2E テストが要求する水準まで**立ち上がるのを待つ。
 *
 * **判定は「往復が成立すること」**——接続して画面を受け取り、Enter を送って
 * ホストが応答を返すところまで。E2E テストが求めるのがまさにこれなので、
 * ここを合格条件にすれば「起動したのにテストが落ちる」が起きない。
 *
 * **これより弱い判定はどれも早すぎた**（すべて実測で確認）:
 * - TCP の接続確立 …… IPL 中でも Hercules は telnet 交渉を始めてしまう
 * - HTTP コンソール(8038)の応答 …… 3 秒で立つが MVS はまだ IPL 中
 * - syslog の `ipl.rc processing ended` …… 15 秒で出るがまだ画面を出さない
 * - 画面が 1 枚届くこと …… 届くが、その時点ではまだ Enter に応答しない
 *
 * 使い方: node wait-ready.mjs [host] [port] [timeoutSec]
 */
import { Tn3270Session } from "../../dist/session/session.js";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 3270);
const timeoutSec = Number(process.argv[4] ?? 180);
const deadline = Date.now() + timeoutSec * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(get, want, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await sleep(50);
  }
  return false;
}

/** 1 回試す。往復が成立すれば true */
async function attempt() {
  const s = new Tn3270Session({ host, port, model: 2, connectTimeoutMs: 5000 });
  let screens = 0;
  s.on("screen", () => screens++);
  try {
    await s.connect();
    if (!(await waitFor(() => screens, 1, 6000))) return false;
    const before = screens;
    s.send("enter");
    return await waitFor(() => screens, before + 1, 6000);
  } catch {
    return false;
  } finally {
    try {
      s.close();
    } catch {
      /* 既に閉じていれば無視 */
    }
  }
}

while (Date.now() < deadline) {
  if (await attempt()) {
    process.stdout.write(" 完了\n");
    process.exit(0);
  }
  process.stdout.write(".");
  await sleep(2000);
}
process.stdout.write("\n");
process.stderr.write(`TK4- が ${timeoutSec} 秒以内に往復可能になりませんでした\n`);
process.exit(1);
