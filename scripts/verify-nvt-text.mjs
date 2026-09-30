// 実機検証（偽のサーバー）: **交渉の前に届いたテキスト（NVT）の画面が、ACS のコアと同じか**（台帳「telnet の交渉前のテキスト」。`20260930-telnet-nvt-text`）。
//
// `scripts/fake-nvt-server.mjs` と同じ形の偽のサーバー（BINARY も EOR も交渉せずに断片を送る）を立て、当 PJ の `Session5250` で受けて画面を比べる。
// 期待値は ACS のコア（`scripts/acs-probe/nvt-text.txt`。`PROBE_CODEPAGE=37`）に同じ断片を当てて採った画面とカーソル（2026-09-30）。
// IBM i は交渉前にテキストを送らないので実機は要らない（ACS のコアも手元の偽のサーバーに繋いで測った）。
//
// 実行: node scripts/verify-nvt-text.mjs
import { createServer } from "node:net";
import { Session5250 } from "@ts5250/tn5250";

const long = "x" + "0123456789".repeat(10); // 101 字
/** 断片の列 → ACS のコアの画面（空でない行。末尾の空白は落とす）とカーソル（行,桁） */
const CASES = [
  {
    name: "S1 文字・CR LF・LF・BS・CR・HT（無視）・ENQ・制御文字と 0x7F 以上（無視）",
    chunks: ["Hello, world\r\n", "Line2\n", "ab\bX\r", "\tT", "\x05Z", "\x01\x02\x07\x0e\x1b\x7fq", "\xc3\xa9\xe3\x81\x82r"],
    rows: { 1: "Hello, world", 2: "Line2", 3: "T       Zqr" },
    cursor: [3, 12]
  },
  { name: "S2 LF 23 回（最下行）", chunks: ["a", "\n".repeat(23), "Q"], rows: { 1: "a", 24: " Q" }, cursor: [24, 3] },
  { name: "S3 LF 24 回（1 行目へ回り込み、空白で埋める）", chunks: ["a", "\n".repeat(24), "Q"], rows: { 1: " Q" }, cursor: [1, 3] },
  { name: "S4 LF 25 回", chunks: ["a", "\n".repeat(25), "Q"], rows: { 2: " Q" }, cursor: [2, 3] },
  { name: "S5 101 字の行（右端で折り返す）", chunks: [long + "\r\n"], rows: { 1: long.slice(0, 80), 2: long.slice(80) }, cursor: [3, 1] },
  // **画面の終わりを越えて書くと、その受信ぶんは全部捨てられる**（位置の検査）。ACS はそのあと入力禁止のままになり、Reset でも戻らず、続く受信も書かない
  // （`Q` を続けて確かめた）。当 PJ はその受信ぶんを捨てるところまで同じで、**続く受信は書く**（ACS のように動かなくなる状態は写さない。decisions D2）。
  // ここは捨てるところまでを比べる（続く受信は入れない）
  { name: "S6 最下行で画面の終わりを越えて書く（その受信ぶんは捨てる）", chunks: ["a", "\n".repeat(23), "x".repeat(100)], rows: { 1: "a" }, cursor: [24, 2] },
  { name: "S7 同じことを 50＋50 に分ける（50 は収まって書き、次の 50 は捨てる）", chunks: ["a", "\n".repeat(23), "x".repeat(50), "y".repeat(50)], rows: { 1: "a", 24: " " + "x".repeat(50) }, cursor: [24, 52] },
  { name: "S8 `! ^ | [ ]` は ACS の固定の表（037 と違う）・NUL 無視・VT・FF", chunks: ["a!b^c|d[e]f\r\n", "x\x00y\x0bz\x0cw"], rows: { 1: "a|b¬c]d¢e!f", 2: "xy", 3: "  z", 4: "   w" }, cursor: [4, 5] },
  { name: "S9 先頭で BS（SBA 1,0 は拒否される）と ENQ", chunks: ["\b\bAB", "\x05C\x05D"], rows: { 1: "        C       D" }, cursor: [1, 18] }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;

for (const c of CASES) {
  const server = createServer((sock) => {
    sock.setNoDelay(true);
    sock.on("error", () => {});
    c.chunks.forEach((chunk, i) => setTimeout(() => sock.write(Buffer.from(chunk, "latin1")), 200 + 300 * i));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  let session;
  try {
    session = await Session5250.connect({ host: "127.0.0.1", port, ccsid: 37, negotiationTimeoutMs: 5000 });
    await sleep(300 * c.chunks.length + 800);
    const snap = session.snapshot();
    const rows = {};
    snap.cells.forEach((row, i) => {
      const t = row.map((x) => x.char).join("").replace(/ +$/, "");
      if (t !== "") rows[i + 1] = t;
    });
    const ok = JSON.stringify(rows) === JSON.stringify(c.rows) && snap.cursor.row === c.cursor[0] && snap.cursor.col === c.cursor[1];
    if (ok) {
      pass++;
      process.stderr.write(`  PASS ${c.name}\n`);
    } else {
      fail++;
      process.stderr.write(`  FAIL ${c.name}\n    当 PJ: ${JSON.stringify(rows)} cursor=${snap.cursor.row},${snap.cursor.col}\n    ACS:   ${JSON.stringify(c.rows)} cursor=${c.cursor.join(",")}\n`);
    }
  } catch (e) {
    fail++;
    process.stderr.write(`  FAIL ${c.name}: ${e.message}\n`);
  } finally {
    try {
      session?.close?.();
    } catch {}
    server.close();
  }
}
process.stderr.write(`RESULT: pass=${pass} fail=${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
