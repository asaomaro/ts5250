// プリンターセッションの**申告の組み合わせ**を実機に当て、装置が何として作られ、IGC（日本語）帳票を
// 書き出しプログラムが処理できるかを測る（`.aidev/backlog/acs-parity.md`「DBCS プリンターの申告内容」）。
//
// ACS の申告（`DS5250P.initializeTelnet` / `NVT5250` の `userVarPRTDB`・`userVarPRTSB`）と、当 PJ の申告
// （`printer-session.ts`）を**同じ手順**で並べる。当 PJ の TelnetLayer は申告の組を変えられないので、
// ここでは telnet を素で話す（交渉と印刷完了の応答だけ）。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-printer-declare.mjs <variant> [--igc] [--keep]
//   variant: acs-db | acs-sb | acs-hpt-db | acs-hpt-sb | ours | ours-hpt | ours-5553
//   --igc   OVRPRTF で IGCDTA(*YES) を付けた帳票（DSPLIBL）を送る。無ければ英数字だけの帳票
//   --keep  作った装置・待ち行列を消さない（既定は消す）
//   --signon USER / IBMRSEED / IBMSUBSPW を足す（当 PJ は資格情報があれば送る。ACS は SSO の「サインオンの迂回」のときだけ）
//   --dev=<名前> 既存の装置名で繋ぐ（自動構成ではなく、既にある装置の型が申告でどう扱われるかを見る。消さない）
//   --precreate=5553|3812 繋ぐ前に装置を CRTDEVPRT で作る（自動構成が許されていない機械向け。後で消す）
//   --pub400 PUB400 に当てる（起動応答だけを見る。装置は PUB400 が切断後に片付ける）
//
// 作るもの: 装置 `TSPD<variant の頭文字><2 桁>`（自動構成）と、その待ち行列（QUSRSYS）。**既定で消す**。
import net from "node:net";
import { Session5250 } from "@ts5250/tn5250";

// --pub400 で PUB400（自動構成が許されている機械）に当てる。表示セッションの手順（DSPDEVD 等）は実機用
const PUB = process.argv.includes("--pub400");
const host = PUB ? (process.env.PUB400_HOST ?? "pub400.com") : process.env.AS400_HOST;
const user = PUB ? process.env.PUB400_USER : process.env.AS400_USER;
const password = PUB ? process.env.PUB400_PASSWORD : process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD が要ります（.env）\n"); process.exit(2); }
const ccsid = Number(process.env.AS400_CCSID ?? 930);
const variant = process.argv[2] ?? "acs-db";
const igc = process.argv.includes("--igc");
const signon = process.argv.includes("--signon");
const devArg = process.argv.find((a) => a.startsWith("--dev="))?.slice(6);
const precreate = process.argv.find((a) => a.startsWith("--precreate="))?.slice(12);
const keep = process.argv.includes("--keep") || devArg !== undefined;
const log = (s) => process.stderr.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

const DEV = devArg ?? `TSPD${variant.replace(/[^a-z]/g, "").slice(0, 2).toUpperCase()}${String(Date.now() % 100).padStart(2, "0")}`;

