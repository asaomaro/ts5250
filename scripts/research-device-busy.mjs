// **装置名が使用中のときにホストが何を送ってくるか**を実機で捕まえる
// （`20260802-device-busy-record`）。
//
// 症状: 2 本目を同じ装置名で開くと操作ログに
//   `expected ESC, got 0xc0 — discarding rest of record`
// が出る。**こちらの解析器が壊れているように読める**が、本当の理由（装置が使用中）は
// どこにも出ない。何が届いているのかを生バイトで見る。
//
// 実行: AS400_HOST=... AS400_USER=... AS400_PASSWORD=... node --env-file=.env \
//         scripts/research-device-busy.mjs
//
// 副作用: **自分の設定にある装置名**（既定 DEV1）で 2 本開くだけ。装置は作らない・消さない。
// 掴んだ接続は finally で必ず閉じる。
import { Session5250 } from "@as400web/tn5250";
// `startup-record` は公開 API に出していないので dist から直接読む（調査用）
import { parseStartupResponse, startupCodeMeaning } from "../packages/tn5250/dist/telnet/startup-record.js";
import { codecForCcsid } from "@as400web/ebcdic";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) {
  process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で渡してください\n");
  process.exit(2);
}

/**
 * **装置名はホストに採らせる。**
 *
 * 決め打ちの名前を使うと (a) 他人が掴んでいれば交渉前に切られて症状が出ない
 * （実際 `DEV1` は使用中だった）、(b) 未使用の名前だとホストが**装置を自動作成**しうる。
 * 共用の本番機なので、どちらも避ける。
 *
 * 1 本目は名前を指定せずに開き、**ホストが割り当てた名前**を起動応答から読む。
 * 2 本目はその名前をぶつける——ホストが自分で作った装置なので、余計なものは増えない。
 */
const log = (s) => process.stdout.write(s + "\n");
// **落ちても観測を続ける**（送信後クローズの throw がソケットのコールバックから飛ぶ）
process.on("uncaughtException", (e) => log(`  [uncaught] ${e?.code ?? ""} ${e?.message}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/** 1 本開く。届いた警告と生レコードを全部ためる */
async function open(label, deviceName, warnings = []) {
  const session = await Session5250.connect({
    host,
    user,
    password,
    ...(deviceName ? { deviceName } : {}),
    // **設定と同じ条件で繋ぐ**。CCSID と画面サイズは端末型の申告に効くので、
    // 既定のまま繋ぐと交渉の段階で断られる（既定 37 / 24x80 では切られた）
    ccsid: Number(process.env.AS400_CCSID ?? 5026),
    screenSize: "27x132",
    traceRecords: true,
    warn: (m) => warnings.push(m)
  });
  return { label, session, warnings };
}

let first;
let second;
try {
  const DEV = process.env.AS400_DEVNAME ?? "DEV1";
  log(`1 本目を開く（装置名 ${DEV}）`);
  first = await open("1 本目", DEV);
  await sleep(1500);
  log(`  1 本目: state=${first.session.state}`);
  const startup1 = first.warnings.find((w) => w.startsWith("startup response"));
  log(`  ${startup1 ?? "(起動応答の警告なし)"}`);
  const dev = /device=(\S+)\)/.exec(startup1 ?? "")?.[1] ?? DEV;

  log(`\n### 同じ装置名 ${dev} で 2 本目を開く`);
  let err;
  // **投げても警告を読めるように、器は外で持つ**（open が throw すると戻り値が無い）
  const w2 = [];
  const t0 = Date.now();
  try {
    second = await open("2 本目", dev, w2);
    await sleep(2000);
  } catch (e) {
    err = e;
  }
  if (!second) second = { warnings: w2 };
  log(`  所要 ${Date.now() - t0} ms`);
  log(`  結果: ${err ? `${err.code ?? ""} ${err.message}` : `例外なし（state=${second.session?.state}）`}`);

  log(`\n### 2 本目に届いた警告（そのまま）`);
  for (const w of second.warnings) log(`  ${w}`);

  // **生レコードを起動応答として読み直す**——ここが本題
  log(`\n### 生レコードを起動応答として解析してみる`);
  const codec = codecForCcsid(37);
  for (const w of second.warnings) {
    const m = /^rx record \((\d+) bytes\): (.+)$/.exec(w);
    if (!m) continue;
    const bytes = Uint8Array.from(m[2].split(" ").map((h) => parseInt(h, 16)));
    log(`  レコード ${m[1]} バイト`);
    log(`    ${hex(bytes)}`);
    const at = 6 + (bytes[6] ?? 4);
    log(`    読み位置 at=${at}（6 + data[6]=${bytes[6]}）/ code は at+5..at+9`);
    const parsed = parseStartupResponse(bytes, codec);
    if (parsed) {
      log(`    → code=${parsed.code}（${startupCodeMeaning(parsed.code)}）`);
      log(`       system=${JSON.stringify(parsed.system)} device=${JSON.stringify(parsed.device)}`);
      log(`    ⚠ **device が空なら、表示セッションはこれを起動応答として食べない**`);
    } else {
      log(`    → 起動応答として解析できない`);
    }
    // 5250 の適用層が最初に読むバイト（ここが 0xc0 なら症状と一致）
    const dataAt = 6 + (bytes[6] ?? 4);
    log(`    適用層が最初に読むバイト: 0x${(bytes[dataAt] ?? 0).toString(16)}`);
  }
} catch (e) {
  log(`例外: ${e?.stack ?? e}`);
} finally {
  try { second?.session?.disconnect(); } catch { /* 良い */ }
  try { first?.session?.disconnect(); } catch { /* 良い */ }
  await sleep(300);
}
process.exit(0);
