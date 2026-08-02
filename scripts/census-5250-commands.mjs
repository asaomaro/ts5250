// 実機の**実際の画面が使う 5250 コマンド**を数える（国勢調査）。
//
// 問い（`.aidev/backlog/datastream-commands.md`）:
//   未実装のコマンドは `wtd-applier.ts` の default 節で**レコードの残りごと捨てられる**。
//   捨てた後ろに READ があると「待機中・ホストから応答がない」で固まる（QSH で 3 回目）。
//   では **実際に届くコマンドは何か**——推測で実装を増やす前に、実機に聞く。
//
// 数え方（**正確さの度合いを分けて出す**）:
//   1. **レコード先頭のコマンド**（ヘッダ 10 バイトの直後）— 位置が確定しているので**正確**
//   2. **実装が「未知」と判定したコマンド** — 実装そのものの判定なので**決定的**
//   3. レコード全体を素朴に走査した出現数 — WTD のデータ内の 0x04 も拾う**参考値**
//
// 実行: AS400_PASSWORD=... node scripts/census-5250-commands.mjs
import { readFileSync } from "node:fs";
import { Session5250, TcpTransport } from "@ts5250/tn5250";

const log = (s) => process.stderr.write(s + "\n");
const out = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = JSON.parse(readFileSync("connections.json", "utf8"));
const sys = cfg.systems.find((s) => s.name === "実機");
const password = process.env.AS400_PASSWORD;
if (!password) {
  out("AS400_PASSWORD が未設定です");
  process.exit(1);
}
/** 実機に登録済みの装置名（自動構成が無効なので新しい名前は使えない） */
const DEV_POOL = (process.env.CENSUS_DEVNAMES ?? "DEV1,WEBSF0,WEBSF1,WEBSF2,WEBSF3,WEBSF4").split(",");

const NAME = {
  0x02: "SAVE_SCREEN",
  0x03: "SAVE_PARTIAL_SCREEN",
  0x11: "WRITE_TO_DISPLAY",
  0x12: "RESTORE_SCREEN",
  0x13: "RESTORE_PARTIAL_SCREEN",
  0x20: "CLEAR_UNIT_ALTERNATE",
  0x21: "WRITE_ERROR_CODE",
  0x22: "WRITE_ERROR_CODE_WINDOW",
  0x23: "ROLL",
  0x40: "CLEAR_UNIT",
  0x42: "READ_INPUT_FIELDS",
  0x50: "CLEAR_FORMAT_TABLE",
  0x52: "READ_MDT_FIELDS",
  0x62: "READ_SCREEN",
  0x64: "READ_SCREEN_EXTENDED",
  0x66: "READ_SCREEN_TO_PRINT",
  0x72: "READ_IMMEDIATE",
  0x82: "READ_MDT_FIELDS_ALT",
  0x83: "READ_IMMEDIATE_ALT",
  0xf3: "WRITE_STRUCTURED_FIELD"
};

/** 調べる画面。**読み取り専用のものだけ**（相手は利用者の実機） */
const BATTERY = [
  { cmd: "STRSQL", exit: ["F3", "Enter"], note: "対話式 SQL（出力が流れる画面）" },
  { cmd: "DSPMSG", exit: ["F3"], note: "メッセージ表示" },
  { cmd: "WRKACTJOB", exit: ["F3"], note: "活動ジョブ（自動更新あり）" },
  { cmd: "WRKSYSSTS", exit: ["F3"], note: "システム状況（F5 更新）" },
  { cmd: "DSPJOBLOG", exit: ["F3", "Enter"], note: "ジョブログ（下端へ流れる）" },
  { cmd: "WRKSPLF", exit: ["F3"], note: "スプール一覧" },
  { cmd: "DSPLIBL", exit: ["F3"], note: "ライブラリー・リスト" },
  { cmd: "WRKOBJ OBJ(TESTLIB/*ALL)", exit: ["F3"], note: "オブジェクト一覧（サブファイル）" },
  { cmd: "STRPDM", exit: ["F3"], note: "PDM メニュー" },
  { cmd: "GO CMDIFS", exit: ["F3"], note: "コマンド・メニュー" },
  { cmd: "QSH", exit: ["F3"], note: "Qshell（0x03 を送ってくる。対照）" }
];

const records = [];
const warns = [];

