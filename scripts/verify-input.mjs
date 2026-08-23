// 入力ラウンドトリップ＋フィールド型の実機 E2E 検証（core 直叩き）。
// <LIB>/INPPGM（build-attrtest.mjs で作成）を CALL し、4 つの入力欄の型を確認:
//   NUM=数値 / A=SBCS / O=DBCS-open / J=DBCS-only(pure)。
// O へ SBCS+DBCS、J へ DBCS(日本語) を入れ→Enter→エコー欄に返ることを確認する。
//   ※型ごとの入力可否ルール（J は SBCS 不可 等）はフロント検証＝ web-ui の acceptsChar 単体テスト
//     （test/field-validate.test.ts）と verify-browser-dbcs.mjs（ブラウザ）で担保。
// DBCS を扱うためセッションは CCSID 1399。
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-input.mjs
import { Session5250 } from "@ts5250/tn5250";

const LIB = process.env.PUB400_LIB ?? "TESTLIB";
const log = (s) => process.stderr.write(s + "\n");
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const cmdField = (s) => { const e = s.fields.filter((f) => !f.protected); return e[e.length - 1]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectMenu() {
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
  const cf = cmdField(session.snapshot());
  session.setField({ index: cf.index }, `CALL ${LIB}/INPPGM`);
  const s1 = (await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs: 20000 })).screen;
  check("INPPGM を CALL してフィールド型テスト画面を表示", /FIELD TYPE TEST/.test(s1.cells[0].map((c) => c.char).join("")));

  // 4 欄の型（行で特定）: 3=NUM, 4=A, 5=O, 6=J
  const ed = s1.fields.filter((f) => !f.protected);
  const num = ed.find((f) => f.row === 3), a = ed.find((f) => f.row === 4);
  const o = ed.find((f) => f.row === 5), j = ed.find((f) => f.row === 6);
  check("NUM 欄が numeric", !!num?.numeric, `numeric=${num?.numeric}`);
  check("A 欄が SBCS（dbcsType 無し・非 numeric）", !!a && a.dbcsType === undefined && a.numeric === false);
  check("O 欄が dbcsType=open", o?.dbcsType === "open", `dbcsType=${o?.dbcsType}`);
  check("J 欄が dbcsType=pure", j?.dbcsType === "pure", `dbcsType=${j?.dbcsType}`);

  // 妥当値の往復: O=SBCS+DBCS 混在 / J=DBCS
  session.setField({ index: o.index }, "AB日");
  session.setField({ index: j.index }, "日本語");
  const s2 = (await session.sendAid("Enter", { timeoutMs: 20000 })).screen;
  const oEcho = s2.cells[4].map((c) => c.char).join(""); // row5
  const jEcho = s2.cells[5].map((c) => c.char).join(""); // row6
  log("O ECHO: " + oEcho.replace(/ +$/, ""));
  log("J ECHO: " + jEcho.replace(/ +$/, ""));
  check("O（open）に SBCS+DBCS 混在を入れて往復（AB日）", /AB.?日/.test(oEcho));
  check("J（pure）に DBCS(日本語) を入れて往復", /日本語/.test(jEcho));

  await session.sendAid("F3", { timeoutMs: 8000 }).catch(() => {});
} catch (e) {
  results.push(false); log("E2E ERROR: " + e.message);
} finally {
  await session?.disconnect();
}
const passed = results.filter(Boolean).length;
const ok = results.length > 0 && passed === results.length;
log(`\n${ok ? "OK — 入力ラウンドトリップ＋フィールド型" : "NG"} — ${passed}/${results.length} passed`);
process.exit(ok ? 0 : 1);
