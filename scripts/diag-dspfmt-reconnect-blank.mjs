// DSPFMT FILE(TESTLIB/COMPLIST) OUTPUT(*) を実行した直後、初回表示が罫線のみになり
// Enter で正常化する不具合の実機調査（20260915利用者報告、スクリーンショット添付）。
// .aidev/works/20260915-dspfmt-reconnect-blank-redraw/requirements.md
//
// 利用者の追加情報:
//  - ほとんどの場合に再現するが、まれに正常なこともある（タイミング依存）。
//  - 一瞬罫線以外の内容が見えてから消えることもある（＝一度正しく描画された後に
//    何かが上書きして消している、という筋を示唆）。
//  - 再接続や寸断への対応を行った後に発生している可能性がある、との申告
//    （ただしこの package(@ts5250/tn5250) 自体には reconnect ロジックは無い——
//    grep 済み。再接続があるとすれば web-ui のブラウザ<->ローカルサーバ間の話で、
//    この診断は Session5250 を直接使うためその層は経由しない。まずコア層だけで
//    再現するかを切り分ける）。
//
// 狙う仮説:
//  (a) ホストが実際に2つ以上のWTDを送っており（例: 空の骨格→実データ）、
//      それが処理される順序や間隔次第で「実データが後から骨格で上書きされる」
//      競合が起きている。
//  (b) 実際には1つのWTDしか来ておらず、クライアント側のバッファ/属性打ち切り
//      処理（buffer.ts の retainedEnds/fieldEnds、または ScreenGrid.vue 側）に
//      タイミング依存の描画不具合がある。
//
// **重要**: 初版はライブの `session.snapshot()` をポーリングするだけで、`sendAid()` が
// 返す Promise の解決値そのものは見ていなかった。実際の欠陥（`research.md` F1/F1'）は
// 「ライブのバッファは常に正しいが、`sendAid()` の解決値（＝`key-done` が運ぶ内容）が
// 罫線のみのまま固まる」というものなので、**ライブ polling だけでは検出できない**
// （doccheck ラウンド2で指摘、requirements.md 参照）。このため、`sendAid()` の解決値も
// 別途チェックする（`resolvedBlank`）——regression 判定（AC2）はこちらを基準にする。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/diag-dspfmt-reconnect-blank.mjs [回数]
import { Session5250 } from "@ts5250/tn5250";

const host = process.env.AS400_HOST, user = process.env.AS400_USER, password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const ITERS = Number(process.argv[2] ?? 6);
if (!host || !user || !password) { process.stderr.write("AS400_* が要ります\n"); process.exit(2); }

const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) => s.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/u, "")).join("\n");
// 罫線相当の文字（box drawing）だけの行かどうか（純粋な罫線描画セルの典型的な文字集合）
const BORDER_CHARS = /^[\s─-╿+\-|_]*$/u;
function isBorderOnly(snap) {
  const t = text(snap);
  const nonBorderLines = t.split("\n").filter((l) => l.trim() && !BORDER_CHARS.test(l));
  return { blank: nonBorderLines.length === 0, nonBorderLines };
}

async function connectFresh() {
  const rx = [];
  const session = await Session5250.connect({
    host, port: 23, ccsid: 5035, screenSize: "24x80",
    ...(process.env.AS400_DEVNAME ? { deviceName: process.env.AS400_DEVNAME } : {}),
    traceRecords: true,
    warn: (w) => {
      const m = /^rx record \((\d+) bytes\): (.+)$/.exec(String(w));
      if (m) rx.push({ t: Date.now(), len: Number(m[1]), hex: m[2] });
      else if (/unknown order|PROTOCOL_ERROR|unmappable/.test(String(w))) log("WARN: " + w);
    },
  });
  return { session, rx };
}

