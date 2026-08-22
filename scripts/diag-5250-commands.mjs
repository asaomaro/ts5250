// **実機に 5250 の任意コマンドを発行させて、当方の実装を突き合わせる。**
//
// `.aidev/backlog/datastream-commands.md` の未実装項目は「実機で届かないので確かめられない」で
// 止まっていた。だが **IBM 自身が発行する API を出荷している**（動的画面管理＝DSM）。
// `scripts/build-dscmd.mjs` が作る `TESTLIB/DSCMD` を呼ぶと、指定したコマンドが飛んでくる。
//
//   ROLLUP / ROLLDOWN  → ROLL(0x23)      … 方向ビットと引数の並びを実測する
//   READIMM            → READ IMMEDIATE(0x72)
//   READIMMALT         → READ MDT IMMEDIATE ALT(0x83)  ⚠ 当方は応答しない。**待たされるか**を見る
//
// 実行: node --env-file=.env scripts/diag-5250-commands.mjs [要求...]
//       既定は ROLLUP ROLLDOWN READIMM
import { Session5250 } from "@ts5250/tn5250";
import { IfsConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }
const LIB = process.env.DSCMD_LIB ?? "TESTLIB";
const PGM = process.env.DSCMD_PGM ?? "DSCMD";
const LOGF = process.env.DSCMD_LOG ?? `/tmp/${PGM.toLowerCase()}.log`;
const REQUESTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["ROLLUP", "ROLLDOWN", "READIMM"];

const out = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

const inbound = [];
const outbound = [];
const session = await Session5250.connect({
  host, port: 23, ccsid: 5035, screenSize: "24x80",
  warn: (m) => { if (/ROLL|IMMEDIATE|unknown command/i.test(m)) out(`  [warn] ${m}`); },
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

for (const req of REQUESTS) {
  const cmdField = inputs().find((f) => f.length > 20);
  if (!cmdField) { out(`\n===== ${req}: コマンド欄が無い（画面が戻っていない）`); break; }
  inbound.length = 0;
  outbound.length = 0;
  session.setField({ index: cmdField.index }, `CALL ${LIB}/${PGM} PARM('${req}')`);
  out(`\n===== ${req} =====`);
  const r = await session.sendAid("Enter", { timeoutMs: 20000 });
  await sleep(2500);
  if (r.timedOut) out("  ⚠ **応答待ちで時間切れ**（ホストが待っている＝こちらが返していない）");

  for (const rec of inbound) {
    const b = rec instanceof Uint8Array ? rec : new Uint8Array(rec);
    const cmd = b[11];
    const NAME = { 0x23: "**ROLL(0x23)**", 0x72: "**READ IMMEDIATE(0x72)**", 0x83: "**READ IMMEDIATE ALT(0x83)**" };
    out(`  受信 ${String(b.length).padStart(4)}B  ${hex(b.subarray(10, Math.min(18, b.length)))}  ${NAME[cmd] ?? ""}`);
  }
  for (const rec of outbound) {
    const b = rec instanceof Uint8Array ? rec : new Uint8Array(rec);
    out(`  送信 ${String(b.length).padStart(4)}B  opcode=0x${(b[9] ?? 0).toString(16)}  ${hex(b.subarray(10, Math.min(20, b.length)))}`);
  }
  out("  --- ホスト側 ---");
  out((await readLog()).split("\n").filter((l) => l.trim()).map((l) => "  " + l).join("\n"));
  // 画面が崩れることがあるので戻す
  await session.sendAid("Enter", { timeoutMs: 10000 }).catch(() => undefined);
  await sleep(1200);
}
ifs.close?.();
session.disconnect();
