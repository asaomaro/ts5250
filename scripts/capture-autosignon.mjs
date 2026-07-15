// 自動サインオン→Query Reply→メニュー のフロー trace を採取（回帰資産）。
// 送信データ（パスワード含む NEW-ENVIRON・Query Reply）は maskTx 既定 ON で伏字化。
// 実行: node --env-file=.env scripts/capture-autosignon.mjs
import { writeFileSync, appendFileSync } from "node:fs";
import { Session5250, TcpTransport, TraceRecorder } from "@as400web/core";

const user = process.env.PUB400_USER, password = process.env.PUB400_PASSWORD;
if (!user || !password) { process.stderr.write("creds 未設定\n"); process.exit(1); }
const out = "packages/core/test/fixtures/pub400-autosignon-menu.jsonl";
const log = (s) => process.stderr.write(s + "\n");

writeFileSync(out, "");
const rec = new TraceRecorder((l) => appendFileSync(out, l + "\n")); // maskTx: true
const inner = await TcpTransport.connect({ host: "pub400.com", port: 23 });
const tracing = {
  send(d){ rec.tx(d); inner.send(d); }, close(){ inner.close(); },
  onData(f){ inner.onData((d)=>{ rec.rx(d); f(d); }); },
  onClose(f){ inner.onClose(f); }, onError(f){ inner.onError(f); }
};
const s = await Session5250.connect({
  transport: tracing, deviceName: process.env.PUB400_DEVNAME ?? "WEBEMU01",
  user, password, warn: (w)=>log("WARN: "+w)
});
const text = s.snapshot().cells.map(r=>r.map(c=>c.char).join("")).join("\n");
log("menu reached: " + /Main Menu/i.test(text));
s.disconnect();
await new Promise(r=>setTimeout(r,300));
log("saved: " + out);
process.exit(0);
