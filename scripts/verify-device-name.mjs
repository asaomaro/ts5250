// 実機検証（tn5250）: **装置名を ACS と同じく展開・大文字化し、使用中なら同じ接続の中で次の名前で答え直す**（`20260921-device-name-acs`）。
//
// ACS（`AutoDeviceName5250`）の規則はタップで採った ACS のコアの DEVNAME で確かめてある（research）。ここでは当 PJ が実機で同じに動くかを見る:
//   1) 小文字の名前 → 大文字の装置で繋がる
//   2) `<名>0` を掴んだまま `<名>=` で繋ぐ → 同じ接続の中で `<名>1` になって繋がる
//   3) 記号の無い名前が使用中 → 8902 で断られる（`deviceNameRetry` 無し）
//   4) 同じく `deviceNameRetry` あり → 末尾の数字を繰り上げて繋がる（繋ぎ直さない）
//   5) プリンターの `%=` → `P` と番号
// **ホストに何も作らない**（装置は PUB400 が自動で作る。ほかの検証スクリプトと同じく毎回別の名前にする）。
//
// 実行: npm run build -w @ts5250/tn5250 && node --env-file=.env --env-file=.env.verify scripts/verify-device-name.mjs
//   env: PUB400_USER / PUB400_PASSWORD（任意 PUB400_HOST）
import { Session5250, PrinterSession } from "@ts5250/tn5250";

const HOST = process.env.PUB400_HOST ?? "pub400.com";
if (!process.env.PUB400_USER || !process.env.PUB400_PASSWORD) {
  process.stderr.write("PUB400_USER / PUB400_PASSWORD が要ります（.env）\n");
  process.exit(2);
}
const log = (s) => process.stderr.write(`${s}\n`);
const tag = "V" + String(Date.now() % 10000).padStart(4, "0"); // 5 文字。後ろに 1〜2 文字足す
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };
const open = (deviceName, more = {}) => Session5250.connect({ host: HOST, ccsid: 37, deviceName, ...more });
const tryOpen = (deviceName, more) => open(deviceName, more).then((s) => ({ s }), (e) => ({ e }));

const held = [];
try {
  // 1) 小文字
  const a = await tryOpen(`${tag.toLowerCase()}a`);
  check(a.s?.startup?.device === `${tag}A`, `小文字の名前は大文字の装置 ${tag}A で繋がる（${a.s?.startup?.device ?? a.e?.message}）`);
  a.s?.disconnect();
  // 2) `=`
  const h0 = await open(`${tag}B0`);
  held.push(h0);
  const b = await tryOpen(`${tag}B=`);
  check(b.s?.startup?.device === `${tag}B1`, `${tag}B0 を掴んだまま ${tag}B= → 同じ接続の中で ${tag}B1（${b.s?.startup?.device ?? b.e?.message}）`);
  b.s?.disconnect();
  // 3) 記号の無い名前が使用中
  const c = await tryOpen(`${tag}B0`);
  check(c.e?.code === "SESSION_REJECTED" && /8902/.test(c.e.message), `記号の無い名前が使用中なら 8902 で断る（${c.e?.code ?? c.s?.startup?.device}）`);
  c.s?.disconnect();
  // 4) deviceNameRetry
  const d = await tryOpen(`${tag}B0`, { deviceNameRetry: true });
  check(d.s?.startup?.device === `${tag}B1`, `deviceNameRetry は繰り上げて ${tag}B1 で繋がる（${d.s?.startup?.device ?? d.e?.message}）`);
  d.s?.disconnect();
  // 5) プリンター
  const p = await PrinterSession.connect({ host: HOST, port: 23, deviceName: `${tag}%=`, user: process.env.PUB400_USER, password: process.env.PUB400_PASSWORD }).then((s) => ({ s }), (e) => ({ e }));
  check(p.s?.startupCode === "I902", `プリンターの ${tag}%= が I902 で繋がる（${p.s?.startupCode ?? p.e?.message}）`);
  p.s?.disconnect();
} finally {
  for (const s of held) s.disconnect();
}
log(`RESULT: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
