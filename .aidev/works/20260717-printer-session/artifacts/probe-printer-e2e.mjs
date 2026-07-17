// research probe (milestone 2): プリンターセッションを維持したまま、表示セッションから自前の
// スプールをそのプリンター OUTQ へ回し、SCS が降ってくるかを端から端まで確認・キャプチャする。
import { TcpTransport, Session5250, codecForCcsid, deviceEnvFor } from "file:///workspaces/as400-web-emulator/packages/core/dist/index.js";
import { writeFileSync } from "node:fs";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER;
const PW = process.env.PUB400_PASSWORD;
const codec = codecForCcsid(37);
const env = deviceEnvFor(37);
const PRTDEV = "MP" + (Date.now() % 100000); // 毎回ユニーク（PUB400 はデバイスを保持するため衝突回避）

const IAC = 0xff, SE = 0xf0, SB = 0xfa, WILL = 0xfb, WONT = 0xfc, DO = 0xfd, DONT = 0xfe, EOR = 0xef;
const OPT = { BINARY: 0, SGA: 3, TT: 24, EOR_OPT: 25, NEWENV: 39 };
const SUPPORTED = new Set([OPT.BINARY, OPT.SGA, OPT.TT, OPT.EOR_OPT, OPT.NEWENV]);
const A = (s) => [...s].map((c) => c.charCodeAt(0));
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- プリンターセッション（生 telnet、開いたまま保持）----
function openPrinter() {
  return new Promise(async (resolve) => {
    const t = await TcpTransport.connect({ host: HOST, port: 23, connectTimeoutMs: 15000 });
    const send = (arr) => t.send(Uint8Array.from(arr));
    const state = { records: [], closed: null, started: false };
    t.onClose((r) => (state.closed = r));
    let st = 0, neg = 0, rec = [], sb = [];
    function sendSb(p) { const e = []; for (const x of p) { e.push(x); if (x === IAC) e.push(IAC); } send([IAC, SB, ...e, IAC, SE]); }
    function ackPrintComplete() { send([0x00, 0x0a, 0x12, 0xa0, 0x00, 0x12, 0x04, 0x00, 0x00, 0x01, IAC, EOR]); }
    function onRec(r) {
      state.records.push({ t: Date.now(), bytes: r });
      const o = 6 + r[6];
      const code = r.length >= 20 ? codec.decode(r.subarray(o + 5, o + 9)) : "";
      if (code === "I902" || code === "I901" || code === "I906") { state.started = true; state.startupCode = code; state.startupText = codec.decode(r.subarray(o + 5, Math.min(r.length, o + 30))); }
      else { ackPrintComplete(); } // 印刷データには print-complete を返してチェーンを進める
    }
    t.onData((data) => {
      for (const b of data) {
        if (st === 0) { if (b === IAC) st = 1; else rec.push(b); }
        else if (st === 1) {
          if (b === IAC) { rec.push(IAC); st = 0; }
          else if (b === EOR) { onRec(Uint8Array.from(rec)); rec = []; st = 0; }
          else if (b === WILL || b === WONT || b === DO || b === DONT) { neg = b; st = 2; }
          else if (b === SB) { sb = []; st = 3; } else st = 0;
        } else if (st === 2) { const opt = b, s = SUPPORTED.has(opt); if (neg === DO) send([IAC, s ? WILL : WONT, opt]); else if (neg === WILL) send([IAC, s ? DO : DONT, opt]); st = 0; }
        else if (st === 3) { if (b === IAC) st = 4; else sb.push(b); }
        else if (st === 4) { if (b === IAC) { sb.push(IAC); st = 3; } else if (b === SE) { handleSb(Uint8Array.from(sb)); sb = []; st = 0; } else st = 0; }
      }
    });
    function handleSb(s) {
      if (s[0] === OPT.TT && s[1] === 1) sendSb([OPT.TT, 0, ...A("IBM-3812-1")]);
      else if (s[0] === OPT.NEWENV && s[1] === 1) {
        const p = [OPT.NEWENV, 0];
        p.push(3, ...A("DEVNAME"), 1, ...A(PRTDEV));
        p.push(3, ...A("IBMFONT"), 1, ...A("12"));
        p.push(3, ...A("IBMTRANSFORM"), 1, ...A("0"));
        p.push(3, ...A("KBDTYPE"), 1, ...A(env.kbdType));
        p.push(3, ...A("CODEPAGE"), 1, ...A(String(env.codePage)));
        p.push(3, ...A("CHARSET"), 1, ...A(String(env.charSet)));
        sendSb(p);
      }
    }
    resolve({ close: () => t.close(), state });
  });
}

// ---- 表示セッション（Session5250）でコマンド実行 ----
async function connectDisplay() {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const s = await Session5250.connect({ host: HOST, port: 23, deviceName: `WEBP${i}`.slice(0, 10), user: USER, password: PW });
      await s.waitForScreen({ timeoutMs: 8000, until: { text: "Main Menu" } }).catch(() => {});
      if (s.snapshot().fields.some((f) => !f.protected)) return s;
      s.disconnect();
    } catch (e) { last = e; }
    await sleep(2000);
  }
  throw last ?? new Error("no command screen");
}
const textOf = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");
async function run(s, cmd) {
  const f = s.snapshot().fields.filter((x) => !x.protected).at(-1);
  s.setField({ index: f.index }, cmd);
  const r = await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 15000 });
  return r.screen;
}

