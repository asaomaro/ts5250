import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA, COLOR, HILITE } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **実ホストが一度も送ってこなかったコマンド／オーダーの検証。**
 *
 * fixture を数えたところ、TK4- と IBM i が送ってきたのは `EraseWrite` と `WSF` だけ、
 * オーダーは SBA・SF・SFE・RA・IC・PT だけだった。
 * **`Read Buffer` と `SA` / `MF` / `EUA` / `GE` は単体テストしか裏付けが無い。**
 *
 * ここを `s3270` との照合で埋める——同じバイトを両者に流し、
 * **画面**（描画結果）と**送信バイト**（Read Buffer の応答）を突き合わせる。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];
const txt = (s: string): number[] => [...codecForCcsid(37).encode(s).bytes];

/** SA / MF / EUA / GE をすべて使う画面 */
function orderScreen(): Uint8Array {
  return Uint8Array.from([
    CMD3270.ERASE_WRITE, WCC.RESTORE,
    // 1 行目: SA で以降の文字に色とハイライトを効かせる
    ...sba(0), ORDER.SF, 0x60,
    ORDER.SA, XA.FOREGROUND, COLOR.RED,
    ORDER.SA, XA.HIGHLIGHT, HILITE.UNDERSCORE,
    ...txt("SA COLOR"),
    // 2 行目: GE（次の 1 文字を拡張文字集合として扱う）
    ...sba(80), ORDER.SF, 0x60, ...txt("GE:"), ORDER.GE, 0xc1, ...txt("<"),
    // 3 行目: 非保護欄を作り、EUA で途中まで消す
    ...sba(160), ORDER.SF, 0x00, ...txt("EUAEUAEUAEUA"),
    ...sba(163), ORDER.EUA, ...encodeAddress(168),
    // 4 行目: SF を置いてから MF で属性を変える
    ...sba(240), ORDER.SF, 0x00, ...txt("MFTEST"),
    ...sba(240), ORDER.MF, 0x01, XA.BASIC, 0x20,
    ...sba(320), ORDER.SF, 0x60, ...txt("END")
  ]);
}

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

describe.skipIf(!enabled)("SA / MF / EUA / GE（実ホスト未経験のオーダー）", () => {
  it("**画面が s3270 と一致する**", async () => {
    expect(await s3270Available()).toBe(true);
    const rec = orderScreen();

    const mini1 = await startMini3270({ records: [rec], port: 3350 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: mini1.port, model: 2 });
    let n = 0;
    s.on("screen", () => n++);
    let ours: string[] = [];
    try {
      await s.connect();
      expect(await waitFor(() => n, 1)).toBe(true);
      ours = lines(s);
    } finally {
      s.close();
      await mini1.close();
    }

    const mini2 = await startMini3270({ records: [rec], port: 3351 });
    const ref = await S3270.start({ host: "127.0.0.1", port: mini2.port, httpPort: 6360, name: "ord-cmp" });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);
      const refLines = (await ref.ascii()).map((l) => l.replace(/\s+$/, ""));
      // 空振り防止——各オーダーの痕跡が実際に出ていること
      expect(refLines.join("\n")).toContain("SA COLOR");
      expect(refLines.join("\n")).toContain("MFTEST");
      expect(ours).toEqual(refLines);
    } finally {
      await ref.stop();
      await mini2.close();
    }
  }, 120_000);

  it("**EUA が非保護欄を指定範囲だけ消す**（s3270 と一致）", async () => {
    const rec = orderScreen();
    const mini = await startMini3270({ records: [rec], port: 3352 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: mini.port, model: 2 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      await waitFor(() => n, 1);
      // 3 行目: **桁 1 は属性桁**（SF が 1 桁使う）なので本文は桁 2＝アドレス 161 から。
      // EUA は 163〜167 を消すので、桁で言うと 4〜8。"EU" だけが手前に残る
      const row3 = lines(s)[2]!;
      expect(row3.slice(1, 3)).toBe("EU");         // 消していない部分は残る
      expect(row3.slice(3, 8).trim()).toBe("");     // EUA で消えた部分
      expect(row3.slice(8)).toBe("UAEUA");          // その先は残る
    } finally {
      s.close();
      await mini.close();
    }
  }, 60_000);

  it("**MF が既存の属性桁を書き換える**（非保護→保護）", async () => {
    const rec = orderScreen();
    const mini = await startMini3270({ records: [rec], port: 3353 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: mini.port, model: 2 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      await waitFor(() => n, 1);
      const f = s.snapshot().fields.find((x) => x.attrRow === 4 && x.attrCol === 1);
      expect(f, "4 行目の欄が無い").toBeDefined();
      expect(f!.protected, "MF で保護に変わっていない").toBe(true);
    } finally {
      s.close();
      await mini.close();
    }
  }, 60_000);

  it("**SA の色とハイライトがセルに乗る**", async () => {
    const rec = orderScreen();
    const mini = await startMini3270({ records: [rec], port: 3354 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: mini.port, model: 2 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      await waitFor(() => n, 1);
      const cell = s.snapshot().cells[0]!.find((c) => c.char === "S")!;
      expect(cell.color).toBe("red");
      expect(cell.underline).toBe(true);
    } finally {
      s.close();
      await mini.close();
    }
  }, 60_000);
});

describe.skipIf(!enabled)("Read Buffer の応答（実測の裏付けが無かった箇所）", () => {
  it("**自実装と s3270 の応答バイトが一致する**", async () => {
    expect(await s3270Available()).toBe(true);
    const screen = Uint8Array.from([
      CMD3270.ERASE_WRITE, WCC.RESTORE,
      ...sba(0), ORDER.SF, 0x60, ...txt("RB"),
      ...sba(10), ORDER.SF, 0x00, ...txt("IN")
    ]);
    const readBuffer = Uint8Array.from([CMD3270.READ_BUFFER]);

    /** 画面を出してから Read Buffer を撃ち、クライアントの応答を取る */
    const grab = async (who: "ref" | "ours", port: number, httpPort: number): Promise<string> => {
      const mini = await startMini3270({ records: [screen], port });
      try {
        if (who === "ref") {
          const ref = await S3270.start({ host: "127.0.0.1", port, httpPort, name: `rb-${who}` });
          expect(await ref.waitReady()).toBe(true);
          expect(await ref.waitForContent()).toBe(true);
          const before = mini.inbound().length;
          mini.send(readBuffer);
          await waitFor(() => mini.inbound().length, before + 1, 8000);
          await ref.stop();
          return mini.inbound()[before] ?? "";
        }
        const s = new Tn3270Session({ host: "127.0.0.1", port, model: 2 });
        let n = 0;
        s.on("screen", () => n++);
        await s.connect();
        await waitFor(() => n, 1);
        const before = mini.inbound().length;
        mini.send(readBuffer);
        await waitFor(() => mini.inbound().length, before + 1, 8000);
        s.close();
        return mini.inbound()[before] ?? "";
      } finally {
        await mini.close();
      }
    };

    const ref = await grab("ref", 3355, 6361);
    const ours = await grab("ours", 3356, 6362);
    expect(ref.length, "s3270 が Read Buffer に応答しない").toBeGreaterThan(0);
    expect(ours).toBe(ref);
  }, 150_000);
});
