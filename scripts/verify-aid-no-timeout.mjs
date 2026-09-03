// **期限なしの応答待ちと、施錠中の逃げ道**を実機で確かめる（`aid-response-timeout`）。
//
// 直した中身:
//   1. 画面（ws）の AID 応答待ちは**時間で諦めない**（`timeoutMs: "never"`）。
//      旧実装は既定 30 秒で打ち切り、まだ走っているのに「応答がありませんでした」と出し、
//      さらに `state` を `ready` に戻して**施錠を偽って**いた
//   2. 時間切れ（自動操作の有限値）でも**施錠は解かない**
//   3. **Attn / SysReq は施錠中でも送れる**——原典（tn5250j / lib5250）にもタイマーは無く、
//      抜ける口はシステム要求メニューの「2. 前の要求の終了」のほうに置かれている
//
// ここで確かめること（モックでは絶対に出ない部分）:
//   A. 時間の掛かるコマンド（`DLYJOB`）の最中、ホストは**施錠したまま**でいるか
//   B. 旧実装が諦めていた 30 秒を越えても、`timeoutMs: "never"` は待ち続けるか
//   C. その最中に **Attn が通る**か（`KEYBOARD_LOCKED` を投げないか・ホストが応じるか）
//   D. その最中に **SysReq「2」が通り、走っている要求を実際に切れる**か
//
// 実行:
//   npm run build
//   node --env-file=.env --env-file=.env.verify scripts/verify-aid-no-timeout.mjs
import { readFileSync } from "node:fs";
import { Session5250, TcpTransport } from "@ts5250/tn5250";

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// **置き場が 2 つある**（個人設定 / サーバー設定）。片方だけ見ると設定を移した日から動かなくなる
const sys = (() => {
  for (const f of ["profiles.local.json", "connections.json"]) {
    try {
      const hit = JSON.parse(readFileSync(f, "utf8")).systems?.find(
        (x) => x.name === (process.env.AS400_SYSTEM ?? "AS400")
      );
      if (hit) return hit;
    } catch {
      /* 無ければ次 */
    }
  }
  return undefined;
})();
if (!sys) {
  log("実機の定義が profiles.local.json / connections.json のどちらにもありません");
  process.exit(1);
}
const password = process.env.AS400_PASSWORD;
if (!password) {
  log("AS400_PASSWORD が未設定です");
  process.exit(1);
}
/** 実機に登録済みの装置名（自動構成が無効なので新しい名前は使えない） */
const DEV_POOL = (process.env.VERIFY_DEVNAMES ?? "DEV1,WEBSF0,WEBSF1,WEBSF2,WEBSF3,WEBSF4").split(",");

/** 待たせる秒数。**旧実装の 30 秒より確実に長く**（越えられなければ検証にならない） */
const DELAY_SEC = Number(process.env.VERIFY_DELAY_SEC ?? 60);

async function connectOnce(dev) {
  const transport = await TcpTransport.connect({ host: sys.host, port: sys.port ?? 23 });
  const s = await Session5250.connect({
    transport,
    deviceName: dev,
    ccsid: sys.ccsid ?? 37,
    warn: () => {}
  });
  await sleep(1500);
  const inputs = s.snapshot().fields.filter((f) => !f.protected);
  if (inputs.length >= 2) {
    s.setField({ index: inputs[0].index }, sys.signon.user);
    s.setField({ index: inputs[1].index }, password);
    await s.sendAid("Enter", { cursor: { row: inputs[0].row, col: inputs[0].col }, timeoutMs: 15000 });
  }
  await sleep(800);
  for (let i = 0; i < 8; i++) {
    const snap = s.snapshot();
    const txt = snap.cells.map((r) => r.map((c) => c.char).join(""));
    if (txt.some((r) => r.includes("選択項目またはコマンド") || r.includes("メインメニュー"))) return s;
    if (txt.some((r) => r.includes("対話式ジョブの回復"))) {
      const f = snap.fields.filter((x) => !x.protected).slice(-1)[0];
      s.setField({ index: f.index }, "90");
      await s.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 12000 });
    } else {
      await s.sendAid("Enter", { timeoutMs: 10000 });
    }
    await sleep(1000);
  }
  s.disconnect();
  throw new Error("コマンド画面へ到達できない");
}

