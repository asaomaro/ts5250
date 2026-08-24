// **罫線を描いた直後に CLEAR UNIT が来ても罫線が残るか**を実機で確かめる（S9R167D の再現）。
//
// 検証資材は scripts/build-gridtest6.mjs が作る <LIB>/GRIDTST6 ＋ GRIDCL8 / GRIDCL9。
//   GRIDCL8 … 罫線レコード → OVERLAY 無しのレコード（＝ホストが素の CLEAR UNIT を挟む）
//   GRIDCL9 … 罫線レコード → OVERLAY 付きのレコード（対照。CLEAR UNIT は来ない）
//
// **画面サイズを 2 つとも回す。** 24x80（alternate 未申告）は S9R167D と同じ条件で、
// ここが CLEAR UNIT ALTERNATE のフォールバック（旧実装は `clearUnit()` へ倒していた）を通る。
// 27x132 は既存の YB0270R 経路の回帰確認。
//
// 実行:
//   npm run build
//   node --env-file=.env --env-file=.env.verify scripts/verify-gridlines-clear-unit.mjs
// 任意: VERIFY_SIZE=24x80|27x132|both（既定 both）/ VERIFY_DEVNAME / VERIFY_TRACE_OUT（受信レコードの保存先）
import { writeFileSync } from "node:fs";
import { Session5250 } from "@ts5250/tn5250";
import { codecForCcsid } from "@ts5250/ebcdic";
// **公開面に無いものは実体から取る**（`@ts5250/tn5250` は画面バッファと適用器を輸出していない）。
// 受信レコードを**もう一度当方の実装へ流して**、ホストが送った順番そのものを見るために要る。
import { ScreenBuffer } from "../packages/tn5250/dist/screen/buffer.js";
import { applyDataStream } from "../packages/tn5250/dist/protocol/wtd-applier.js";
import { parseRecord } from "../packages/tn5250/dist/protocol/gds.js";

const host = process.env.AS400_HOST;
const user = process.env.AS400_USER;
const password = process.env.AS400_PASSWORD;
const LIB = process.env.AS400_LIB ?? "TESTLIB";
const SIZES = (process.env.VERIFY_SIZE ?? "both") === "both" ? ["24x80", "27x132"] : [process.env.VERIFY_SIZE];
const EXPECTED_LINES = 13; // build-gridtest6.mjs の GRID_LINES と揃える
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!host || !user || !password) { log("AS400_HOST / AS400_USER / AS400_PASSWORD を環境変数で"); process.exit(1); }

let ng = 0;
const check = (ok, label) => { log(`${ok ? "OK  " : "NG  "} ${label}`); if (!ok) ng++; return ok; };
const text = (snap) => snap.cells.map((r) => r.map((c) => c.char).join("").replace(/ +$/, "")).join("\n");

/** 受信レコード（hex）を溜める。**ホストが本当に何を送ってきたか**が唯一の証拠になる */
const traces = [];
let capture = null;

/**
 * **ホストが送った順番を、当方の適用器そのものに数えさせる。**
 *
 * バイト列を素朴に走査して `04 40`（ESC＋CLEAR UNIT）を数える手は使えない——SBA の行桁
 * パラメータ等、データの中の 0x04 を拾って**過大に出る**（`census-5250-commands.mjs` も
 * 同じ理由で素朴走査を「参考値」と断っている）。そこで画面バッファを Proxy で包み、
 * 適用器が呼んだメソッドを呼ばれた順に記録する。デコーダーを書き起こさずに順番が確定する。
 */
function replayOrder(recordBytes, size) {
  const buf = new ScreenBuffer(size === "27x132" ? { alternate: "27x132" } : {});
  const WATCH = ["clearUnit", "clearUnitAlternate", "clearGui", "applyGridLines", "clearGridLines"];
  const seq = [];
  const spy = new Proxy(buf, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (!WATCH.includes(prop)) return v.bind(target);
      return (...args) => {
        seq.push(prop);
        return v.apply(target, args);
      };
    }
  });
  const result = applyDataStream(parseRecord(recordBytes).data, spy, codecForCcsid(930), () => {});
  return { seq, cleared: result.lastWrite.cleared, gridLines: buf.snapshot("t", false).gui?.gridLines.length ?? 0 };
}

