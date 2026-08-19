import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";

/**
 * **実 IBM i との照合**（3270 は IBM メインフレーム専用ではない）。
 *
 * ```sh
 * TN3270_IBMI=pub400.com npx vitest run test/e2e-ibmi.test.ts
 * # 日本語機なら CCSID も指定する
 * TN3270_IBMI=<host> TN3270_IBMI_CCSID=930 npx vitest run test/e2e-ibmi.test.ts
 * ```
 *
 * IBM i の telnet サーバーは 3270 端末を受け入れ、**5250 の世界へ橋渡しする**。
 * TK4-（MVS 3.8j）と違い**入力欄を持つ画面（サインオン）が出る**ので、
 * TK4- では確かめられない範囲がここで確かめられる。
 *
 * IBM i に繋ぐには 3 つが要る（どれも TK4- では不要だった）:
 * 1. **SNA 系のコマンドコード**（IBM i は WSF に `0x11` を使う）
 * 2. **WSF Query への応答**（Query Reply を返さないと画面が出ない）
 * 3. **Outbound 3270DS の展開**（画面本体が構造化フィールドに包まれて来る）
 *
 * さらに**日本語 IBM i は DBCS の申告が無いと黙る**（Query Reply の CharacterSets）。
 */

const host = process.env["TN3270_IBMI"];
const ccsid = Number(process.env["TN3270_IBMI_CCSID"] ?? 37);

describe.skipIf(!host)("実 IBM i と 3270 で接続する", () => {
  it("サインオン画面を組み立てられる", async () => {
    const s = new Tn3270Session({ host: host!, port: 23, model: 2, ccsid, connectTimeoutMs: 15_000 });
    let screens = 0;
    s.on("screen", () => screens++);
    try {
      await s.connect();
      const end = Date.now() + 15_000;
      while (Date.now() < end && screens === 0) await new Promise((r) => setTimeout(r, 100));

      expect(screens, "画面が来ない（Query Reply を返せていない可能性）").toBeGreaterThan(0);
      const snap = s.snapshot();
      expect([snap.rows, snap.cols]).toEqual([24, 80]);
      // サインオン画面は入力欄を持つ——**TK4- では得られなかった条件**
      expect(snap.fields.length, "フィールドが無い").toBeGreaterThan(10);
      expect(snap.fields.some((f) => !f.protected), "非保護欄が無い").toBe(true);
      // 非表示欄（パスワード）があること
      expect(snap.fields.some((f) => f.hidden), "非表示欄が無い").toBe(true);
    } finally {
      s.close();
    }
  }, 60_000);

  it.skipIf(ccsid !== 930 && ccsid !== 939)("日本語の画面が読める（DBCS）", async () => {
    const s = new Tn3270Session({ host: host!, port: 23, model: 2, ccsid, connectTimeoutMs: 15_000 });
    let screens = 0;
    s.on("screen", () => screens++);
    try {
      await s.connect();
      const end = Date.now() + 15_000;
      while (Date.now() < end && screens === 0) await new Promise((r) => setTimeout(r, 100));
      expect(screens).toBeGreaterThan(0);

      const snap = s.snapshot();
      const text = snap.cells
        .map((r) => r.map((c) => (c.kind === "dbcs-tail" ? "" : c.char)).join(""))
        .join("\n");
      // 日本語 IBM i のサインオン画面
      expect(text).toMatch(/サイン・オン/);
      expect(text).toMatch(/ユーザー/);
      expect(text).toMatch(/パスワード/);
      // **DBCS のセルが実際に立っていること**（SBCS で誤読していないこと）
      const dbcsCells = snap.cells.flat().filter((c) => c.kind === "dbcs-lead");
      expect(dbcsCells.length, "DBCS セルが無い").toBeGreaterThan(10);
    } finally {
      s.close();
    }
  }, 60_000);
});