// NEW-ENVIRON: VAR=0 VALUE=1 ESC=2 USERVAR=3
const uv = (name, value) => [3, ...ascii(name), 1, ...(value === undefined ? [] : ascii(value))];
const DECL = {
  // ACS: DBCS で HPT なし → IBM-5553-B01。変数は DEVNAME / IBMMSGQNAME / IBMMSGQLIB / IBMFORMFEED / IBMIGCFEAT / IBMTRANSFORM
  "acs-db": {
    tt: "IBM-5553-B01",
    env: [uv("DEVNAME", DEV), uv("IBMMSGQNAME", "QSYSOPR"), uv("IBMMSGQLIB", "*LIBL"), uv("IBMFORMFEED"), uv("IBMIGCFEAT", "2424J0"), uv("IBMTRANSFORM", "0")]
  },
  // ACS: SBCS で HPT なし → IBM-3812-1。IBMFONT は既定 11、IBMBUFFERSIZE は 768 固定
  "acs-sb": {
    tt: "IBM-3812-1",
    env: [uv("DEVNAME", DEV), uv("IBMMSGQNAME", "QSYSOPR"), uv("IBMMSGQLIB", "*LIBL"), uv("IBMFONT", "11"), uv("IBMFORMFEED"), uv("IBMBUFFERSIZE", "768"), uv("IBMTRANSFORM", "0")]
  },
  // 当 PJ の現状（printer-session.ts → telnet.ts）。CCSID 5035/939 の申告値は device-env.ts
  ours: {
    tt: "IBM-3812-1",
    env: [uv("DEVNAME", DEV), uv("IBMFONT", "12"), uv("IBMTRANSFORM", "0"), uv("KBDTYPE", "JEB"), uv("CODEPAGE", "1027"), uv("CHARSET", "1172"), uv("IBMSENDCONFREC", "YES")]
  },
  // ACS: HPT（ホスト変換。ACS の 5250 プリンターの既定）の DBCS → 端末タイプは IBM-3812-1。`userVarPRTDBHPT`。
  // 用紙入れ・封筒は既定 "00" を ESC＋0x00 で送る（`insertVariable` の 11〜13）。IBMWSCSTLIB はカスタマイズ・オブジェクトを使うときだけ
  "acs-hpt-db": {
    tt: "IBM-3812-1",
    env: [uv("DEVNAME", DEV), uv("IBMMSGQNAME", "QSYSOPR"), uv("IBMMSGQLIB", "*LIBL"), uv("IBMFONT", "11"), uv("IBMBUFFERSIZE", "768"),
      uv("IBMTRANSFORM", "1"), uv("IBMMFRTYPMDL", "*HP4"), [3, ...ascii("IBMPPRSRC1"), 1, 2, 0], [3, ...ascii("IBMPPRSRC2"), 1, 2, 0],
      [3, ...ascii("IBMENVELOPE"), 1, 2, 0], uv("IBMWSCSTNAME", "*NONE")]
  },
  "acs-hpt-sb": {
    tt: "IBM-3812-1",
    env: [uv("DEVNAME", DEV), uv("IBMMSGQNAME", "QSYSOPR"), uv("IBMMSGQLIB", "*LIBL"), uv("IBMFONT", "11"), uv("IBMBUFFERSIZE", "768"),
      uv("IBMTRANSFORM", "1"), uv("IBMMFRTYPMDL", "*HP4"), [3, ...ascii("IBMPPRSRC1"), 1, 2, 0], [3, ...ascii("IBMPPRSRC2"), 1, 2, 0],
      [3, ...ascii("IBMENVELOPE"), 1, 2, 0], uv("IBMASCII899", "0"), uv("IBMWSCSTNAME", "*NONE")]
  },
  // 当 PJ の HPT の現状
  "ours-hpt": {
    tt: "IBM-3812-1",
    env: [uv("DEVNAME", DEV), uv("IBMFONT", "12"), uv("IBMTRANSFORM", "1"), uv("IBMMFRTYPMDL", "*HP4"), uv("KBDTYPE", "JEB"), uv("CODEPAGE", "1027"), uv("CHARSET", "1172"), uv("IBMSENDCONFREC", "YES")]
  },
  // 過去の試験（docs/HOST-PRINT-TRANSFORM.md §2）の再現: 5553-B01 に当 PJ の変数を載せる
  "ours-5553": {
    tt: "IBM-5553-B01",
    env: [uv("DEVNAME", DEV), uv("IBMFONT", "12"), uv("IBMTRANSFORM", "0"), uv("KBDTYPE", "JEB"), uv("CODEPAGE", "1027"), uv("CHARSET", "1172"), uv("IBMSENDCONFREC", "YES")]
  }
}[variant];
if (!DECL) { log(`未知の variant: ${variant}`); process.exit(2); }
if (signon) {
  // 当 PJ（telnet.ts）と同じ形: USER は VAR、IBMRSEED は ESC＋ゼロ 8 バイト（非暗号化）、IBMSUBSPW は平文
  DECL.env.push([0, ...ascii("USER"), 1, ...ascii(user)], [3, ...ascii("IBMRSEED"), 1, 2, 0, 0, 0, 0, 0, 0, 0, 0], uv("IBMSUBSPW", password));
}