async function runOne(size) {
  log(`\n========== 画面サイズ ${size} ==========`);
  // **装置名は既定で指定しない**——この実機は自動構成が禁止（8940）で、勝手な名前では入れない。
  // ホストに採らせれば QPADEVxxxx が割り当たる（verify-cursor-align.mjs と同じ理由）。
  const dev = process.env.VERIFY_DEVNAME;
  const session = await Session5250.connect({
    host,
    port: 23,
    ccsid: 930,
    screenSize: size,
    ...(dev ? { deviceName: dev } : {}),
    traceRecords: true,
    warn: (m) => {
      const hit = /^rx record \((\d+) bytes\): (.*)$/.exec(m);
      if (!hit) { log("  [warn] " + m); return; }
      const bytes = hit[2].split(" ").map((h) => parseInt(h, 16));
      if (capture) capture.push(bytes);
      traces.push({ size, phase: capture ? capture.label : "(setup)", hex: hit[2] });
    }
  });

  try {
    // --- サインオン〜コマンド行 ---
    let snap = session.snapshot();
    for (let i = 0; i < 10; i++) {
      const t = text(snap);
      if (t.includes("コマンドを入力") || t.includes("Selection or command")) break;
      const inputs = snap.fields.filter((f) => !f.protected);
      if (t.includes("サイン・オン") || t.includes("Sign On")) {
        session.setField({ index: inputs[0].index }, user);
        session.setField({ index: inputs[1].index }, password);
      } else if (t.includes("回復")) {
        if (inputs[0]) session.setField({ index: inputs[0].index }, "90");
      }
      await session.sendAid("Enter", { timeoutMs: 15000 });
      await sleep(700);
      snap = session.snapshot();
    }

    for (const [pgm, label, expectClearUnit] of [
      ["GRIDCL8", "罫線 → OVERLAY 無し（CLEAR UNIT が挟まる）", true],
      ["GRIDCL9", "罫線 → OVERLAY 付き（対照）", false]
    ]) {
      const cmdField = session.snapshot().fields.filter((f) => !f.protected).find((f) => f.length > 20);
      if (!cmdField) { check(false, `${pgm}: コマンド行が見つからない`); return; }
      session.setField({ index: cmdField.index }, `CALL ${LIB}/${pgm}`);
      capture = []; capture.label = pgm;
      await session.sendAid("Enter", { timeoutMs: 25000 });
      await sleep(1200);
      const records = capture;
      capture = null;

      const shot = session.snapshot();
      const lines = shot.gui?.gridLines ?? [];
      const replays = records.map((r) => replayOrder(Uint8Array.from(r), size));
      const seq = replays.flatMap((r) => r.seq);
      log(`\n--- ${pgm}: ${label} ---`);
      log(`  受信レコード ${records.length} 件 / 適用器が呼んだ順: ${seq.join(" → ") || "(なし)"}`);
      log(text(shot).split("\n").filter((l) => l.trim() !== "").slice(0, 6).join("\n"));

      const gi = seq.indexOf("applyGridLines");
      const ci = seq.findIndex((s, i) => i > gi && (s === "clearUnit" || s === "clearUnitAlternate" || s === "clearGui"));
      if (expectClearUnit) {
        // **症状の前提**: 罫線を描いた**後ろ**にクリアが来る。ここが崩れていたら以降の OK は無意味
        check(gi >= 0 && ci > gi, `${pgm}[${size}]: ホストが罫線の後ろに ${seq[ci] ?? "(無し)"} を送ってくる（症状の前提）`);
        check(seq.includes("clearUnit"), `${pgm}[${size}]: そのクリアに**素の CLEAR UNIT** が含まれる（S9R167D と同じ経路）`);
      }
      check(lines.length === EXPECTED_LINES, `${pgm}[${size}]: 罫線が ${EXPECTED_LINES} 本とも残る（実際 ${lines.length} 本）`);
      check(text(shot).includes("13 LINES MUST SHOW"), `${pgm}[${size}]: 本文レコードも出ている`);

      // 画面を閉じてコマンド行へ戻す
      for (let i = 0; i < 4; i++) {
        if (text(session.snapshot()).includes("コマンドを入力")) break;
        await session.sendAid("Enter", { timeoutMs: 15000 });
        await sleep(900);
      }
    }
  } finally {
    session.disconnect();
    await sleep(500);
  }
}

for (const size of SIZES) {
  try {
    await runOne(size);
  } catch (err) {
    check(false, `${size}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const out = process.env.VERIFY_TRACE_OUT;
if (out) {
  writeFileSync(out, JSON.stringify(traces, null, 1));
  log(`\n受信レコードを ${out} に保存した（${traces.length} 件。修正前の実装へ流し直す証拠になる）`);
}

log(ng === 0 ? "\nすべて OK" : `\nNG ${ng} 件`);
process.exit(ng === 0 ? 0 : 1);
