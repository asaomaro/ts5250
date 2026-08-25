// 実機の TESTLIB に **EDTMSK（編集マスク）つき入力欄**の検証用表示ファイルを作る。
//
// **`EDTMSK` の `&` は「保護する桁」**——区切り（`/` `:` `-`）の桁に置く。ここを間違えて
// 数字の桁に `&` を置くと、`CRTDSPF` が **CPD7494 / CPD7520 でキーワードごと無視**するので、
// 「EDTMSK を付けたのに何も変わらない」という誤った観測になる（2026-07〜08 に実際に踏んだ。
// `.aidev/backlog/input-assist.md` の訂正を参照）。
//
// 正しく書くと、ホストは欄を**継続入力フィールド**（FCW `0x8601`/`0x8603`/`0x8602`＝先頭/中間/最終）に
// **分解して**送ってくる。区切りは保護された静的文字になり、打鍵は区間から区間へ渡っていく。
// 実測は `.aidev/backlog/input-assist.md`、実装は `feat/continued-entry-field`。
//
// 実行: AS400_PASSWORD=... node scripts/build-dttest.mjs
//
// ⚠ **接続先の引き方が古い**（`connections.json` を見るが、実機は `profiles.local.json` へ移った）。
// 2026-08-25 の 8 桁日付欄の追加では、ここが生成する DDS をそのまま**ホストサーバー経由**で
// `QDDSSRC(DTMDSPF)` へ入れ、`CRTDSPF` / `CRTBNDRPG` を掛けて作り直した（対話サインオンを
// 繰り返さないため。QMAXSIGN 配慮）。**DDS の中身はこのファイルが真実**で、実機の
// ソースメンバーと 1 行ずつ一致することを確認済み。
import { readFileSync, existsSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";

const LIB = process.env.AS400_LIB ?? "TESTLIB", DDSF = "QDDSSRC", RPGF = "QRPGLESRC";
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));

const put = (b, p, str) => { const a = b.split(""); for (let i = 0; i < str.length; i++) a[p - 1 + i] = str[i]; return a.join(""); };
const blank = () => " ".repeat(80);
const kwd = (kw) => put(put(blank(), 6, "A"), 45, kw).replace(/ +$/, "");
const rec = (n) => put(put(put(blank(), 6, "A"), 17, "R"), 19, n).replace(/ +$/, "");
const constant = (r, c, t) => put(put(put(put(blank(), 6, "A"), 39, String(r).padStart(3)), 42, String(c).padStart(3)), 45, `'${t}'`).replace(/ +$/, "");
/** 数値欄。`kw` は 45 桁のキーワード（複数行は配列で渡す） */
function numf(name, len, dec, usage, r, c, kw = []) {
  let l = put(put(blank(), 6, "A"), 19, name);
  l = put(l, 35 - String(len).length, String(len));
  l = put(l, 38 - String(dec).length, String(dec));
  l = put(put(put(l, 38, usage), 39, String(r).padStart(3)), 42, String(c).padStart(3));
  const kws = Array.isArray(kw) ? kw : [kw];
  if (kws[0]) l = put(l, 45, kws[0]);
  return [l.replace(/ +$/, ""), ...kws.slice(1).map((k) => kwd(k))];
}

/**
 * 検証したい構成。マスクは**編集後の桁数と同じ長さ**で書き、`&` は**区切りの桁**に置く
 * （`EDTCDE(Y)` は 6,0 を `nn/nn/nn`＝8 桁に編集するので、区切りは 3 桁目と 6 桁目）。
 * 対照（マスク無し）と、片方の区切りだけ保護した形も並べて、分解のされ方を見る。
 */
