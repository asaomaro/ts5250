// **READ IMMEDIATE(0x72) を実機で受けて、当方の応答が通るかを見る。**
//
// `scripts/build-rdimm.mjs` が作った `TESTLIB/RDIMM` を 5250 セッションから呼ぶ。
// あちらは IBM の動的画面管理 API `QsnReadImm`（`QSYSINC/H(QSNAPI)` に
// `#define QSN_READ_IMM 0x72`）を呼ぶので、**ホストが 0x72 を送ってくる**。
//
// 見ること:
//   1. レコードの先頭に `ESC 0x72` が来るか
//   2. 当方が応答を書き出すか（AID は 0）
//   3. **ホストが受け付けるか**（プログラムの戻り値をデータ域から読む）
//
// 実行: node --env-file=.env scripts/diag-read-immediate.mjs
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }
const LIB = process.env.RDIMM_LIB ?? "TESTLIB";
const PGM = process.env.RDIMM_PGM ?? "RDIMM";
const LOGF = process.env.RDIMM_LOG ?? `/tmp/${PGM.toLowerCase()}.log`;

const out = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

const inbound = [];
const outbound = [];
const session = await Session5250.connect({
  host, port: 23, ccsid: 5035, screenSize: "24x80",
  warn: (m) => { if (/READ IMMEDIATE/i.test(m)) out(`  [warn] ${m}`); },
  traceRecords: true
});
// **送受信の生バイトを覗く**（応答が本当に出ているかを見るため）
const telnet = session.telnet;
const innerRecord = telnet.recordFn;
telnet.onRecord?.((rec) => { inbound.push(rec); innerRecord?.(rec); });
const innerSend = telnet.sendRecord.bind(telnet);
telnet.sendRecord = (rec) => { outbound.push(rec); return innerSend(rec); };

const text = () => session.snapshot().cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");
const inputs = () => session.snapshot().fields.filter((f) => !f.protected);

// --- サインオン → コマンド行 ---
for (let i = 0; i < 8; i++) {
  const t = text();
  if (t.includes("コマンドを入力") || t.includes("選択項目またはコマンド")) break;
  const f = inputs();
  if (t.includes("サイン・オン")) {
    if (f[0]) session.setField({ index: f[0].index }, user);
    if (f[1]) session.setField({ index: f[1].index }, password);
  } else if (t.includes("回復") && f[0]) {
    session.setField({ index: f[0].index }, "90");
  }
  await session.sendAid("Enter", { timeoutMs: 15000 });
  await sleep(900);
}

out("# プログラムを呼ぶ");
const cmdField = inputs().find((f) => f.length > 20);
if (!cmdField) { out("  コマンド欄が見つからない"); session.disconnect(); process.exit(1); }
inbound.length = 0;
outbound.length = 0;
session.setField({ index: cmdField.index }, `CALL ${LIB}/${PGM}`);
await session.sendAid("Enter", { timeoutMs: 25000 });
await sleep(2500);

out(`\n# CALL 後の画面`);
out(text().split("\n").map((l, i) => `  ${String(i + 1).padStart(2)}|${l}`).filter((l) => l.trim().length > 4).join("\n"));

out(`\n# 受信レコード ${inbound.length} 本`);
let saw72 = false;
for (const rec of inbound) {
  const b = rec instanceof Uint8Array ? rec : new Uint8Array(rec);
  // データは GDS ヘッダ 10 バイトの後ろ。先頭が ESC(0x04) + コマンド
  const cmd = b[11];
  const name = cmd === 0x72 ? " **READ IMMEDIATE(0x72)**" : "";
  out(`  ${b.length}B  先頭: ${hex(b.subarray(10, Math.min(16, b.length)))}${name}`);
  if (cmd === 0x72) saw72 = true;
}
out(`\n# 送信レコード ${outbound.length} 本`);
for (const rec of outbound) {
  const b = rec instanceof Uint8Array ? rec : new Uint8Array(rec);
  out(`  ${b.length}B  opcode=0x${(b[9] ?? 0).toString(16)}  データ: ${hex(b.subarray(10, Math.min(20, b.length)))}`);
}

out(`\n# 判定`);
out(`  ${saw72 ? "PASS" : "FAIL"}  ホストが 0x72 を送ってきた`);
session.disconnect();
await sleep(800);

// --- プログラムがどこまで進んだか（IFS のログ） ---
out(`\n# プログラムのログ（${LOGF}）`);
const ifs = await IfsConnection.connect({ host, user, password });
try {
  // `readTextFile` は `{ data: Uint8Array, ccsid }` を返す（**EBCDIC のまま**）
  const t = await ifs.readTextFile(LOGF);
  const bytes = t?.data ?? t;
  const body =
    typeof bytes === "string"
      ? bytes
      : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
  out(String(body).split("\n").map((l) => "  " + l).join("\n"));
} catch (e) {
  out(`  読めず: ${String(e.message).slice(0, 120)}`);
}
ifs.close?.();
