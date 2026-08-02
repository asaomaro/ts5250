// 表示属性の実機 E2E 検証。<LIB> の 2 プログラムを CALL し、エミュレーターの属性デコードを確認する。
//   - CLRTPGM: 文字色 7 種・反転(背景)・下線・高輝度・桁区切り・点滅・DBCS(日本語)
//   - INLPGM : インライン色制御（フィールドデータ中に埋め込んだ属性バイトで桁ごとに色切替）
// DBCS を出すためセッションは CCSID 1399。
// 実行: node --env-file=.env scripts/verify-attributes.mjs
//   前提: <LIB>（既定 MYLIB）に CLRTPGM/INLPGM が存在すること（無ければ build-attrtest.mjs を先に）。
import { Session5250 } from "@ts5250/tn5250";

const LIB = process.env.PUB400_LIB ?? "MYLIB";
const log = (s) => process.stderr.write(s + "\n");
const results = [];
const check = (name, cond, detail = "") => { results.push(!!cond); log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const cmdField = (s) => { const e = s.fields.filter((f) => !f.protected); return e[e.length - 1]; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connectMenu() {
  // PUB400 は切断後もデバイスをしばらく保持するため、リトライごとにデバイス名を変える
  // （同名再接続は "closed during negotiation" になりやすい）。
  const base = process.env.PUB400_DEVNAME ?? "WEBATV";
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
  const run = async (cmd) => {
    const cf = cmdField(session.snapshot());
    session.setField({ index: cf.index }, cmd);
    return (await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs: 20000 })).screen;
  };

  // ===== CLRTPGM: フィールド単位の属性＋DBCS =====
  let snap = await run(`CALL ${LIB}/CLRTPGM`);
  let at = (r, c) => snap.cells[r - 1][c - 1];
  const title = snap.cells[0].map((c) => c.char).join("");
  check("CLRTPGM を CALL して属性テスト画面を表示", /ATTR TEST/.test(title), title.trim().slice(0, 30));

  // 文字色 7 種
  const colors = [[3, 2, "green"], [3, 20, "white"], [3, 40, "red"], [3, 60, "turquoise"], [4, 2, "yellow"], [4, 20, "pink"], [4, 40, "blue"]];
  for (const [r, c, want] of colors) check(`色 (${r},${c}) = ${want}`, at(r, c).color === want, `got ${at(r, c).color}`);

  // 属性（背景=反転 / 下線 / 高輝度→white / 桁区切り / 点滅）
  check("反転(背景) RVS(6,2) reverse", at(6, 2).reverse === true);
  check("下線 UL(6,20) underline", at(6, 20).underline === true);
  check("高輝度 HI(6,40) → white", at(6, 40).color === "white", `got ${at(6, 40).color}`);
  check("桁区切り CS(7,20) columnSeparator", at(7, 20).columnSeparator === true);
  check("点滅 REDBL(8,2) blink+red", at(8, 2).blink === true && at(8, 2).color === "red", `blink=${at(8, 2).blink} color=${at(8, 2).color}`);

  // DBCS（row9: SO@8, 日@9(lead)+tail, 本@11, 語@13。全角=2桁幅・桁ズレ無し）
  const row9 = snap.cells[8];
  check("DBCS SO(9,8) kind=so", row9[7].kind === "so");
  check("DBCS 日(9,9) lead", row9[8].kind === "dbcs-lead" && row9[8].char === "日", `char=${row9[8].char} kind=${row9[8].kind}`);
  check("DBCS 日 tail(9,10)", row9[9].kind === "dbcs-tail");
  check("DBCS 本(9,11) lead", row9[10].kind === "dbcs-lead" && row9[10].char === "本");
  check("DBCS 語(9,13) lead", row9[12].kind === "dbcs-lead" && row9[12].char === "語");
  await session.sendAid("F3", { timeoutMs: 8000 }).catch(() => {});

  // ===== INLPGM: インライン色制御（データ中の埋め込み属性バイト） =====
  snap = await run(`CALL ${LIB}/INLPGM`);
  at = (r, c) => snap.cells[r - 1][c - 1];
  check("INLPGM を CALL してインライン色画面を表示", /INLINE ATTR TEST/.test(snap.cells[0].map((c) => c.char).join("")));
  // (3,2)=埋め込み属性バイト（attr 桁・空白）、以降のセグメントが指定色に切り替わる
  check("インライン (3,2) 埋め込み属性=attr桁", at(3, 2).kind === "attr");
  const inl = [[3, "red", "R"], [7, "green", "G"], [11, "white", "W"], [15, "pink", "P"], [19, "blue", "B"]];
  for (const [c, color, ch] of inl) check(`インライン (3,${c}) = ${color}`, at(3, c).color === color && at(3, c).char === ch, `got ${at(3, c).color}/${at(3, c).char}`);
  await session.sendAid("F3", { timeoutMs: 8000 }).catch(() => {});
} catch (e) {
  results.push(false); log("E2E ERROR: " + e.message);
} finally {
  await session?.disconnect();
}
const passed = results.filter(Boolean).length;
const ok = results.length > 0 && passed === results.length;
log(`\n${ok ? "OK" : "NG"} — ${passed}/${results.length} passed`);
process.exit(ok ? 0 : 1);
