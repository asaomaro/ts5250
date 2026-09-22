// **DBCS の 4 種の欄（DDS の G・J・E・O）を持つ画面を、当 PJ が受けたときの生バイトと動きを見る**（`20260921-g-field-sosi`）。
//
//   `scripts/build-gtest.mjs` が作る `GTST`（画面 GREC）を呼び、**ホストが送ってきた WTD の生バイト**と、当 PJ の画面・欄の見え方、
//   実行キーを返したときの**こちらの送信の生バイト**、ホスト側のログ（受け取った入力）を並べる。**G 欄が SO/SI 無しの生の DBCS で届くか・当 PJ が全角に読めるか・送信が SO/SI 付きになるか**を見る。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-gfield.mjs [BLANK] [TYPE]
//   BLANK: 全欄を空で出す。TYPE: FG（G）に「かきく」を打ってから返す。TYPEJ: FJ（J）に「かきく」を打ってから返す
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }
const LIB = (process.env.AS400_LIB ?? "TESTLIB").trim().split(/\s+/)[0];
const PGM = "GTST";
const LOGF = "/tmp/gtst.log";

const out = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

const inbound = [];
const outbound = [];
const session = await Session5250.connect({
  host, port: 23, ccsid: 930, screenSize: "24x80",
  warn: (m) => { out(`  [warn] ${m}`); },
  traceRecords: true
});
const telnet = session.telnet;
const innerRecord = telnet.recordFn;
telnet.onRecord?.((rec) => { inbound.push(rec); innerRecord?.(rec); });
const innerSend = telnet.sendRecord.bind(telnet);
telnet.sendRecord = (rec) => { outbound.push(rec); return innerSend(rec); };

const text = () => session.snapshot().cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");
const inputs = () => session.snapshot().fields.filter((f) => !f.protected);

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

const ifs = await IfsConnection.connect({ host, user, password });
const readLog = async () => {
  try {
    const t = await ifs.readTextFile(LOGF);
    const bytes = t?.data ?? t;
    return typeof bytes === "string"
      ? bytes
      : codecForCcsid(t?.ccsid ?? 37).decode(Uint8Array.from(Object.values(bytes)));
  } catch (e) { return `（読めず: ${String(e.message).slice(0, 80)}）`; }
};

const cmdField = inputs().find((f) => f.length > 20);
if (!cmdField) { out("コマンド欄が無い（画面が戻っていない）"); process.exit(1); }
inbound.length = 0;
outbound.length = 0;
const ARG = process.argv.includes("BLANK") ? " PARM('BLANK')" : "";
session.setField({ index: cmdField.index }, `CALL ${LIB}/${PGM}${ARG}`);
out("===== GREC を受ける =====");
const r = await session.sendAid("Enter", { timeoutMs: 20000 });
await sleep(2500);
if (r.timedOut) out("  ⚠ 応答待ちで時間切れ");
for (const rec of inbound) {
  const b = rec instanceof Uint8Array ? rec : new Uint8Array(rec);
  out(`  受信 ${String(b.length).padStart(4)}B`);
  out("    " + hex(b.subarray(0, b.length)));
}
out("  --- 画面（当 PJ の見え方）---");
const snap = session.snapshot();
snap.cells.forEach((row, i) => { const t = row.map((c) => c.char).join("").replace(/ +$/u, ""); if (t.trim()) out(`  ${String(i + 1).padStart(2)}| ${t}`); });
out("  --- 欄（当 PJ の見え方）---");
for (const f of snap.fields) out(`  #${f.index} (${f.row},${f.col}) len=${f.length} prot=${f.protected} dbcs=${f.dbcsType ?? "-"} value=${JSON.stringify(f.value)}`);
// FG（最初の入力欄）に打ってから Enter（送信の形を見る）
const fg = snap.fields.find((f) => !f.protected);
if (fg && process.argv.includes("TYPE")) session.setField({ index: fg.index }, "かきく");
// TYPEJ: J（2 つ目の入力欄）に打つ。ACS は SO かきく 全角空白 2 SI（欄長いっぱい・SI が最終バイト）で返す
const fj = snap.fields.filter((f) => !f.protected)[1];
if (fj && process.argv.includes("TYPEJ")) session.setField({ index: fj.index }, "かきく");
outbound.length = 0;
inbound.length = 0;
out("===== 実行キーで返す =====");
await session.sendAid("Enter", { timeoutMs: 10000 }).catch(() => undefined);
await sleep(1500);
for (const rec of outbound) {
  const b = rec instanceof Uint8Array ? rec : new Uint8Array(rec);
  out(`  送信 ${String(b.length).padStart(4)}B  ${hex(b)}`);
}
out("  --- ホスト側 ---");
out((await readLog()).split("\n").filter((l) => l.trim()).map((l) => "  " + l).join("\n"));
ifs.close?.();
session.disconnect();
process.exit(0);
