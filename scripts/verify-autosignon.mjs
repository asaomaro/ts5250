// T13: RFC 4777 NEW-ENVIRON 自動サインオン（ゼロシード）の実機検証（decisions.md D3）。
// 実行: node --env-file=.env scripts/verify-autosignon.mjs
import { Session5250 } from "@as400web/core";

const user = process.env.PUB400_USER;
const password = process.env.PUB400_PASSWORD;
if (!user || !password) {
  process.stderr.write("PUB400_USER / PUB400_PASSWORD が未設定です\n");
  process.exit(1);
}
const log = (s) => process.stderr.write(s + "\n");
const screenText = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("")).join("\n");

const session = await Session5250.connect({
  host: process.env.PUB400_HOST ?? "pub400.com",
  port: 23,
  deviceName: process.env.PUB400_DEVNAME ?? "WEBEMU01",
  user,
  password,
  warn: (w) => log("WARN: " + w)
});

log(`connected: state=${session.currentState}`);
const snap = session.snapshot();
log(`cursor=(${snap.cursor.row},${snap.cursor.col}) fields=${snap.fields.length}${snap.systemMessage ? ` msg="${snap.systemMessage}"` : ""}`);
snap.cells.forEach((row, i) => {
  const t = row.map((c) => c.char).join("").replace(/ +$/, "");
  if (t !== "") log(String(i + 1).padStart(2) + "|" + t);
});

const text = screenText(snap);
const onMenu = /MAIN\s+IBM i Main Menu|Main Menu/i.test(text);
const stillSignon = /Your user name|Sign On|Password/i.test(text) && !onMenu;
const rejected = /CPF\d{4}/.test(text);

if (onMenu) log("T13: OK — 自動サインオンでメニュー到達");
else if (rejected) log("T13: NG — 資格情報が拒否された（CPFxxxx）");
else if (stillSignon) log("T13: NG — サインオン画面のまま（自動サインオン不成立）");
else log("T13: ? — 想定外の画面");

session.disconnect();
process.exit(onMenu ? 0 : 1);
