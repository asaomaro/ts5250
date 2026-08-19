import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA, CHARSET } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **カーソル移動キーと自動スキップの照合。**
 *
 * 端末側だけで完結する操作なので**ホストへは何も飛ばない**。
 * 比べるのは**カーソル位置**だけ——ここがずれると、以後の入力が全部ずれる。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/**
 * 0 保護 ／ 10 非保護(11-15) ／ 16 **自動スキップ**(保護＋数字) ／ 20 非保護(21-25) ／
 * 26 保護 ／ 90 非保護(91-95) ／ 100 DBCS 欄(101-104 に「日本」) ／ 120 保護
 */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE,
  ...sba(0), ORDER.SF, 0x60, 0xd7,
  ...sba(10), ORDER.SF, 0x00,
  ...sba(16), ORDER.SF, 0x30,
  ...sba(20), ORDER.SF, 0x00,
  ...sba(26), ORDER.SF, 0x60,
  ...sba(90), ORDER.SF, 0x00,
  ...sba(100), ORDER.SFE, 0x02, XA.BASIC, 0x00, XA.CHARSET, CHARSET.DBCS,
  0x45, 0x62, 0x45, 0x66,
  ...sba(120), ORDER.SF, 0x60,
  ...sba(11), ORDER.IC
]);

type Move = "home" | "tab" | "backTab" | "left" | "right" | "up" | "down" | "newline";
const ACTION: Record<Move, string> = {
  home: "Home()", tab: "Tab()", backTab: "BackTab()", left: "Left()",
  right: "Right()", up: "Up()", down: "Down()", newline: "Newline()"
};

const CASES: { name: string; from: number; moves: Move[]; type?: string }[] = [
  { name: "Home", from: 5, moves: ["home"] },
  { name: "Tab（欄の先頭から）", from: 11, moves: ["tab"] },
  { name: "Tab（自動スキップ欄を飛ばす）", from: 11, moves: ["tab", "tab"] },
  { name: "Tab（回り込み）", from: 91, moves: ["tab", "tab"] },
  { name: "Tab（欄の途中から）", from: 13, moves: ["tab"] },
  { name: "BackTab（欄の途中から）", from: 23, moves: ["backTab"] },
  { name: "BackTab（欄の先頭から）", from: 21, moves: ["backTab"] },
  { name: "Left（属性桁にも乗る）", from: 21, moves: ["left"] },
  { name: "Right", from: 21, moves: ["right"] },
  { name: "Up", from: 101, moves: ["up"] },
  { name: "Down", from: 21, moves: ["down"] },
  { name: "Newline（行頭が保護）", from: 21, moves: ["newline"] },
  { name: "DBCS の上で Left", from: 105, moves: ["left"] },
  { name: "DBCS の上で Right", from: 101, moves: ["right"] },
  { name: "DBCS の右半分へ Down（寄せない）", from: 22, moves: ["down"] },
  { name: "欄を埋めると自動スキップ欄を飛ばす", from: 11, moves: [], type: "ABCDE" }
];

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!enabled)("カーソル移動キーと自動スキップ", () => {
  it("**移動後のカーソルが s3270 と一致する**", async () => {
    expect(await s3270Available()).toBe(true);

    const refOut: number[] = [];
    const mini1 = await startMini3270({ records: [SCREEN], port: 3410 });
    const ref = await S3270.start({
      host: "127.0.0.1", port: 3410, httpPort: 6412, name: "cur-cmp", codePage: "cp930"
    });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);
      for (const c of CASES) {
        mini1.send(SCREEN);
        await new Promise((r) => setTimeout(r, 500));
        await ref.action(`MoveCursor(${Math.floor(c.from / 80)},${c.from % 80})`);
        if (c.type !== undefined) await ref.action(`String("${c.type}")`);
        for (const m of c.moves) await ref.action(ACTION[m]);
        const [r, col] = ((await ref.action("Query(Cursor)"))[0] ?? "").split(" ").map(Number);
        refOut.push((r ?? 0) * 80 + (col ?? 0));
      }
    } finally {
      await ref.stop();
      await mini1.close();
    }

    const ourOut: number[] = [];
    const mini2 = await startMini3270({ records: [SCREEN], port: 3411 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: 3411, model: 2, ccsid: 930 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      expect(await waitFor(() => n, 1)).toBe(true);
      for (const c of CASES) {
        const seen = n;
        mini2.send(SCREEN);
        await waitFor(() => n, seen + 1);
        s.setCursor(Math.floor(c.from / 80) + 1, (c.from % 80) + 1);
        if (c.type !== undefined) s.type(c.type);
        for (const m of c.moves) s[m]();
        const cur = s.snapshot().cursor;
        ourOut.push((cur.row - 1) * 80 + cur.col - 1);
      }
    } finally {
      s.close();
      await mini2.close();
    }

    // 空振り防止——動いた結果が全部同じ場所ではないこと
    expect(new Set(refOut).size).toBeGreaterThan(5);
    for (let i = 0; i < CASES.length; i++) {
      expect(ourOut[i], `${CASES[i]!.name}（s3270 は ${refOut[i]}）`).toBe(refOut[i]);
    }
  }, 300_000);
});