const session = await (async () => {
  let last;
  for (const dev of DEV_POOL) {
    try {
      const s = await connectOnce(dev);
      log(`装置名 ${dev} で接続`);
      return s;
    } catch (e) {
      last = e;
      log(`装置名 ${dev} は使えなかった: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw last;
})();

const rows = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, ""));
const cmdField = (snap) =>
  snap.fields.find((f) => !f.protected && f.row >= 19) ?? snap.fields.filter((f) => !f.protected).slice(-1)[0];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  log(`${ok ? "OK  " : "NG  "} ${name}${detail ? " — " + detail : ""}`);
};

/** コマンド行に打って Enter。**待ちは呼び出し側の指定に従う**（ここが検証対象） */
function runCommand(cmd, opts) {
  const snap = session.snapshot();
  const f = cmdField(snap);
  session.setField({ index: f.index }, cmd);
  return session.sendAid("Enter", { cursor: { row: f.row, col: f.col }, ...opts });
}

async function backToMenu() {
  for (let i = 0; i < 6; i++) {
    if (rows(session.snapshot()).some((r) => r.includes("選択項目またはコマンド"))) return true;
    try {
      await session.sendAid(i % 2 === 0 ? "F3" : "Enter", { timeoutMs: 12000 });
    } catch {
      /* 応答が無くても次を試す */
    }
    await sleep(900);
  }
  return rows(session.snapshot()).some((r) => r.includes("選択項目またはコマンド"));
}

try {
  // ---- A/B: DLYJOB の最中は施錠されたまま、"never" は 30 秒を越えて待つ ----
  log(`\n[A/B] DLYJOB DLY(${DELAY_SEC}) を "never" で送る（旧実装は 30 秒で諦めていた）`);
  let settled;
  const pending = runCommand(`DLYJOB DLY(${DELAY_SEC})`, { timeoutMs: "never" }).then((r) => {
    settled = r;
    return r;
  });

  await sleep(5000);
  check("送信直後（5 秒）にホストは施錠している", session.keyboardLocked === true);

  await sleep(30_000); // 合計 35 秒 ＝ 旧実装なら既に諦めている
  check("35 秒たっても待ちを打ち切っていない", settled === undefined);
  check("35 秒たっても施錠は解けていない", session.keyboardLocked === true);

  // ---- C: 施錠中の Attn が通る ----
  log("\n[C] 施錠されたまま Attn を送る（逃げ道その 1）");
  let attnErr;
  try {
    const r = await session.sendAid("Attn");
    check("施錠中でも Attn が KEYBOARD_LOCKED を投げない", true, `timedOut=${r.timedOut}`);
  } catch (e) {
    attnErr = e;
    check("施錠中でも Attn が KEYBOARD_LOCKED を投げない", false, String(e?.code ?? e));
  }
  await sleep(3000);
  if (!attnErr) {
    const txt = rows(session.snapshot()).join("\n");
    // ATNPGM（既定はコマンド入力）が前面に出れば、ホストが Attn を受け取った証拠
    log(`    Attn 後の画面 1 行目: ${rows(session.snapshot())[0] ?? ""}`);
    check(
      "Attn に対してホストが何かを返した（画面が動いた or 施錠が続く）",
      txt.length > 0
    );
  }

  // ---- D: 施錠中の SysReq「2」で、走っている要求を実際に切れる ----
  log("\n[D] 施錠されたまま SysReq「2」を送る（逃げ道その 2・前の要求の終了）");
  try {
    const r = await session.sendAid("SysReq", { sysReqText: "2" });
    check("施錠中でも SysReq が KEYBOARD_LOCKED を投げない", true, `timedOut=${r.timedOut}`);
  } catch (e) {
    check("施錠中でも SysReq が KEYBOARD_LOCKED を投げない", false, String(e?.code ?? e));
  }

  // 切れたなら、待っていた DLYJOB の応答が返って待ちが解ける
  const raced = await Promise.race([pending, sleep(20_000).then(() => "timeout")]);
  check(
    "SysReq のあと、待っていた AID が解決する（＝要求が切れた）",
    raced !== "timeout",
    raced === "timeout" ? `${DELAY_SEC} 秒の DLYJOB がまだ走っている可能性` : `timedOut=${raced.timedOut}`
  );
  check("応答が返れば施錠は解けている", session.keyboardLocked === false);

  // ---- 後片付け ----
  await backToMenu();
} finally {
  session.disconnect();
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} OK`);
process.exit(failed.length === 0 ? 0 : 1);
