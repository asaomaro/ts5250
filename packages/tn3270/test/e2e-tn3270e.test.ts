import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC } from "../src/protocol/constants.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **TN3270E の照合。**
 *
 * 実ホストで TN3270E を提示するものが手元に無い（TK4- も IBM i も基本 TN3270 止まり）ので、
 * **RFC 2355 に従うサーバを自作し、s3270 を独立オラクルにする**。
 *
 * 順序が大事——**先に s3270 でハーネスの正しさを確かめ、それから自実装を当てる**。
 * ハーネスが仕様違反だと誤検証になる（プロトタイプで実際にやった）。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];
// **手書きの変換表を使わない**——'S' を書き落として "TEST" が "TE T" になった。
// 実コーデックを使えば取りこぼしが起きない
const txt = (s: string): number[] => [...codecForCcsid(37).encode(s).bytes];

/** 「TN3270E TEST」を表示するだけの画面 */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE, ...sba(0), ORDER.SF, 0x60, ...txt("TN3270E TEST")
]);

const lines = (s: Tn3270Session): string[] =>
  s.snapshot().cells.map((r) => r.map((c) => (c.kind === "dbcs-tail" ? "" : c.char)).join("").replace(/\s+$/, ""));

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!enabled)("TN3270E", () => {
  it("**まず s3270 がハーネスを受理する**（ハーネスの正しさを先に確かめる）", async () => {
    expect(await s3270Available()).toBe(true);
    const mini = await startMini3270({ records: [SCREEN], port: 3320, tn3270e: true, assignName: "REFLU" });
    const ref = await S3270.start({ host: "127.0.0.1", port: mini.port, httpPort: 6340, name: "tn3270e-ref" });
    try {
      expect(await ref.waitReady(), "s3270 が 3270 モードに入らない").toBe(true);
      expect(await ref.waitForContent(), "画面が来ない").toBe(true);
      // **s3270 は TN3270E で名乗る**（基本 TN3270 の IBM-3279-* とは別）
      expect(mini.deviceType()).toMatch(/^IBM-3278-/);
      expect((await ref.ascii())[0]).toContain("TN3270E TEST");
    } finally {
      await ref.stop();
      await mini.close();
    }
  }, 90_000);

  it("自実装が TN3270E で画面を組み立てる", async () => {
    const mini = await startMini3270({ records: [SCREEN], port: 3321, tn3270e: true, assignName: "MYLU9" });
    const s = new Tn3270Session({ host: "127.0.0.1", port: mini.port, model: 2 });
    let screens = 0;
    s.on("screen", () => screens++);
    try {
      await s.connect();
      expect(await waitFor(() => screens, 1), "画面が来ない").toBe(true);
      expect(s.isTn3270e, "TN3270E で繋がっていない").toBe(true);
      expect(s.assignedDeviceName).toBe("MYLU9");
      expect(mini.deviceType()).toBe("IBM-3278-2-E");
      expect(lines(s)[0]).toContain("TN3270E TEST");
    } finally {
      s.close();
      await mini.close();
    }
  }, 60_000);

  it("**LU 名を指定すると CONNECT で渡る**（`@` 記法は使わない）", async () => {
    const mini = await startMini3270({ records: [SCREEN], port: 3322, tn3270e: true });
    const s = new Tn3270Session({ host: "127.0.0.1", port: mini.port, model: 2, deviceName: "WANTLU" });
    let screens = 0;
    s.on("screen", () => screens++);
    try {
      await s.connect();
      await waitFor(() => screens, 1);
      expect(mini.requestedName()).toBe("WANTLU");
      expect(mini.deviceType()).not.toContain("@"); // 二重指定していない
    } finally {
      s.close();
      await mini.close();
    }
  }, 60_000);

  it("**自実装と s3270 の交渉列が一致する**", async () => {
    // 同じサーバに順に繋ぎ、サーバが受け取ったサブネゴシエーション本文を比べる
    const grab = async (who: "ref" | "ours"): Promise<string[]> => {
      const port = who === "ref" ? 3323 : 3324;
      const mini = await startMini3270({ records: [SCREEN], port, tn3270e: true, assignName: "CMPLU" });
      try {
        if (who === "ref") {
          const ref = await S3270.start({ host: "127.0.0.1", port, httpPort: 6341, name: "tn3270e-cmp" });
          await ref.waitReady();
          await ref.waitForContent();
          await ref.stop();
        } else {
          const s = new Tn3270Session({ host: "127.0.0.1", port, model: 2 });
          let n = 0;
          s.on("screen", () => n++);
          await s.connect();
          await waitFor(() => n, 1);
          s.close();
        }
        return mini.negotiation();
      } finally {
        await mini.close();
      }
    };
    const ref = await grab("ref");
    const ours = await grab("ours");
    expect(ref.length, "s3270 の交渉列が空").toBeGreaterThan(0);

    // 1 通目 = DEVICE-TYPE REQUEST。**型名まで一致すること**
    expect(ours[0]).toBe(ref[0]);
    // 2 通目 = FUNCTIONS。s3270 は機能を要求するが、こちらは**空**（基本 TN3270E）
    expect(ours[1]!.startsWith("0307")).toBe(true); // FUNCTIONS REQUEST
    expect(ours[1]).toBe("0307");                   // 空リスト
    expect(ref[1]!.startsWith("0307")).toBe(true);
    expect(ref[1]!.length).toBeGreaterThan(4);      // s3270 は機能を並べる
  }, 120_000);

  it("REJECT を受けると理由付きで接続が失敗する", async () => {
    const mini = await startMini3270({ records: [SCREEN], port: 3325, tn3270e: true, rejectReason: 0x01 });
    const s = new Tn3270Session({
      host: "127.0.0.1", port: mini.port, model: 2, deviceName: "TAKEN", negotiateTimeoutMs: 4000
    });
    try {
      await expect(s.connect()).rejects.toThrow();
    } finally {
      s.close();
      await mini.close();
    }
  }, 60_000);

  it("**tn3270e:false なら基本 TN3270 へ後退する**（退行経路の確認）", async () => {
    const mini = await startMini3270({ records: [SCREEN], port: 3326, tn3270e: true });
    const s = new Tn3270Session({ host: "127.0.0.1", port: mini.port, model: 2, tn3270e: false });
    let screens = 0;
    s.on("screen", () => screens++);
    try {
      await s.connect();
      expect(await waitFor(() => screens, 1), "後退経路で画面が来ない").toBe(true);
      expect(s.isTn3270e).toBe(false);
      expect(mini.terminalType()).toMatch(/^IBM-3279-/); // 基本の型名で名乗っている
      expect(lines(s)[0]).toContain("TN3270E TEST");
    } finally {
      s.close();
      await mini.close();
    }
  }, 60_000);
});
