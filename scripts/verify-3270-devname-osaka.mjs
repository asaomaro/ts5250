// **3270 で装置名を指定しても壊れない**ことを実機で確かめる。
//
// ⚠ **IBM i は 3270 の接続で装置名を受け付けない**（測って分かった）:
//   * 端末タイプに `@名前` を付ける → **交渉が 15 秒で時間切れ**
//   * NEW-ENVIRON に `DEVNAME` を載せる → 交渉は通るが**直後にソケットを閉じる**
//     （名前を 4 通り試して全て同じ。DEVNAME を止めるだけで通る）
//   * TN3270E の `CONNECT`（3270 本来の道）は **IBM i が TN3270E を提示しない**ので使えない
//
// だから `@名前` は NEW-ENVIRON を使わないホスト（TK4- 等）にだけ付け、
// `DEVNAME` は送らない。**指定は無視されるが、繋がらなくなることはない**——
// ここで確かめるのはそれ。
//
// 実行: node --env-file=.env scripts/verify-3270-devname-osaka.mjs
import { Tn3270Session } from "@ts5250/tn3270";

const host = process.env.AS400_HOST;
if (!host) { process.stderr.write("AS400_HOST がありません\n"); process.exit(2); }
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

/** 画面の「表示装置」を読む */
async function deviceOf(deviceName) {
  const s = new Tn3270Session({
    host, port: 23, ccsid: Number(process.env.AS400_CCSID ?? 930),
    ...(deviceName ? { deviceName } : {})
  });
  try {
    await s.connect();
    await sleep(2500);
    const line = s.snapshot().cells.map((r) => r.map((c) => c.char).join("")).find((t) => t.includes("表示装置"));
    return { ok: true, ibmI: s.isIbmI, device: line?.split(/[:：]/u).pop()?.trim() ?? "" };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    s.close?.();
  }
}

const WANT = process.env.TN3270_DEVNAME ?? "AS3270A";

log("### 1. 指定しないとき（従来どおり）");
{
  const r = await deviceOf(undefined);
  check(r.ok, `繋がる（IBM i と判定=${r.ibmI}）`);
  check(/^QPADEV/u.test(r.device ?? ""), `ホストが割り当てた名前: ${r.device}`);
}
await sleep(1500);

log(`\n### 2. 装置名を指定したとき（${WANT}）`);
{
  const r = await deviceOf(WANT);
  // **繋がることが要件**。名前が通らないのは IBM i の側の話で、こちらは壊れない
  check(r.ok, `**繋がる（交渉も切断も起きない）**${r.ok ? "" : `（${r.error}）`}`);
  if (r.ok) {
    check(/^QPADEV/u.test(r.device ?? ""), `名前は使われず、ホストが採番する: ${r.device}`);
    check(r.device !== "", "**画面が届いている**（DEVNAME を送っていた頃は 0 文字だった）");
  }
}

log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