async function signon(session) {
  let s = session.snapshot();
  for (let i = 0; i < 10; i++) {
    const t = text(s);
    if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
    const inputs = s.fields.filter((f) => !f.protected);
    if (t.includes("サイン・オン") || t.includes("Sign On")) {
      if (inputs[0]) session.setField({ index: inputs[0].index }, user);
      if (inputs[1]) session.setField({ index: inputs[1].index }, password);
    } else if (t.includes("回復")) { if (inputs[0]) session.setField({ index: inputs[0].index }, "90"); }
    await session.sendAid("Enter", { timeoutMs: 15000 });
    await sleep(700);
    s = session.snapshot();
  }
  return s;
}

function cmdField(s) { return s.fields.filter((f) => !f.protected).find((f) => f.length > 20); }

for (let iter = 1; iter <= ITERS; iter++) {
  log(`\n================ 試行 #${iter} (毎回フレッシュ接続) ================`);
  const { session, rx } = await connectFresh();
  const s0 = await signon(session);
  const c = cmdField(s0);
  session.setField({ index: c.index }, `DSPFMT FILE(${LIB}/COMPLIST) OUTPUT(*)`);
  rx.length = 0;
  const t0 = Date.now();
  // **regression 判定の本体**: sendAid() が返す Promise の解決値（=key-done が運ぶ内容）を見る。
  const resolvedPromise = session.sendAid("Enter", { timeoutMs: 8000 });
  let resolved = undefined;
  resolvedPromise.then((r) => { resolved = r; }).catch((e) => log("sendAid error: " + e?.message));

  const samples = [];
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const snap = session.snapshot();
    const { blank, nonBorderLines } = isBorderOnly(snap);
    samples.push({ dt: Date.now() - t0, blank, lines: nonBorderLines.length, rxCount: rx.length });
  }
  log(`受信レコード数=${rx.length}`);
  rx.forEach((r, i) => log(`  rx[${i}] t+${r.t - t0}ms ${r.len}bytes ${r.hex.slice(0, 120)}${r.hex.length > 120 ? "..." : ""}`));
  // サンプル系列を「状態が変わった時だけ」圧縮して出す
  let prev = null;
  for (const sm of samples) {
    const state = sm.blank ? "BLANK(罫線のみ)" : `DATA(非罫線行${sm.lines})`;
    if (state !== prev) { log(`  t+${sm.dt}ms rx=${sm.rxCount} -> ${state}`); prev = state; }
  }
  await resolvedPromise.catch(() => {});
  const finalSnap = session.snapshot();
  const finalState = isBorderOnly(finalSnap);
  const resolvedState = resolved ? isBorderOnly(resolved.screen) : { blank: undefined };
  log(`>>> ライブ snapshot()の最終状態: ${finalState.blank ? "罫線のみ" : "正常"}` +
      `　/　sendAid()の解決値(regression判定の本体): ${
        resolvedState.blank === undefined ? "未解決(timeout?)" :
        resolvedState.blank ? "罫線のみ（不具合再現）" : "正常（データ表示あり）"
      }`);
  if (finalState.blank) {
    log("--- 罫線のみ状態のフルダンプ ---");
    text(finalSnap).split("\n").forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l); });
    // ここでさらに Enter を押して正常化するか確認
    rx.length = 0;
    const t1 = Date.now();
    await session.sendAid("Enter", { timeoutMs: 10000 }).catch((e) => log("2nd Enter error: " + e?.message));
    await sleep(800);
    const after = session.snapshot();
    const afterState = isBorderOnly(after);
    log(`  2回目Enter後(t+${Date.now() - t1}ms, rx=${rx.length}): ${afterState.blank ? "まだ罫線のみ" : "正常化した"}`);
    if (!afterState.blank) {
      log("--- 正常化後のフルダンプ ---");
      text(after).split("\n").forEach((l, i) => { if (l.trim()) log(String(i + 1).padStart(2) + "|" + l); });
    }
  }
  // 次の試行のためにコマンド行へ戻す
  await session.sendAid("Enter", { timeoutMs: 5000 }).catch(() => {});
  session.disconnect?.();
  await sleep(500);
}
process.exit(0);