const CASES = [
  { nm: "DMA", lab: "Y + MSK 両方保護", f: (r) => numf("DMA", 6, 0, "B", r, 24, ["EDTCDE(Y)", "EDTMSK('  &  &  ')"]) },
  { nm: "DMB", lab: "Y のみ（対照）", f: (r) => numf("DMB", 6, 0, "B", r, 24, ["EDTCDE(Y)"]) },
  // **片方の区切りだけ保護**すると何区間になるか（2 区間か・3 区間か）を見る材料
  { nm: "DMC", lab: "Y + MSK 片方だけ保護", f: (r) => numf("DMC", 6, 0, "B", r, 24, ["EDTCDE(Y)", "EDTMSK('  &     ')"]) },
  { nm: "DTY", lab: "Y のみ（対照）", f: (r) => numf("DTY", 6, 0, "B", r, 24, ["EDTCDE(Y)"]) },
  { nm: "TMW", lab: "時刻 EDTWRD+MSK", f: (r) => numf("TMW", 6, 0, "B", r, 24, ["EDTWRD('  :  :  ')", "EDTMSK('  &  &  ')"]) },
  { nm: "TMO", lab: "時刻 EDTWRD のみ", f: (r) => numf("TMO", 6, 0, "B", r, 24, ["EDTWRD('  :  :  ')"]) },
  { nm: "SSN", lab: "SSN 3-2-4", f: (r) => numf("SSN", 9, 0, "B", r, 24, ["EDTWRD('   -  -    ')", "EDTMSK('   &  &    ')"]) },
  { nm: "PLN", lab: "素の 6,0（対照）", f: (r) => numf("PLN", 6, 0, "B", r, 24, []) },

  /**
   * **8 桁の日付欄（`9999/99/99`）**。利用者が実務で使う形はこちら
   * （6 桁の `EDTCDE(Y)` ではなく、西暦 4 桁＋月 2 桁＋日 2 桁）。
   *
   * `EDTWRD('    /  /  ')` は 10 桁（数字位置 4+2+2 ＝ 8 桁ぶん）。ただし**先頭が空白だと
   * ゼロ抑制が効いて値 0 のとき欄が丸ごと空白になり、`/` の骨組みが画面に出ない**。
   * 骨組みを出したままにするには編集ワードの先頭に `0`（ゼロ抑制の打ち切り）を置く
   * ——`D8Z` 以降がそれ。両方を並べて、**骨組みの有無で打鍵の挙動が変わるか**も見る。
   *
   * 行は 18〜22（既存 8 件は 3〜17 の奇数行を使う。DSPSIZ 既定の 24x80 に収める）。
   */
  { nm: "D8W", row: 18, lab: "8桁 EDTWRD のみ", f: (r) => numf("D8W", 8, 0, "B", r, 24, ["EDTWRD('    /  /  ')"]) },
  { nm: "D8Z", row: 19, lab: "8桁 EDTWRD(0止め)", f: (r) => numf("D8Z", 8, 0, "B", r, 24, ["EDTWRD('0   /  /  ')"]) },
  { nm: "D8M", row: 20, lab: "8桁 EDTWRD+MSK 両方保護", f: (r) => numf("D8M", 8, 0, "B", r, 24, ["EDTWRD('0   /  /  ')", "EDTMSK('    &  &  ')"]) },
  { nm: "D8B", row: 21, lab: "8桁 MSK 片方だけ保護", f: (r) => numf("D8B", 8, 0, "B", r, 24, ["EDTWRD('0   /  /  ')", "EDTMSK('    &     ')"]) },
  { nm: "D8Y", row: 22, lab: "8桁 EDTCDE(Y)", f: (r) => numf("D8Y", 8, 0, "B", r, 24, ["EDTCDE(Y)"]) },

  /**
   * **色と下線を付けた 8 桁の日付欄**（利用者の実画面と同じ形）。
   *
   * 区切り文字（`/`）は**保護された別の欄**として送られてくるので、
   *   - 色: 区間の色が区切りの桁で既定色（緑）に戻っていないか
   *   - 下線: 区切りの下線が入力欄の下線と 1 本に繋がっているか
   * を見るには、**既定色・下線無しでない**欄が要る（素の欄では差が出ない）。
   */
  { nm: "D8U", row: 23, lab: "8桁 MSK + 色 + 下線", f: (r) => numf("D8U", 8, 0, "B", r, 24, ["EDTWRD('0   /  /  ')", "EDTMSK('    &  &  ')", "COLOR(WHT)", "DSPATR(UL)"]) }
];

