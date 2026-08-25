// **CA キー（コマンド・アテンション）では欄データを送らない**ことを実機で確かめる。
//
// どのキーが CA かは **SOH オーダー（0x01）のヘッダ**で届く——本体 5〜7 バイト目の 24 ビットが
// F24〜F1 に対応し、立っているキーでは欄データを送らない（GNU tn5250 `send_data_for_aid_key`、
// tn5250j `dataIncluded[]`）。当方は SOH を読み捨てていたため、F12 で打鍵した値まで送っていた
// ——「F12 で取り消したのに反映される」型の事故になる。
//
// 検証資材は scripts/build-keytest.mjs が作る <LIB>/KEYDSPF ＋ KEYPGM
// （`CA03` / `CA12` ＝ データを送らない、`CF06` ＝ 送る）。KEYPGM は受け取った値を画面へ返す。
//
// **描画は関係ない**ので core（`Session5250`）で直に見る。
//   npm run build
//   node --env-file=.env --env-file=.env.verify scripts/verify-aid-data-mask.mjs
// 任意: VERIFY_DEBUG=1（画面と生バイトを出す）
import { Session5250 } from "@ts5250/tn5250";

const LIB = process.env.AS400_LIB ?? "TESTLIB";
const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
if (!host || !user || !password) { process.stderr.write("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で\n"); process.exit(2); }

const log = (s) => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, ""));
let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; log(`  PASS ${msg}`); } else { fail++; log(`  FAIL ${msg}`); } };

// ---- 生レコードから SOH ヘッダを拾う（core の解釈に依存させない） ----
const ESC = 0x04, CMD_WTD = 0x11;
const O = { SOH: 0x01, RA: 0x02, EA: 0x03, TD: 0x10, SBA: 0x11, WEA: 0x12, IC: 0x13, MC: 0x14, WDSF: 0x15, X1C: 0x1c, SF: 0x1d };
function scan(rec) {
  const sohs = [], fcws = [];
  let i = 0;
  while (i < rec.length) {
    if (rec[i] !== ESC) { i++; continue; }
    const cmd = rec[i + 1];
    i += 2;
    if (cmd !== CMD_WTD) continue;
    i += 2;
    while (i < rec.length && rec[i] !== ESC) {
      const b = rec[i];
      switch (b) {
        case O.SBA: case O.IC: case O.MC: i += 3; break;
        case O.RA: i += 4; break;
        case O.EA: { const len = rec[i + 3]; i += 4 + Math.max(0, len - 1); break; }
        case O.SOH: { const len = rec[i + 1]; sohs.push([...rec.slice(i + 2, i + 2 + len)]); i += 2 + len; break; }
        case O.TD: { const len = (rec[i + 1] << 8) | rec[i + 2]; i += 3 + len; break; }
        case O.WEA: i += 2; break;
        case O.X1C: i += 1; break;
        case O.WDSF: { const len = (rec[i + 1] << 8) | rec[i + 2]; i += 1 + len; break; }
        case O.SF: {
          let p = i + 1;
          if (rec[p] >= 0x20 && rec[p] <= 0x3f) { i = p + 3; break; }
          p += 2;
          while (p + 1 < rec.length && (rec[p] & 0xc0) === 0x80) { fcws.push((rec[p] << 8) | rec[p + 1]); p += 2; }
          i = p + 3;
          break;
        }
        default: i += 1; break;
      }
    }
  }
  return { sohs, fcws };
}
/** SOH の 24 ビット（本体 5〜7 バイト目）を F1..F24 の一覧へ */
function keysOfMask(body) {
  const m = body.slice(4, 7);
  if (m.length < 3) return [];
  const out = [];
  for (let n = 1; n <= 24; n++) {
    const byte = m[2 - Math.floor((n - 1) / 8)];
    if ((byte >> ((n - 1) % 8)) & 1) out.push(`F${n}`);
  }
  return out;
}

const captured = [];
const session = await Session5250.connect({
  host, port: 23, ccsid: 930, screenSize: "24x80", user, password, traceRecords: true,
  warn: (w) => {
    const m = /^rx record \(\d+ bytes\): (.+)$/.exec(w);
    if (m) captured.push(Uint8Array.from(m[1].split(" ").map((h) => parseInt(h, 16))));
    else if (process.env.VERIFY_DEBUG === "1") err("WARN: " + w);
  }
});
await sleep(1500);