// ACS の NO_ERROR（`DS5250P` の定数。IAC EOR は telnet 層で付ける）
const NO_ERROR = [0x00, 0x0a, 0x12, 0xa0, 0x01, 0x02, 0x04, 0x00, 0x00, 0x01];
const IAC = 255, SB = 250, SE = 240, WILL = 251, WONT = 252, DO = 253, DONT = 254, EOR = 239;
const SUPPORTED = new Set([0, 24, 25, 39]); // BINARY / TTYPE / EOR / NEW-ENVIRON

/** 素の telnet でプリンターとして繋ぐ。レコード（IAC EOR 区切り）を受けて返す */
function connectPrinter() {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port: 23 });
    const records = [];
    let buf = [], sb = null, state = "data", neg = 0;
    const send = (bytes) => sock.write(Buffer.from(bytes));
    const sendRecord = (rec) => send([...rec.flatMap((b) => (b === IAC ? [IAC, IAC] : [b])), IAC, EOR]);
    let onRecord = () => {};
    sock.on("data", (chunk) => {
      for (const b of chunk) {
        if (state === "data") { if (b === IAC) state = "iac"; else buf.push(b); }
        else if (state === "iac") {
          if (b === IAC) { buf.push(IAC); state = "data"; }
          else if (b === EOR) { const r = Uint8Array.from(buf); buf = []; state = "data"; records.push(r); onRecord(r); }
          else if (b === SB) { sb = []; state = "sb"; }
          else if (b >= WILL && b <= DONT) { neg = b; state = "neg"; }
          else state = "data";
        } else if (state === "neg") {
          const ok = SUPPORTED.has(b);
          if (neg === DO) send([IAC, ok ? WILL : WONT, b]);
          else if (neg === WILL) send([IAC, ok ? DO : DONT, b]);
          state = "data";
        } else if (state === "sb") {
          if (b === IAC) state = "sbiac"; else sb.push(b);
        } else if (state === "sbiac") {
          if (b === SE) {
            if (sb[0] === 24 && sb[1] === 1) send([IAC, SB, 24, 0, ...ascii(DECL.tt), IAC, SE]);
            else if (sb[0] === 39 && sb[1] === 1) send([IAC, SB, 39, 0, ...DECL.env.flat(), IAC, SE]);
            state = "data";
          } else { sb.push(b); state = "sb"; }
        }
      }
    });
    sock.on("error", reject);
    sock.on("close", () => log(`[prt] closed`));
    onRecord = (r) => {
      onRecord = () => {};
      resolve({ sock, records, sendRecord, setOnRecord: (fn) => { onRecord = fn; }, startup: r });
    };
    setTimeout(() => reject(new Error("startup timeout")), 20000);
  });
}

/** 起動応答レコードから 4 桁のコード（EBCDIC の I/数字）を拾う */
function startupCode(rec) {
  const ch = (b) => (b >= 0xf0 && b <= 0xf9 ? String(b - 0xf0) : b === 0xc9 ? "I" : null);
  for (let i = 0; i + 3 < rec.length; i++) {
    const s = [0, 1, 2, 3].map((k) => ch(rec[i + k]));
    if (s.every((x) => x !== null) && /^[I89]\d{3}$/.test(s.join(""))) return s.join("");
  }
  return "?";
}