const head = () => [rec("DTMR"), kwd("CA03(03)"), constant(1, 3, "DATE / TIME MASK TEST"), constant(1, 50, "F3=exit")];
const ddsOne = (c) => [rec("DTMR"), kwd("CA03(03)"), ...c.f(3)];
function ddsFor(cases) {
  const body = head();
  cases.forEach((c, i) => {
    // 行は明示指定を優先する（8 桁の日付欄は 24 行に収めるため 1 行刻みで並べる）
    const r = c.row ?? 3 + i * 2;
    body.push(constant(r, 3, c.nm)); // **英数字のみ**（日本語だと INSERT が長さ超過する。実測）
    body.push(...c.f(r));
  });
  return body;
}

async function run(session, cmd, timeoutMs = 30000) {
  const s = session.snapshot();
  const cf = s.fields.filter((f) => !f.protected).slice(-1)[0];
  session.setField({ index: cf.index }, cmd);
  await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs });
  await sleep(500);
  return session.snapshot();
}
const runSql = (session, sql) => run(session, `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`);
function insertSrc(alias, line) {
  const sql = `INSERT INTO ${LIB}/${alias} (SRCDTA) VALUES('${line.replace(/'/g, "''")}')`;
  return `RUNSQL SQL('${sql.replace(/'/g, "''")}') COMMIT(*NONE)`;
}
async function injectMember(session, srcf, mbr, alias, lines) {
  await run(session, `RMVM FILE(${LIB}/${srcf}) MBR(${mbr})`);
  await run(session, `ADDPFM FILE(${LIB}/${srcf}) MBR(${mbr}) SRCTYPE(${srcf === DDSF ? "DSPF" : "RPGLE"})`);
  await runSql(session, `DROP ALIAS ${LIB}/${alias}`);
  await runSql(session, `CREATE ALIAS ${LIB}/${alias} FOR ${LIB}/${srcf}(${mbr})`);
  for (const l of lines) await run(session, insertSrc(alias, l));
}
async function connectOnce(sys, password, dev) {
  const s = await Session5250.connect({
    host: sys.host, port: sys.port ?? 23, ccsid: sys.ccsid ?? 37, screenSize: "27x132",
    deviceName: dev, user: sys.signon.user, password, warn: () => {}
  });
  await sleep(1500);
  const inputs = s.snapshot().fields.filter((f) => !f.protected);
  s.setField({ index: inputs[0].index }, sys.signon.user);
  s.setField({ index: inputs[1].index }, password);
  await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
  await sleep(800);
  for (let i = 0; i < 8; i++) {
    const snap = s.snapshot();
    const txt = rows(snap);
    if (txt.some((r) => r.includes("選択項目またはコマンド") || r.includes("メインメニュー"))) return s;
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = snap.fields.filter((x) => !x.protected).slice(-1)[0];
      s.setField({ index: f.index }, "90");
      await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else await s.sendAid("Enter", { timeoutMs: 10000 });
    await sleep(1000);
  }
  s.disconnect();
  throw new Error("no command screen");
}
async function connectHost(sys, password) {
  const pool = ["WEBSF0", "WEBSF1", "WEBSF2", "WEBSF3", "WEBSF4"];
  let last;
  for (let i = 0; i < 12; i++) {
    const dev = pool[i % pool.length];
    try { return await connectOnce(sys, password, dev); }
    catch (e) { last = e; process.stderr.write(`connect retry ${i + 1} (${dev}): ${e.message}\n`); await sleep(7000); }
  }
  throw last;
}

// **接続先は環境変数を優先する。** `connections.json` は古い検証用の設定で、実機が
// 載っていないことがある（実際に `AS400_SYSTEM` の名前が無く落ちた）。名前で見つからなければ
// `AS400_HOST` / `AS400_USER` から組み立てる（他の build-*.mjs と同じ受け取り方）。
const conns = existsSync("connections.json")
  ? JSON.parse(readFileSync("connections.json", "utf8"))
  : { systems: [] };
