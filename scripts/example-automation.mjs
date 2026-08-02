// Session5250 を使ったテスト自動化のテンプレート（LLM 非依存・ヘッドレス）。
// 極小テストハーネス＋薄い Host ドライバで「接続→操作→アサート→後始末」を書く例。
// 実行: node --env-file=.env scripts/example-automation.mjs
//   必要 env: PUB400_USER / PUB400_PASSWORD（任意: PUB400_HOST, PUB400_DEVNAME, PUB400_LIB）
import { Session5250 } from "@ts5250/tn5250";

const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIB = process.env.PUB400_LIB ?? "MYLIB";

// ---- 極小テストハーネス ----
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); log(`PASS  ${name}`); pass++; }
  catch (e) { log(`FAIL  ${name} — ${e.message}`); fail++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };

// ---- Session5250 の薄いドライバ（操作を意味単位でラップ） ----
class Host {
  static async connect(opts = {}) {
    // PUB400 は切断後もデバイスを保持するため、リトライごとにデバイス名を変える
    const base = process.env.PUB400_DEVNAME ?? "WEBAUT";
    let last;
    for (let i = 0; i < 5; i++) {
      try {
        const s = await Session5250.connect({
          host: process.env.PUB400_HOST ?? "pub400.com", port: 23,
          deviceName: `${base}${i}`.slice(0, 10),
          user: process.env.PUB400_USER, password: process.env.PUB400_PASSWORD,
          warn: (w) => log("WARN: " + w), ...opts
        });
        await s.waitForScreen({ timeoutMs: 8000, until: { text: "Main Menu" } }).catch(() => {});
        if (s.snapshot().fields.some((f) => !f.protected)) return new Host(s);
        s.disconnect();
      } catch (e) { last = e; log(`connect retry ${i + 1}: ${e.message}`); }
      await sleep(2000);
    }
    throw last ?? new Error("could not reach a command screen");
  }
  constructor(s) { this.s = s; }
  snap() { return this.s.snapshot(); }
  text() { return this.snap().cells.map((r) => r.map((c) => c.char).join("")).join("\n"); }
  at(r, c) { return this.snap().cells[r - 1][c - 1]; }              // セル属性を見る
  cmdField() { const e = this.snap().fields.filter((f) => !f.protected); return e.at(-1); }
  set(target, value) { this.s.setField(target, value); }            // {index} or {row,col}
  async key(k, cursor) { return (await this.s.sendAid(k, { cursor, timeoutMs: 15000 })).screen; }
  async run(cmd) { const f = this.cmdField(); this.set({ index: f.index }, cmd); return this.key("Enter", { row: f.row, col: f.col }); }
  async waitText(t, ms = 12000) { await this.s.waitForScreen({ timeoutMs: ms, until: { text: t } }); }
  async close() { await this.s.disconnect(); }
}

// ================= テスト本体 =================
const host = await Host.connect();
try {
  await test("自動サインオンでメインメニューに到達", () => {
    assert(/IBM i Main Menu/.test(host.text()), "menu not reached");
  });

  await test("コマンド実行で画面遷移し、F3 で戻る", async () => {
    await host.run("WRKACTJOB");
    assert(/Work with Active Jobs/.test(host.text()), "WRKACTJOB へ遷移せず");
    await host.key("F3");
    assert(/Main Menu/.test(host.text()), "メニューへ戻らず");
  });

  await test(`${LIB}/CLRTPGM の色・属性を検証（存在すれば）`, async () => {
    await host.run(`CALL ${LIB}/CLRTPGM`);
    if (/not found/i.test(host.text())) { log("  (CLRTPGM 無し→skip: build-attrtest.mjs で作成可)"); return; }
    assert(host.at(3, 2).color === "green", "GRN が緑でない");
    assert(host.at(3, 40).color === "red", "RED が赤でない");
    assert(host.at(6, 2).reverse === true, "RVS が反転でない");
    await host.key("F3");
  });
} finally {
  await host.close();
}
log(`\n${fail === 0 ? "OK" : "NG"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