const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
const inputsOf = (snap) => snap.fields.filter((f) => !f.protected);
async function display() {
  const s = await Session5250.connect({ host, ccsid });
  await sleep(800);
  const inputs = inputsOf(s.snapshot());
  s.setField({ index: inputs[0].index }, user);
  s.setField({ index: inputs[1].index }, password);
  await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
  for (let i = 0; i < 6; i++) {
    await sleep(800);
    const t = rows(s.snapshot());
    if (t.some((r) => /===>/.test(r))) break;
    if (t.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = inputsOf(s.snapshot()).slice(-1)[0];
      s.setField({ index: f.index }, "90");
      await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else await s.sendAid("Enter", { timeoutMs: 10000 }).catch(() => {});
  }
  return s;
}
async function cmd(s, text, { show = false } = {}) {
  const f = inputsOf(s.snapshot()).find((x) => x.length >= 50) ?? inputsOf(s.snapshot()).slice(-1)[0];
  s.setField({ index: f.index }, text);
  await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 20000 }).catch((e) => log(`  (${text}: ${e.message})`));
  await sleep(1200);
  const t = rows(s.snapshot());
  if (show) t.forEach((r, i) => r.trim() && log(`  ${String(i + 1).padStart(2, "0")}|${r}`));
  else log(`  > ${text} → ${t.at(-1)?.trim() || t.at(-2)?.trim() || ""}`);
  return t;
}
async function back(s) { await s.sendAid("F3", { timeoutMs: 10000 }).catch(() => {}); await sleep(800); }

log(`variant=${variant} tt=${DECL.tt} dev=${DEV} igc=${igc} signon=${signon} precreate=${precreate ?? "-"} host=${PUB ? "PUB400" : "実機"}`);
if (PUB) {
  try {
    const p = await connectPrinter();
    log(`[prt] 起動応答 ${startupCode(p.startup)}（${p.startup.length} バイト）`);
    p.sock.destroy();
  } catch (e) { log(`[prt] 接続失敗: ${e.message}`); }
  process.exit(0);
}
const s = await display();
const CTLD = process.env.AS400_VRTCTL ?? "QVIRCD0001";
const CRT = {
  // telnet の仮想プリンターは仮想制御装置に付いていないと 8903（装置がセッションに無効）になる（実測）。
  // 制御装置は自動構成で作られた装置と同じもの（既定 QVIRCD0001。`DSPDEVD` の「接続される制御装置」）
  5553: `CRTDEVPRT DEVD(${DEV}) DEVCLS(*VRT) TYPE(5553) MODEL(B01) IGCFEAT(2424J0) CTL(${CTLD}) ONLINE(*NO) TEXT('ts5250 diag')`,
  3812: `CRTDEVPRT DEVD(${DEV}) DEVCLS(*VRT) TYPE(3812) MODEL(1) FONT(011) CTL(${CTLD}) ONLINE(*NO) TEXT('ts5250 diag')`
};
if (precreate) {
  await cmd(s, CRT[precreate]);
  await cmd(s, `DSPDEVD DEVD(${DEV})`, { show: true });
  await back(s);
}
let prt;
try {
  prt = await connectPrinter();
} catch (e) {
  log(`[prt] 接続失敗: ${e.message}`);
}
const code = prt ? startupCode(prt.startup) : "-";
log(`[prt] 起動応答 ${code}（${prt?.startup.length ?? 0} バイト）`);

const data = [];
prt?.setOnRecord((r) => {
  const opcode = r[9];
  const payload = r.subarray(6 + (r[6] ?? 4));
  const so = payload.filter((b) => b === 0x0e).length;
  data.push({ len: r.length, opcode, flags1: r[7], so });
  const hex = r.length <= 40 ? ` [${[...r].map((b) => b.toString(16).padStart(2, "0")).join(" ")}]` : ` 先頭[${[...r.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}]`;
  log(`[prt] レコード ${r.length} バイト opcode=${opcode} flags=${r[7].toString(16)} SO=${so}${hex}`);
  prt.sendRecord(NO_ERROR);
});

