// 入力ラウンドトリップの実機 E2E 検証。<LIB>/INPPGM（build-attrtest.mjs で作成）を CALL し、
// SBCS 欄と DBCS(日本語)欄へエミュレーターから入力→Enter→ホストが読み取りエコー欄へ複写→再表示。
// エコー欄に入力値が返れば「エミュレーターの入力→EBCDIC/DBCS 再エンコード→ホスト受信」が通った証拠。
// DBCS を扱うためセッションは CCSID 1399。
// 実行: node --env-file=.env scripts/verify-input.mjs
//   前提: <LIB>（既定 MYLIB）に INPTST/INPPGM が存在すること（無ければ build-attrtest.mjs を先に）。
import { Session5250 } from "@as400web/core";

const LIB = process.env.PUB400_LIB ?? "MYLIB";
const log = (s) => process.stderr.write(s + "\n");
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const cmdField = (s) => { const e = s.fields.filter((f) => !f.protected); return e[e.length - 1]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectMenu() {
  // 切断後もデバイスが保持されるため、リトライごとにデバイス名を変える
  const base = process.env.PUB400_DEVNAME ?? "WEBINV";
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const s = await Session5250.connect({
        host: process.env.PUB400_HOST ?? "pub400.com", port: 23, ccsid: 1399,
        deviceName: `${base}${i}`.slice(0, 10),
        user: process.env.PUB400_USER, password: process.env.PUB400_PASSWORD, warn: (w) => log("WARN: " + w)
      });
      await s.waitForScreen({ timeoutMs: 8000, until: { text: "Main Menu" } }).catch(() => {});
      if (cmdField(s.snapshot())) return s;
      s.disconnect();
    } catch (e) { last = e; log(`connect retry ${i + 1}: ${e.message}`); }
    await sleep(2000);
  }
  throw last ?? new Error("could not reach a command screen");
}

let session;
try {
  session = await connectMenu();
  // INPPGM を CALL → 空の入力画面
  const cf = cmdField(session.snapshot());
  session.setField({ index: cf.index }, `CALL ${LIB}/INPPGM`);
  const s1 = (await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs: 20000 })).screen;
  check("INPPGM を CALL して入力画面を表示", /INPUT TEST/.test(s1.cells[0].map((c) => c.char).join("")));

  const editable = s1.fields.filter((f) => !f.protected);
  const aIn = editable.find((f) => f.row === 3), jIn = editable.find((f) => f.row === 4);
  check("SBCS/DBCS の 2 入力欄がある", !!aIn && !!jIn, `${editable.length} 欄`);
  check("DBCS 入力欄が dbcsType 付きで認識される", !!jIn?.dbcsType, `dbcsType=${jIn?.dbcsType}`);

  // 入力して Enter → ホストがエコー欄へ複写した画面が返る
  session.setField({ index: aIn.index }, "HELLO");
  session.setField({ index: jIn.index }, "日本語");
  const s2 = (await session.sendAid("Enter", { timeoutMs: 20000 })).screen;
  const at = (r, c) => s2.cells[r - 1][c - 1];
  log("A ECHO: " + s2.cells[5].map((c) => c.char).join("").replace(/ +$/, ""));
  log("J ECHO: " + s2.cells[6].map((c) => c.char).join("").replace(/ +$/, ""));

  const echoA = s2.cells[5].map((c) => c.char).join("").slice(9, 19).trimEnd();
  check("SBCS 入力がホストに届きエコーされる (HELLO)", echoA === "HELLO", `got '${echoA}'`);
  // JECHO 欄: (7,10)=SO / (7,11)=日 lead / (7,13)=本 / (7,15)=語
  check("DBCS エコー欄が SO で始まる (7,10)", at(7, 10).kind === "so");
  check("DBCS(日本語) 入力がエコーされる 日 (7,11)", at(7, 11).char === "日" && at(7, 11).kind === "dbcs-lead", `got ${at(7, 11).char}/${at(7, 11).kind}`);
  check("DBCS エコー 本 (7,13)", at(7, 13).char === "本");
  check("DBCS エコー 語 (7,15)", at(7, 15).char === "語");

  await session.sendAid("F3", { timeoutMs: 8000 }).catch(() => {});
} catch (e) {
  results.push(false); log("E2E ERROR: " + e.message);
} finally {
  await session?.disconnect();
}
const passed = results.filter(Boolean).length;
const ok = results.length > 0 && passed === results.length;
log(`\n${ok ? "OK — 入力ラウンドトリップ（SBCS＋DBCS 日本語）に対応" : "NG"} — ${passed}/${results.length} passed`);
process.exit(ok ? 0 : 1);