const sys =
  conns.systems.find((s) => s.name === (process.env.AS400_SYSTEM ?? "AS400")) ??
  (process.env.AS400_HOST
    ? {
        host: process.env.AS400_HOST,
        port: 23,
        ccsid: Number(process.env.AS400_CCSID ?? 930),
        signon: { user: process.env.AS400_USER }
      }
    : undefined);
if (!sys) { log("接続先が見つかりません（AS400_HOST か connections.json を設定してください）"); process.exit(1); }
const password = process.env.AS400_PASSWORD;
if (!password) { log("AS400_PASSWORD が未設定です"); process.exit(1); }
const session = await connectHost(sys, password);
let failed = 0;
try {
  await run(session, `ADDLIBLE ${LIB}`);
  await run(session, `CRTSRCPF FILE(${LIB}/${DDSF}) RCDLEN(92)`);
  await run(session, `CRTSRCPF FILE(${LIB}/${RPGF}) RCDLEN(92)`);

  async function tryCompile(dds, note) {
    await injectMember(session, DDSF, "DTMDSPF", "DTMDA", dds);
    await run(session, `DLTF FILE(${LIB}/DTMDSPF)`);
    const s = await run(session, `CRTDSPF FILE(${LIB}/DTMDSPF) SRCFILE(${LIB}/${DDSF}) SRCMBR(DTMDSPF) GENLVL(29)`, 60000);
    const msg = rows(s).slice(-3).map((x) => x.trim()).filter(Boolean).join(" / ");
    const ok = /作成された|created/i.test(msg);
    log(`  ${note.padEnd(20)} : ${ok ? "OK（書ける）" : "NG（書けない）"}`);
    if (!ok) log(`      ${msg.slice(-140)}`);
    return ok;
  }

  // 単独コンパイルは切り分け用。結果が分かったあとの再実行では飛ばせる（実機時間の節約）
  const okCases = [];
  if (process.env.DT_SKIP_PROBE) {
    log("########## 単独コンパイルは省略（DT_SKIP_PROBE） ##########");
    okCases.push(...CASES);
  } else {
    log("########## 単独コンパイル（どの構成が通るか） ##########");
    for (const c of CASES) if (await tryCompile(ddsOne(c), c.lab)) okCases.push(c);
  }
  log(`\n【結果】書ける: ${okCases.map((c) => c.lab).join(" / ") || "なし"}`);
  log(`【結果】書けない: ${CASES.filter((c) => !okCases.includes(c)).map((c) => c.lab).join(" / ") || "なし"}`);
  if (okCases.length === 0) throw new Error("通る構成が 1 つも無い");

  log("\n########## 通った構成を 1 レコードに束ねる ##########");
  if (!(await tryCompile(ddsFor(okCases), "まとめ"))) failed++;

  const RPG = [
    "**free",
    // **ライブラリーを名指しする**（`extdesc` はコンパイル時の記述、`extfile` は実行時のファイル）。
    // *LIBL 任せだと `ADDLIBLE` の効かないコンパイル・ジョブで RNF2120 になる（実際に踏んだ）。
    `dcl-f DTMDSPF workstn extdesc('${LIB}/DTMDSPF') extfile(*extdesc);`,
    "dou *in03;",
    "  exfmt DTMR;",
    "enddo;",
    "*inlr = *on;",
    "return;"
  ];
  await injectMember(session, RPGF, "DTMPGM", "DTMRA", RPG);
  await run(session, `DLTPGM PGM(${LIB}/DTMPGM)`);
  const s = await run(session, `CRTBNDRPG PGM(${LIB}/DTMPGM) SRCFILE(${LIB}/${RPGF}) SRCMBR(DTMPGM)`, 60000);
  const m = rows(s).slice(-2).map((x) => x.trim()).filter(Boolean).join(" / ");
  log("CRTBNDRPG: " + m.slice(-90));
  if (!/入れられました|created/i.test(m)) failed++;
} catch (e) {
  log("BUILD ERROR: " + e.message);
  failed++;
} finally {
  await session.disconnect();
}
process.exit(failed === 0 ? 0 : 1);
