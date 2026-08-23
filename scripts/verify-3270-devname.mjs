// **3270 の装置名**を実機で確かめる。
//
// IBM i は装置名を **NEW-ENVIRON の `DEVNAME`**（RFC 4777）で受け取る。
// 端末タイプに `@名前` を付ける方は**交渉が 15 秒で時間切れ**になる
// （pub400 / 社内機の 2 台で同じ）。だから IBM i には `@名前` を付けない。
//
// ⚠ **受け入れるかはホストの設定次第**:
//   pub400   → `DEVNAME=TSTDEV01` で Display name が TSTDEV01 になる（**効く**）
//   実機 → 同じ要求で**画面を送らずに接続を閉じる**（仮想装置の自動作成など、設定の差）
//
// このスクリプトは**両方を許す**——「効く」か「理由の分かる形で断られる」かのどちらかなら合格。
// 黙って壊れる（時間切れ・素の socket closed）のが不合格。
//
// 実行: node --env-file=.env --env-file=.env.verify scripts/verify-3270-devname.mjs
//       PROBE_HOST=pub400.com PROBE_CCSID=37 で pub400 にも当てられる
import { Tn3270Session } from "@ts5250/tn3270";

const host = process.env.PROBE_HOST ?? process.env.AS400_HOST;
if (!host) { process.stderr.write("AS400_HOST がありません\n"); process.exit(2); }
const log = (s) => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; log(`  PASS ${m}`); } else { fail++; log(`  FAIL ${m}`); } };

/** 画面の「表示装置」を読む */
async function deviceOf(deviceName) {
  let closeReason = "";
  const s = new Tn3270Session({
    host, port: 23, ccsid: Number(process.env.PROBE_CCSID ?? process.env.AS400_CCSID ?? 930),
    ...(deviceName ? { deviceName } : {})
  });
  s.on("close", (r) => { closeReason = String(r); });
  try {
    await s.connect();
    await sleep(2500);
    const line = s.snapshot().cells.map((r) => r.map((c) => c.char).join(""))
      .find((t) => /表示装置|Display name/u.test(t));
    return { ok: true, ibmI: s.isIbmI, device: line?.split(/[:：]/u).pop()?.trim() ?? "", closeReason };
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
  if (r.ok && r.device === WANT) {
    // pub400 はこちら
    check(true, `**装置名が使われた**: ${r.device}`);
  } else if (!r.ok || r.device === "") {
    // 社内機はこちら——**理由が言えていれば合格**
    const why = r.error ?? r.closeReason ?? "";
    check(
      why.includes(WANT),
      `ホストが断った。**理由に装置名が出る**: ${why.slice(0, 90) || "（理由なし）"}`
    );
  } else {
    check(false, `名前が無視されて別の装置になった: ${r.device}`);
  }
}

log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