const text = () => rows(session.snapshot());
const inputs = () => session.snapshot().fields.filter((f) => !f.protected);
async function toCommandLine() {
  for (let i = 0; i < 10; i++) {
    const t = text();
    if (t.some((r) => r.includes("選択項目またはコマンド") || r.includes("コマンドを入力"))) return true;
    const inp = inputs();
    if (t.some((r) => r.includes("サイン・オン")) && inp.length >= 2) {
      session.setField({ index: inp[0].index }, user);
      session.setField({ index: inp[1].index }, password);
    } else if (t.some((r) => r.includes("回復")) && inp[0]) {
      session.setField({ index: inp.slice(-1)[0].index }, "90");
    }
    await session.sendAid("Enter", { timeoutMs: 20000 }).catch(() => {});
    await sleep(1200);
  }
  return false;
}
async function cmd(line) {
  const cf = inputs().slice(-1)[0];
  session.setField({ index: cf.index }, line);
  await session.sendAid("Enter", { cursor: { row: cf.row, col: cf.col }, timeoutMs: 30000 });
  await sleep(700);
}
/** 「HOST RECEIVED」の欄をテキストから拾う（出力欄はセルとして出る） */
const received = () => {
  const t = text();
  const pick = (row) => (t[row - 1] ?? "").slice(29, 34).trim();
  return { key: pick(11), in1: pick(13), in2: pick(15), in3: pick(17) };
};
/** 3 つの入力欄へ打つ（欄は画面順） */
function typeAll(a, b, c) {
  const ins = inputs();
  session.setField({ index: ins[0].index }, a);
  session.setField({ index: ins[1].index }, b);
  session.setField({ index: ins[2].index }, c);
}

try {
  check(await toCommandLine(), "コマンド行まで進む");
  captured.length = 0;
  await cmd(`CALL ${LIB}/KEYPGM`);
  const scr = text();
  if (process.env.VERIFY_DEBUG === "1") err("---- 画面 ----\n" + scr.slice(0, 22).join("\n"));
  check(scr.some((r) => r.includes("KEYPGM AID/CURSOR TEST")), "KEYPGM のテスト画面が出ている");

  // ---- SOH のマスク（ホストが何を送ってきたか。core の解釈に依存させない） ----
  const found = captured.map(scan).find((s) => s.sohs.length > 0);
  const body = found?.sohs[0] ?? [];
  const keys = keysOfMask(body);
  log(`\n### SOH（ホストの申告）`);
  log(`  本体=[${body.map((b) => b.toString(16).padStart(2, "0")).join(" ")}] → 欄データを送らないキー: ${keys.join(" ") || "(無し)"}`);
  check(keys.includes("F3") && keys.includes("F12"), `CA キー（F3・F12）が立っている（実際 ${keys.join(" ")}）`);
  check(!keys.includes("F6"), "CF キー（F6）は立っていない");

  // ---- ① CA キー（F12）では欄データが届かない ----
  log(`\n### ① CA キー（F12）`);
  typeAll("AAA", "BBB", "CCC");
  await session.sendAid("F12", { timeoutMs: 20000 });
  await sleep(800);
  const r12 = received();
  log(`  HOST RECEIVED: KEY=${JSON.stringify(r12.key)} IN1=${JSON.stringify(r12.in1)} IN2=${JSON.stringify(r12.in2)} IN3=${JSON.stringify(r12.in3)}`);
  check(r12.key === "F12", "F12 がホストへ届く");
  check(r12.in1 === "" && r12.in2 === "" && r12.in3 === "", `CA キーでは欄データを送らない（実際 ${JSON.stringify([r12.in1, r12.in2, r12.in3])}）`);

  // ---- ② CF キー（F6）では届く（対照） ----
  log(`\n### ② CF キー（F6・対照）`);
  typeAll("DDD", "EEE", "FFF");
  await session.sendAid("F6", { timeoutMs: 20000 });
  await sleep(800);
  const r6 = received();
  log(`  HOST RECEIVED: KEY=${JSON.stringify(r6.key)} IN1=${JSON.stringify(r6.in1)} IN2=${JSON.stringify(r6.in2)} IN3=${JSON.stringify(r6.in3)}`);
  check(r6.key === "F06", "F6 がホストへ届く");
  check(r6.in1 === "DDD" && r6.in2 === "EEE" && r6.in3 === "FFF", `CF キーでは欄データを送る（実際 ${JSON.stringify([r6.in1, r6.in2, r6.in3])}）`);

  // ---- ③ Enter（対照。マスクの対象外） ----
  log(`\n### ③ Enter（対照）`);
  typeAll("GGG", "HHH", "III");
  await session.sendAid("Enter", { timeoutMs: 20000 });
  await sleep(800);
  const rE = received();
  log(`  HOST RECEIVED: KEY=${JSON.stringify(rE.key)} IN1=${JSON.stringify(rE.in1)} IN2=${JSON.stringify(rE.in2)} IN3=${JSON.stringify(rE.in3)}`);
  check(rE.key === "ENT" && rE.in1 === "GGG", `Enter では欄データを送る（実際 ${JSON.stringify([rE.key, rE.in1])}）`);

  await session.sendAid("F3", { timeoutMs: 15000 }).catch(() => {});
  await sleep(400);
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e));
} finally {
  await session.disconnect();
}

log(`\n${fail === 0 ? "すべて PASS" : `FAIL ${fail} 件`}（PASS ${pass}）`);
process.exit(fail === 0 ? 0 : 1);
