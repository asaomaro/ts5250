// 06 T10: 拡張 5250（enhanced）広告の実機検証。
//  1) enhanced=true でも既存の自動サインオン→メニュー到達が壊れないこと（非 GUI 回帰）
//  2) メニューやサブ画面で GUI 構造体（snapshot.gui）が来るか探索（あれば疎通確認）
// 実行: node --env-file=.env scripts/verify-gui-enhanced.mjs
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
  enhanced: true, // ★ 拡張 5250 を広告
  warn: (w) => log("WARN: " + w)
});

log(`connected: state=${session.currentState}`);
let snap = session.snapshot();
const text = screenText(snap);
const onMenu = /Main Menu|MAIN\b/i.test(text);
log(`cursor=(${snap.cursor.row},${snap.cursor.col}) fields=${snap.fields.length} onMenu=${onMenu}`);

// 1) 非 GUI 回帰: enhanced でもメニュー到達
if (onMenu) log("T10-a: OK — enhanced 広告でも自動サインオン→メニュー到達（非 GUI 回帰なし）");
else log("T10-a: ? — メニュー未到達（要確認）");

// 2) GUI 構造体の探索: メニューから GUI を使いそうなコマンドを試す
const reportGui = (label, s) => {
  if (s.gui) {
    log(`T10-b: GUI 検出 @${label} — windows=${s.gui.windows.length} selections=${s.gui.selectionFields.length} scrollbars=${s.gui.scrollBars.length}`);
    return true;
  }
  return false;
};

let found = reportGui("menu", snap);

// WRKACTJOB 等はウィンドウ/選択を使う場合がある。コマンド行があれば試す
const cmdField = snap.fields.find((f) => !f.protected && f.row >= 19);
if (cmdField && !found) {
  for (const cmd of ["WRKMSG", "GO INFO", "WRKACTJOB"]) {
    try {
      session.setField({ index: cmdField.index }, cmd);
      const r = await session.sendAid("Enter", { timeoutMs: 8000 });
      snap = r.screen;
      if (reportGui(cmd, snap)) { found = true; break; }
      await session.sendAid("F3", { timeoutMs: 8000 }).catch(() => {});
    } catch (err) {
      log(`  ${cmd}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (!found) {
  log("T10-b: GUI 構造体は探索範囲で未検出（PUB400 標準画面は非 GUI。合成 trace を正とする — decisions D3 / plan の方針）");
}

session.disconnect();
process.exit(onMenu ? 0 : 1);
