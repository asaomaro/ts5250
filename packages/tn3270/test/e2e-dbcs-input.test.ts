import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA, CHARSET } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270, type Mini3270 } from "./harness/mini3270.js";

/**
 * **入力側の DBCS。** 日本語を打ったとき、何をホストへ送るのか。
 *
 * 実装は「符号化した結果をそのままバッファへ」だった。**欄の種類を見ていなかった。**
 * s3270 と突き合わせたところ 3 通りに分かれていた:
 *
 * | 欄 | 日本語 | 英数 |
 * |---|---|---|
 * | 素の欄 | **撥ねる**（Operator error） | そのまま |
 * | 混在入力（`XA.INPUT_CONTROL`=1） | `SO` … `SI` で包む | そのまま |
 * | DBCS 欄（`XA.CHARSET`=`0xf8`） | **生のまま**（SO/SI 無し） | **撥ねる** |
 *
 * ここでは**送信バイトを 1 バイト単位で**突き合わせる。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 混在入力の欄（11〜）と DBCS 欄（31〜）を持つ画面 */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE,
  ...sba(0), ORDER.SF, 0x60, 0xd7,
  ...sba(10), ORDER.SFE, 0x02, XA.BASIC, 0x00, XA.INPUT_CONTROL, 0x01,
  ...sba(30), ORDER.SFE, 0x02, XA.BASIC, 0x00, XA.CHARSET, CHARSET.DBCS,
  ...sba(50), ORDER.SF, 0x60,
  ...sba(11), ORDER.IC
]);

/** 打つ場所（欄の先頭アドレス）と打つ文字 */
const CASES: { name: string; addr: number; tabs: number; text: string }[] = [
  { name: "混在欄に日本語", addr: 11, tabs: 0, text: "日本" },
  { name: "混在欄に英数と日本語を混ぜる", addr: 11, tabs: 0, text: "AB日本CD" },
  { name: "混在欄に日本語→英数→日本語", addr: 11, tabs: 0, text: "日A本" },
  { name: "DBCS 欄に日本語", addr: 31, tabs: 1, text: "日本" }
];

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** 画面を出し直し、打ち込んで Enter を押し、送信された 1 レコードを hex で返す */
async function press(mini: Mini3270, before: number): Promise<string> {
  await waitFor(() => mini.inbound().length, before + 1);
  return mini.inbound()[before] ?? "";
}

describe.skipIf(!enabled)("入力側の DBCS が s3270 と一致する", () => {
  it("**打ち込んだ結果の送信バイトが一致する**", async () => {
    expect(await s3270Available()).toBe(true);

    // --- s3270 側
    const refOut: string[] = [];
    const mini1 = await startMini3270({ records: [SCREEN], port: 3397 });
    const ref = await S3270.start({
      host: "127.0.0.1", port: 3397, httpPort: 6402, name: "dbcs-in", codePage: "cp930"
    });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);
      for (const c of CASES) {
        mini1.send(SCREEN); // MDT を落として打ち直す
        await new Promise((r) => setTimeout(r, 700));
        await ref.action("Home()");
        for (let t = 0; t < c.tabs; t++) await ref.action("Tab()");
        const typed = await ref.action(`String("${c.text}")`);
        expect(typed.join(" "), `${c.name}: s3270 が入力を撥ねた`).not.toMatch(/error/i);
        const before = mini1.inbound().length;
        void ref.action("Enter()").catch(() => {});
        refOut.push(await press(mini1, before));
        mini1.send(Uint8Array.from([CMD3270.WRITE, WCC.RESTORE])); // 施錠を解く
        await new Promise((r) => setTimeout(r, 350));
      }
    } finally {
      await ref.stop();
      await mini1.close();
    }

    // --- 自実装側
    const ourOut: string[] = [];
    const mini2 = await startMini3270({ records: [SCREEN], port: 3398 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: 3398, model: 2, ccsid: 930 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      expect(await waitFor(() => n, 1)).toBe(true);
      for (const c of CASES) {
        const seen = n;
        mini2.send(SCREEN);
        await waitFor(() => n, seen + 1);
        const rc = { row: Math.floor(c.addr / 80) + 1, col: (c.addr % 80) + 1 };
        s.setCursor(rc.row, rc.col);
        s.type(c.text);
        const before = mini2.inbound().length;
        s.send("enter");
        ourOut.push(await press(mini2, before));
        mini2.send(Uint8Array.from([CMD3270.WRITE, WCC.RESTORE]));
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      s.close();
      await mini2.close();
    }

    // 空振り防止——日本語のバイトが実際に乗っていること
    expect(refOut[0], "s3270 が何も送っていない").toMatch(/45624566/);
    expect(refOut[0], "混在欄なのに SO が無い").toMatch(/0e4562/);
    expect(refOut[3], "DBCS 欄なのに SO が付いている").not.toMatch(/0e4562/);
    // **DBCS 欄の余りは空白として送られる**（NUL のままではない）。
    // x3270 が書き込みのたびに「成立しない DBCS の対」を空白へ均すため
    expect(refOut[3], "DBCS 欄の余りが空白になっていない").toMatch(/4040/);
    for (let i = 0; i < CASES.length; i++) {
      expect(ourOut[i], CASES[i]!.name).toBe(refOut[i]);
    }
  }, 300_000);
});
