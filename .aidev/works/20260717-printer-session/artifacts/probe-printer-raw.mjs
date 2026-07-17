// research probe (milestone 1b): tn5250 のプリンター NEW-ENVIRON を正確に再現した生 telnet 交渉。
// IBMFONT=12 / IBMTRANSFORM=0 を含めて 8925 が変わるかを確かめ、ハンドシェイク不備を排除する。
import { TcpTransport, codecForCcsid, deviceEnvFor } from "file:///workspaces/as400-web-emulator/packages/core/dist/index.js";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
const USER = process.env.PUB400_USER;
const PW = process.env.PUB400_PASSWORD;
const codec = codecForCcsid(37);
const env = deviceEnvFor(37);

const IAC = 0xff, SE = 0xf0, SB = 0xfa, WILL = 0xfb, WONT = 0xfc, DO = 0xfd, DONT = 0xfe, EOR = 0xef;
const OPT = { BINARY: 0, SGA: 3, TT: 24, EOR_OPT: 25, NEWENV: 39 };
const TT_IS = 0, TT_SEND = 1;
const ENV_IS = 0, ENV_SEND = 1, ENV_VAR = 0, ENV_VALUE = 1, ENV_ESC = 2, ENV_USERVAR = 3;
const SUPPORTED = new Set([OPT.BINARY, OPT.SGA, OPT.TT, OPT.EOR_OPT, OPT.NEWENV]);
const A = (s) => [...s].map((c) => c.charCodeAt(0));
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODES = { I901: 1, I902: 1, I906: 1 }; // 成功のみ（他は失敗）

async function probe(cfg) {
  const t = await TcpTransport.connect({ host: HOST, port: 23, connectTimeoutMs: 15000 });
  const send = (arr) => t.send(Uint8Array.from(arr));
  const records = [];
  let closed = null;
  t.onClose((r) => (closed = r));

  // 極小 telnet パーサ
  let st = 0, neg = 0, rec = [], sb = [];
  t.onData((data) => {
    for (const b of data) {
      if (st === 0) { if (b === IAC) st = 1; else rec.push(b); }
      else if (st === 1) {
        if (b === IAC) { rec.push(IAC); st = 0; }
        else if (b === EOR) { records.push(Uint8Array.from(rec)); rec = []; st = 0; }
        else if (b === WILL || b === WONT || b === DO || b === DONT) { neg = b; st = 2; }
        else if (b === SB) { sb = []; st = 3; }
        else st = 0;
      } else if (st === 2) {
        const opt = b, sup = SUPPORTED.has(opt);
        if (neg === DO) send([IAC, sup ? WILL : WONT, opt]);
        else if (neg === WILL) send([IAC, sup ? DO : DONT, opt]);
        st = 0;
      } else if (st === 3) { if (b === IAC) st = 4; else sb.push(b); }
      else if (st === 4) {
        if (b === IAC) { sb.push(IAC); st = 3; }
        else if (b === SE) { handleSb(Uint8Array.from(sb)); sb = []; st = 0; }
        else st = 0;
      }
    }
  });

  function sendSb(payload) {
    const esc = [];
    for (const x of payload) { esc.push(x); if (x === IAC) esc.push(IAC); }
    send([IAC, SB, ...esc, IAC, SE]);
  }
  function handleSb(s) {
    if (s[0] === OPT.TT && s[1] === TT_SEND) {
      sendSb([OPT.TT, TT_IS, ...A("IBM-3812-1")]);
    } else if (s[0] === OPT.NEWENV && s[1] === ENV_SEND) {
      const p = [OPT.NEWENV, ENV_IS];
      if (cfg.dev) p.push(ENV_USERVAR, ...A("DEVNAME"), ENV_VALUE, ...A(cfg.dev));
      // tn5250 プリンター既定
      p.push(ENV_USERVAR, ...A("IBMFONT"), ENV_VALUE, ...A("12"));
      p.push(ENV_USERVAR, ...A("IBMTRANSFORM"), ENV_VALUE, ...A("0"));
      // RFC2877（PUB400 CCSID 対応）
      p.push(ENV_USERVAR, ...A("KBDTYPE"), ENV_VALUE, ...A(env.kbdType));
      p.push(ENV_USERVAR, ...A("CODEPAGE"), ENV_VALUE, ...A(String(env.codePage)));
      p.push(ENV_USERVAR, ...A("CHARSET"), ENV_VALUE, ...A(String(env.charSet)));
      if (cfg.signon && USER) {
        p.push(ENV_VAR, ...A("USER"), ENV_VALUE, ...A(USER));
        p.push(ENV_USERVAR, ...A("IBMRSEED"), ENV_VALUE, ENV_ESC, 0, 0, 0, 0, 0, 0, 0, 0);
        p.push(ENV_USERVAR, ...A("IBMSUBSPW"), ENV_VALUE, ...A(PW));
      }
      sendSb(p);
    }
  }

  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && records.length === 0 && closed === null) await sleep(200);
  await sleep(600);
  t.close();

  console.log(`\n=== dev=${cfg.dev ?? "(host)"} signon=${cfg.signon} font=${cfg.font} : recs=${records.length} closed=${closed ?? "-"} ===`);
  for (const r of records) {
    console.log(`  len=${r.length} hex[0..24]: ${hex(r.subarray(0, Math.min(r.length, 25)))}`);
    if (r.length >= 20) {
      const o = 6 + r[6];
      const code = codec.decode(r.subarray(o + 5, o + 9));
      console.log(`  code="${code}" ${CODES[code] ? "✅ 受理" : "❌ 拒否"}   ebcdic: ${JSON.stringify(codec.decode(r.subarray(o, Math.min(r.length, o + 30))))}`);
      return { code, ok: !!CODES[code] };
    }
  }
  return { code: null, ok: false };
}

const CONFIGS = [
  { dev: undefined, signon: true, font: true },
  { dev: undefined, signon: false, font: true }
];
const out = [];
for (const cfg of CONFIGS) {
  try { out.push({ cfg, ...(await probe(cfg)) }); }
  catch (e) { console.log("err:", e.message); out.push({ cfg, code: null, ok: false }); }
  await sleep(2500);
}
console.log("\n===== 総括（IBMFONT/IBMTRANSFORM 付き）=====");
for (const r of out) console.log(`${r.ok ? "✅" : "❌"} dev=${r.cfg.dev ?? "(host)"} signon=${r.cfg.signon} → ${r.code ?? "判定不能"}`);
process.exit(out.some((r) => r.ok) ? 0 : 2);
