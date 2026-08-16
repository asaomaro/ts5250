import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270, type Mini3270 } from "./harness/mini3270.js";

/**
 * **`Read Modified All`（0x6e）と `Erase All Unprotected`（0x6f）の検証。**
 *
 * どちらも TK4- も IBM i も一度も送ってこなかった。単体テストしか裏付けが無く、
 * しかも**書いてみたら 4 か所違っていた**（詳細は review.md）。
 *
 * ここでは**同じバイト列を s3270 と自実装の両方に流し、応答バイトを 1 バイト残らず突き合わせる**。
 * 画面の見た目ではなく応答バイトを比べるのは、`Read Buffer` の応答に
 * **画面の中身・カーソル位置・MDT ビット・覚えている AID** が全部乗るため——
 * EAU が何をしたかは、この 1 本で丸ごと確かめられる。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];
const txt = (s: string): number[] => [...codecForCcsid(37).encode(s).bytes];

/** 保護欄 1 つと非保護欄 2 つ。カーソルは最初の非保護桁（11）に置く */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE,
  ...sba(0), ORDER.SF, 0x60, ...txt("PROT"),
  ...sba(10), ORDER.SF, 0x00, ...txt("...."),
  ...sba(30), ORDER.SF, 0x00,
  ...sba(50), ORDER.SF, 0x60, ...txt("END"),
  ...sba(11), ORDER.IC
]);

/** ホストが撃つ命令。**順番に意味がある**（短形式 → それを覆す 6e → EAU で御破算） */
const STEPS: { name: string; cmd: number[]; expectReply: boolean }[] = [
  { name: "Read Modified（PA1 の後）", cmd: [CMD3270.READ_MODIFIED], expectReply: true },
  { name: "Read Modified All（PA1 の後）", cmd: [CMD3270.READ_MODIFIED_ALL], expectReply: true },
  { name: "Read Buffer（PA1 の後）", cmd: [CMD3270.READ_BUFFER], expectReply: true },
  { name: "Erase All Unprotected", cmd: [CMD3270.ERASE_ALL_UNPROTECTED], expectReply: false },
  { name: "Read Buffer（EAU の後）", cmd: [CMD3270.READ_BUFFER], expectReply: true },
  { name: "Read Modified（EAU の後）", cmd: [CMD3270.READ_MODIFIED], expectReply: true }
];

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** 命令を 1 つ撃って応答を 1 つ取る。応答が無い命令なら空文字 */
async function step(mini: Mini3270, cmd: number[], expectReply: boolean): Promise<string> {
  const before = mini.inbound().length;
  mini.send(Uint8Array.from(cmd));
  if (!expectReply) {
    // 「返って来ない」ことの確認なので、少し待ってから数える
    await waitFor(() => mini.inbound().length, before + 1, 1500);
    return mini.inbound().slice(before).join(" ");
  }
  await waitFor(() => mini.inbound().length, before + 1);
  return mini.inbound()[before] ?? "";
}

describe.skipIf(!enabled)("Read Modified All と Erase All Unprotected", () => {
  /** s3270 を動かして、AID 押下と各命令への応答を hex で集める */
  async function fromS3270(port: number, httpPort: number): Promise<string[]> {
    const mini = await startMini3270({ records: [SCREEN], port });
    const ref = await S3270.start({ host: "127.0.0.1", port, httpPort, name: `rma-${port}` });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);
      await ref.action('String("ABC")');
      await ref.action("Tab()");
      await ref.action('String("XY")');
      expect((await ref.ascii())[0], "入力が入っていない").toContain("ABC");

      const out: string[] = [];
      const before = mini.inbound().length;
      // **AID 押下は待たない**——s3270 はキーボード施錠が解けるまで応答を返さない
      void ref.action("PA(1)").catch(() => {});
      await waitFor(() => mini.inbound().length, before + 1);
      out.push(mini.inbound()[before] ?? "");
      for (const s of STEPS) out.push(await step(mini, s.cmd, s.expectReply));
      return out;
    } finally {
      await ref.stop();
      await mini.close();
    }
  }

  /** 自実装で同じ操作をする */
  async function fromOurs(port: number): Promise<string[]> {
    const mini = await startMini3270({ records: [SCREEN], port });
    const s = new Tn3270Session({ host: "127.0.0.1", port, model: 2 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      expect(await waitFor(() => n, 1)).toBe(true);
      s.type("ABC"); // カーソルは IC で 11 に置かれている
      s.setCursor(1, 32); // アドレス 31＝2 つ目の非保護欄の先頭（s3270 の Tab() と同じ位置）
      s.type("XY");

      const out: string[] = [];
      const before = mini.inbound().length;
      s.send("pa1");
      await waitFor(() => mini.inbound().length, before + 1);
      out.push(mini.inbound()[before] ?? "");
      for (const st of STEPS) out.push(await step(mini, st.cmd, st.expectReply));
      return out;
    } finally {
      s.close();
      await mini.close();
    }
  }

  it("**一連の応答バイトが s3270 と完全に一致する**", async () => {
    expect(await s3270Available()).toBe(true);
    const ref = await fromS3270(3380, 6390);
    const ours = await fromOurs(3381);

    const labels = ["PA1 押下", ...STEPS.map((s) => s.name)];
    // 空振り防止——測れているかを先に確かめる
    expect(ref[0], "PA1 の短形式が取れていない").toBe("6c");
    expect(ref[1], "短形式の後の Read Modified が短形式でない").toBe("6c");
    expect(ref[2]!.length, "Read Modified All が空").toBeGreaterThan(2);
    expect(ref[4], "EAU に応答が返ってきている").toBe("");

    for (let i = 0; i < labels.length; i++) {
      expect(ours[i], `${labels[i]} が s3270 と違う`).toBe(ref[i]);
    }
  }, 200_000);

  it("**EAU 後の Read Buffer が語ること**を明示しておく（回帰したとき読めるように）", async () => {
    expect(await s3270Available()).toBe(true);
    const ours = await fromOurs(3382);
    const afterEau = ours[5]!; // Read Buffer（EAU の後）

    expect(afterEau.startsWith("60"), "AID を忘れていない").toBe(true);
    // カーソルはアドレス 11——最初の非保護桁
    const [hi, lo] = encodeAddress(11);
    expect(afterEau.slice(2, 6)).toBe(
      [hi, lo].map((b) => b!.toString(16).padStart(2, "0")).join("")
    );
    expect(afterEau).toContain("d7d9d6e3"); // 保護欄の "PROT" は残る
    expect(afterEau).not.toContain("c1c2c3"); // 非保護欄の "ABC" は消える
    expect(afterEau).not.toContain("e7e8"); // "XY" も消える
    // 非保護欄の属性は MDT が落ちて 0x40（= encodeAttribute(0x00)）
    expect(afterEau).toContain("1d40");
    // EAU の後は変更欄が無いので Read Modified は AID＋カーソルだけ
    expect(ours[6]!.length).toBe(6);
  }, 150_000);
});