async function connectOnce(dev) {
  const real = await TcpTransport.connect({ host: sys.host, port: sys.port ?? 23 });
  const wrapped = {
    start: () => real.start?.(),
    send: (d) => real.send(d),
    onData: (fn) =>
      real.onData((d) => {
        records.push({ at: records.length, data: Uint8Array.from(d), label: current });
        fn(d);
      }),
    onClose: (fn) => real.onClose(fn),
    onError: (fn) => real.onError?.(fn),
    close: () => real.close()
  };
  const s = await Session5250.connect({
    transport: wrapped,
    deviceName: dev,
    ccsid: sys.ccsid ?? 37,
    warn: (m) => warns.push({ m, label: current })
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

let current = "（接続）";
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

/** メインメニューへ戻す（F3 を数回。戻れなければ Enter で流す） */
async function backToMenu() {
  for (let i = 0; i < 6; i++) {
    const txt = rows(session.snapshot());
    if (txt.some((r) => r.includes("選択項目またはコマンド"))) return true;
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
  for (const item of BATTERY) {
    current = item.cmd;
    const snap = session.snapshot();
    const f = cmdField(snap);
    if (!f) {
      log(`${item.cmd}: コマンド行が見つからない`);
      await backToMenu();
      continue;
    }
    try {
      session.setField({ index: f.index }, item.cmd);
      await session.sendAid("Enter", { cursor: { row: f.row, col: f.col }, timeoutMs: 20000 });
    } catch (e) {
      log(`${item.cmd}: 応答が返らない（${e instanceof Error ? e.message : String(e)}）`);
    }
    await sleep(2000);
    // 画面の中で少し動かす（**流れる画面ほど ROLL の候補**）
    for (const key of ["PageDown", "PageDown", "PageUp"]) {
      try {
        await session.sendAid(key, { timeoutMs: 8000 });
      } catch {
        /* 使えない画面もある */
      }
      await sleep(600);
    }
    const head = rows(session.snapshot()).find((r) => r.trim()) ?? "";
    log(`${item.cmd}: ${head.slice(0, 60)}`);
    current = `${item.cmd}（退出）`;
    for (const key of item.exit) {
      try {
        await session.sendAid(key, { timeoutMs: 10000 });
      } catch {
        /* 退出キーが効かない画面もある */
      }
      await sleep(800);
    }
    await backToMenu();
  }
} catch (e) {
  log("ERROR " + (e instanceof Error ? e.message : String(e)));
  log(e?.stack ?? "");
} finally {
  session.disconnect();
}

// ---- 集計 ----
/** レコード先頭のコマンド（ヘッダ 10 バイトの直後）。位置が確定しているので正確 */
const firstCmd = new Map();
/** 参考: レコード全体の素朴な走査（WTD のデータ内の 0x04 も拾う） */
const naive = new Map();
const byLabel = new Map();

for (const rec of records) {
  const d = rec.data;
  if (d.length > 12 && d[10] === 0x04) {
    const c = d[11];
    firstCmd.set(c, (firstCmd.get(c) ?? 0) + 1);
    const set = byLabel.get(rec.label) ?? new Set();
    set.add(c);
    byLabel.set(rec.label, set);
  }
  for (let i = 10; i + 1 < d.length; i++) {
    if (d[i] === 0x04) naive.set(d[i + 1], (naive.get(d[i + 1]) ?? 0) + 1);
  }
}

const show = (m) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `    0x${c.toString(16).padStart(2, "0")} ${NAME[c] ?? "**未知**"}: ${n}`)
    .join("\n");

out(`\n==== レコード先頭のコマンド（正確・${records.length} レコード中） ====`);
out(show(firstCmd));

out("\n==== 画面ごとに先頭で見たコマンド ====");
for (const [label, set] of byLabel) {
  out(`  ${label}: ${[...set].map((c) => NAME[c] ?? `0x${c.toString(16)}`).join(", ")}`);
}

out("\n==== 実装が「未知」と判定したもの（決定的） ====");
const unknown = warns.filter((w) => w.m.includes("unknown command"));
out(unknown.length ? [...new Set(unknown.map((w) => `  ${w.label}: ${w.m}`))].join("\n") : "  なし");

out("\n==== 参考: 素朴な全走査（データ内の 0x04 も拾うので過大） ====");
out(show(naive));

out("\n==== その他の警告 ====");
const others = warns.filter((w) => !w.m.includes("unknown command"));
out(others.length ? [...new Set(others.map((w) => `  ${w.label}: ${w.m}`))].slice(0, 20).join("\n") : "  なし");