// ================= 本体 =================
const prt = await openPrinter();
const t0 = Date.now();
while (Date.now() - t0 < 12000 && !prt.state.started && prt.state.closed === null) await sleep(200);
if (!prt.state.started) { console.log("プリンター起動応答なし closed=" + prt.state.closed); process.exit(3); }
console.log(`プリンター起動: ${prt.state.startupCode}  「${prt.state.startupText}」  device=${PRTDEV}`);

const disp = await connectDisplay();
console.log("表示セッション接続 OK");
try {
  // ジョブの OUTQ をプリンターデバイスの OUTQ に向け、小さなスプールを1件作る
  let scr = await run(disp, `CHGJOB OUTQ(${PRTDEV})`);
  const chg = textOf(scr);
  console.log("CHGJOB 結果:", /CPF|not found|error/i.test(chg) ? chg.split("\n").find((l) => /CPF|not/i.test(l))?.trim() : "OK(変更)");
  scr = await run(disp, `DSPLIBL OUTPUT(*PRINT)`);
  console.log("DSPLIBL *PRINT 実行");
  // 直後の OUTQ 状態を全文ダンプ（スプールが載ったか・status を見る）
  await sleep(2000); // ライターが処理してメッセージを上げるのを待つ
  scr = await run(disp, `WRKOUTQ OUTQ(${PRTDEV})`);
  console.log("--- WRKOUTQ（DSPLIBL 直後）---");
  console.log(textOf(scr).split("\n").filter((l) => l.trim()).slice(0, 12).map((l) => l.trimEnd()).join("\n"));
  // MSGW なら option 7（Messages）でメッセージ本文を読む
  const snap = scr;
  const fileRow = snap.cells.findIndex((r) => r.map((c) => c.char).join("").includes("QPRTLIBL"));
  if (fileRow >= 0) {
    const optField = snap.fields.filter((f) => !f.protected && f.row === fileRow + 1).sort((a, b) => a.col - b.col)[0];
    if (optField) {
      disp.setField({ index: optField.index }, "7");
      const r = await disp.sendAid("Enter", { cursor: { row: optField.row, col: optField.col }, timeoutMs: 15000 });
      console.log("--- スプール MSGW メッセージ ---");
      const msgText = textOf(r.screen);
      console.log(msgText.split("\n").filter((l) => l.trim()).slice(0, 5).map((l) => l.trimEnd()).join("\n"));
      // CPA3394（用紙タイプ問い合わせ）に "I"（現用紙で印刷）を返す → ライターが SCS 送出を開始
      const reply = r.screen.fields.filter((f) => !f.protected).sort((a, b) => b.row - a.row || b.col - a.col)[0];
      if (reply) {
        disp.setField({ index: reply.index }, "I");
        await disp.sendAid("Enter", { cursor: { row: reply.row, col: reply.col }, timeoutMs: 15000 }).catch(() => {});
        console.log('CPA3394 に "I" を返信（現用紙で印刷）');
      }
    } else console.log("(option 欄が見つからず)");
  } else console.log("(QPRTLIBL 行が見つからず)");
  await disp.sendAid("F3").catch(() => {});
  // 返信後、プリンターセッションに SCS が降ってくるのを待つ（最大 20 秒）
  const t1 = Date.now();
  while (Date.now() - t1 < 20000 && prt.state.records.length < 2) {
    await sleep(1000);
    if ((Date.now() - t1) % 5000 < 1000) console.log(`  待機 +${Math.round((Date.now() - t1) / 1000)}s recs=${prt.state.records.length}`);
  }
} finally {
  await disp.disconnect();
}

await sleep(1000);
const dataRecs = prt.state.records.filter((r) => { const b = r.bytes; const o = 6 + b[6]; const code = b.length >= 20 ? codec.decode(b.subarray(o + 5, o + 9)) : ""; return code !== "I902" && code !== "I901" && code !== "I906"; });
console.log(`\n===== 受信レコード total=${prt.state.records.length} / 印刷データ=${dataRecs.length} =====`);
for (const r of prt.state.records) {
  const b = r.bytes;
  console.log(`  +${r.t - t0}ms len=${b.length} op=${b[9]} hex[0..30]: ${hex(b.subarray(0, Math.min(b.length, 31)))}`);
}
if (dataRecs.length) {
  const payloads = dataRecs.map((r) => r.bytes.subarray(10));
  const all = Buffer.concat(payloads.map((p) => Buffer.from(p)));
  writeFileSync("/tmp/claude-1000/-workspaces-as400-web-emulator/0d514ddf-60ce-4ba1-85fd-79b8f8491d4e/scratchpad/scs-capture.bin", all);
  console.log(`\n✅ SCS 受信! payload ${all.length} bytes を scs-capture.bin に保存`);
  console.log("  先頭 hex:", hex(all.subarray(0, Math.min(all.length, 60))));
  console.log("  EBCDIC :", JSON.stringify(codec.decode(all.subarray(0, Math.min(all.length, 80)))));
  prt.close();
  process.exit(0);
} else {
  console.log("\n⚠️ プリンターへ SCS が降ってこなかった（OUTQ 経路/writer 要確認）");
  prt.close();
  process.exit(4);
}
