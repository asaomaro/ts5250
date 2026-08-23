// **3270 セッションがアイドルを越えられるか**を実機で測る（backlog `hostserver.md`）。
//
// ⚠ **「IBM i は 3270 を受けない」は誤り。** 実機は 3270 を受ける
// （`.aidev/backlog/tn3270-ibmi.md` / `verify-3270-keys.mjs`）。
// **プリンターが 15 分で死んだのと同じホスト・同じ 23 番**なので、
// 経路条件が揃った状態で測れる——ここが VT（pub400・別経路）と違う。
//
// ⚠ **ホストの `QINACTITV` と混ぜないこと。** 実機は 10 分。
// ただし 5250 表示では 13 分でも 30 分でも発火しなかった（実測）。
//
// 実行:
//   IDLE_MIN=30 node --env-file=.env --env-file=.env.verify scripts/diag-3270-idle.mjs                  # 実機
//   HOSTPRE=PUB400 IDLE_MIN=30 node --env-file=.env --env-file=.env.verify scripts/diag-3270-idle.mjs   # pub400
//
// ⚠ **pub400 で測る意味**: 同じ pub400 で **5250 表示は 30 分を越え、VT は死ぬ**。
// 3270 がどちらに付くかで「非 5250 が死ぬ」のか「VT だけ」なのかが割れる。
import { appendFileSync } from "node:fs";
import { Tn3270Session } from "@ts5250/tn3270";

const PRE = process.env.HOSTPRE ?? "AS400";
const host = process.env[`${PRE}_HOST`];
if (!host) {
  process.stderr.write(`${PRE}_HOST が要ります\n`);
  process.exit(2);
}
const IDLE_MIN = Number(process.env.IDLE_MIN ?? 30);
const OUT = process.env.LOGFILE;
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  process.stdout.write(line + "\n");
  if (OUT) appendFileSync(OUT, line + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = new Tn3270Session({ host, port: 23, ccsid: Number(process.env[`${PRE}_CCSID`] ?? (PRE === "PUB400" ? 37 : 930)) });
const lines = () => s.snapshot().cells.map((r) => r.map((c) => c.char).join("").replace(/\s+$/u, ""));
const head = () => lines().find((t) => t.trim() !== "")?.trim().slice(0, 50) ?? "(空)";

/**
 * **受信を数える。** サインオン画面で Enter を押すと**同じ画面が返る**ので、
 * 「画面が変わったか」では往復を検知できない（一度これで測り損ねた）。
 * `screen` イベントの到着そのものを見る。
 */
let screens = 0;
s.on("screen", () => {
  screens += 1;
});

let closed;
s.on("close", (r) => {
  closed = r ?? "（理由なし）";
  log(`  **close が届いた**: ${closed}`);
});

/**
 * 生きているかを見る。**受信の到着**で判定する（画面の変化ではない）。
 */
async function alive(waitMs) {
  const before = screens;
  const t0 = Date.now();
  try {
    // `send(aidKey)` が 3270 の送信口（`sendKey` ではない）
    s.send("Enter");
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: String(e?.message ?? e) };
  }
  while (Date.now() - t0 < waitMs) {
    await sleep(500);
    if (screens > before) return { ok: true, ms: Date.now() - t0 };
  }
  return { ok: false, ms: Date.now() - t0 };
}

try {
  await s.connect();
  await sleep(2500);
  if (lines().every((l) => l.trim() === "")) throw new Error("画面が来ていない");
  log(`接続できた: ${head()}`);

  const c = await alive(20_000);
  log(`対照: 応答あり=${c.ok} / ${c.ms}ms${c.err ? ` （${c.err}）` : ""}`);
  if (!c.ok) throw new Error("アイドル前から応答が無い（前提が崩れている）");

  log(`\n### ${IDLE_MIN} 分のアイドル（**何も送らない**）`);
  await sleep(IDLE_MIN * 60_000);

  log(`\n### アイドル明け`);
  log(`  close は届いているか: ${closed ?? "**届いていない**"}`);
  const a = await alive(60_000);
  log(`  応答あり=${a.ok} / ${a.ms}ms${a.err ? ` （${a.err}）` : ""}`);

  log("\n### 判定");
  if (a.ok) log(`  **越えられた**——${IDLE_MIN} 分のアイドル後も往復する`);
  else if (closed) log(`  **切れていた（理由あり）**: ${closed}`);
  else log("  **黙って死んでいた**——close も来ず、送っても応答が無い");
} catch (e) {
  log(`例外: ${e?.message ?? e}`);
} finally {
  try { s.close(); } catch { /* 良い */ }
}
