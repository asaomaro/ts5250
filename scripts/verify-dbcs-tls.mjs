// T11: DBCS/TLS/27x132 の実機・リプレイ検証。
// 実機: TLS(992) 接続・DBCS 端末タイプ(IBM-5555-G02)受理・27x132 端末(IBM-3477-FC)受理。
// 画面サイズが実際に効くか（SEU が 132 桁で来るか）は verify-screen-size.mjs が見る。
// リプレイ: 合成 DBCS fixture で日本語デコード・桁維持。
// 実行: node --env-file=.env scripts/verify-dbcs-tls.mjs
import { readFileSync } from "node:fs";
import { Session5250, ReplayTransport, parseTraceJsonl } from "@as400web/core";

const log = (s) => process.stderr.write(s + "\n");
const creds = { user: process.env.PUB400_USER, password: process.env.PUB400_PASSWORD };
const onMenu = (s) => s.snapshot().cells[0].map((c) => c.char).join("").includes("Main Menu");
let ok = true;

// 1. TLS(992)
try {
  const s = await Session5250.connect({ host: "pub400.com", tls: true, deviceName: "WEBEMU01", ...creds });
  const m = onMenu(s);
  log(`TLS(992): onMenu=${m}`);
  ok = ok && m;
  s.disconnect();
} catch (e) { ok = false; log("TLS ERROR: " + e.message); }

// 2. DBCS 端末タイプ受理
try {
  const s = await Session5250.connect({ host: "pub400.com", port: 23, ccsid: 1399, deviceName: "WEBEMUD1", ...creds });
  const m = onMenu(s);
  log(`DBCS term(IBM-5555-G02): onMenu=${m}`);
  ok = ok && m;
  s.disconnect();
} catch (e) { ok = false; log("DBCS term ERROR: " + e.message); }

// 3. 27x132 端末タイプ受理
try {
  const s = await Session5250.connect({ host: "pub400.com", port: 23, screenSize: "27x132", deviceName: "WEBEMUW1", ...creds });
  const m = onMenu(s);
  log(`Wide term(IBM-3477-FC): onMenu=${m}`);
  ok = ok && m;
  s.disconnect();
} catch (e) { ok = false; log("Wide term ERROR: " + e.message); }

// 4. 合成 DBCS リプレイ（日本語デコード・桁維持）
try {
  const entries = parseTraceJsonl(readFileSync("packages/core/test/fixtures/synthetic-dbcs.jsonl", "utf8"));
  const s = await Session5250.connect({ transport: new ReplayTransport(entries), ccsid: 1399 });
  const row1 = s.snapshot().cells[0].map((c) => (c.char === "" ? "" : c.char)).join("");
  const hasJp = row1.includes("日本語");
  log(`DBCS replay: 日本語 decoded=${hasJp}, cols=${s.snapshot().cells[0].length}`);
  ok = ok && hasJp;
} catch (e) { ok = false; log("DBCS replay ERROR: " + e.message); }

log(ok ? "T11: OK — DBCS/TLS/27x132 検証成功" : "T11: NG");
process.exit(ok ? 0 : 1);