try {
  if (!/^I90/.test(code)) {
    log("装置が作られなかったので、帳票の試験は飛ばす");
  } else {
    log("--- DSPDEVD ---");
    await cmd(s, `DSPDEVD DEVD(${DEV})`, { show: true });
    await back(s);
    await cmd(s, `CHGJOB OUTQ(${DEV})`);
    if (igc) await cmd(s, "OVRPRTF FILE(QPRTLIBL) IGCDTA(*YES)");
    await cmd(s, "DSPLIBL OUTPUT(*PRINT)");
    await sleep(3000);
    // 書き出しプログラムの問い合わせを見る。用紙（CPA3394）なら "I" で答え、それ以外（CPA3303 など）は出して止める
    for (let round = 0; round < 4; round++) {
      const t = await cmd(s, `WRKOUTQ OUTQ(${DEV})`, { show: round === 0 });
      const row = t.findIndex((r) => r.includes("QPRTLIBL"));
      if (row < 0 || !t[row].includes("MSGW")) { log(`  帳票の状況: ${row < 0 ? "（待ち行列に無い）" : t[row].trim()}`); await back(s); break; }
      const opt = inputsOf(s.snapshot()).filter((f) => f.row === row + 1).sort((a, b) => a.col - b.col)[0];
      s.setField({ index: opt.index }, "7");
      await s.sendAid("Enter", { cursor: { row: opt.row, col: opt.col }, timeoutMs: 15000 }).catch(() => {});
      await sleep(1000);
      const m = rows(s.snapshot());
      const id = m.map((r) => /メッセージ ID\s*\.[ .]*:\s*(\S+)/.exec(r)?.[1]).find(Boolean) ?? "?";
      log(`--- 書き出しプログラムのメッセージ ${id} ---`);
      m.slice(2, 13).forEach((r) => r.trim() && log(`  |${r}`));
      const reply = inputsOf(s.snapshot()).sort((a, b) => b.row - a.row || b.col - a.col)[0];
      // CPA3394（用紙のロード）・CPA4044（位置合わせ）は "I" で続ける。それ以外（CPA3303 など）はそこで止める
      if ((id === "CPA3394" || id === "CPA4044") && reply) {
        s.setField({ index: reply.index }, "I");
        await s.sendAid("Enter", { cursor: { row: reply.row, col: reply.col }, timeoutMs: 15000 }).catch(() => {});
        log(`  ${id} に "I" を返信`);
        await back(s);
        await sleep(4000);
        continue;
      }
      await back(s); await back(s);
      break;
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !data.some((d) => d.len <= 17)) await sleep(500);
    log(`--- 受信: ${data.length} レコード / SO 計 ${data.reduce((n, d) => n + d.so, 0)} ---`);
    await cmd(s, `WRKOUTQ OUTQ(${DEV})`, { show: true });
    await back(s);
  }
} finally {
  prt?.sock.destroy();
  await sleep(3000);
  if (!keep || precreate) {
    log("--- 片付け ---");
    await cmd(s, `DLTSPLF FILE(QPRTLIBL) JOB(*) SPLNBR(*LAST)`);
    await cmd(s, `VRYCFG CFGOBJ(${DEV}) CFGTYPE(*DEV) STATUS(*OFF)`);
    await sleep(2000);
    await cmd(s, `DLTDEVD DEVD(${DEV})`);
    await cmd(s, `CLROUTQ OUTQ(QUSRSYS/${DEV})`);
    await cmd(s, `DLTOUTQ OUTQ(QUSRSYS/${DEV})`);
    await cmd(s, `CHKOBJ OBJ(${DEV}) OBJTYPE(*DEVD)`);
    await cmd(s, `CHKOBJ OBJ(QUSRSYS/${DEV}) OBJTYPE(*OUTQ)`);
    await cmd(s, "WRKSPLF", { show: true });
    await back(s);
  }
  await cmd(s, "SIGNOFF");
  s.disconnect();
}
