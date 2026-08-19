import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import {
  CMD3270, ORDER, WCC, XA, COLOR, HILITE, REPLY_MODE, CHARSET
} from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270, type Mini3270 } from "./harness/mini3270.js";

/**
 * **`Set Reply Mode`（構造化フィールド 0x09）を効かせた読み取りの照合。**
 *
 * ホストが「応答に拡張属性まで載せろ」と指示するための設定。3 段階ある:
 *
 * | モード | 属性桁 | 文字ごとの属性 |
 * |---|---|---|
 * | 欄（0） | `SF` ＋ 属性 | 載せない |
 * | 拡張欄（1） | **`SFE` ＋ 組** | 載せない |
 * | 文字（2） | `SFE` ＋ 組 | **`SA` オーダーで載せる**（種類はホストが指定） |
 *
 * 実装は指示を**読み飛ばしていた**ので、どのモードでも欄モードの形で返していた。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 拡張属性を持つ画面——欄に色と下線、文字の途中で色を変える */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE,
  ...sba(0), ORDER.SFE, 0x03, XA.BASIC, 0x60, XA.FOREGROUND, COLOR.RED,
  XA.HIGHLIGHT, HILITE.UNDERSCORE, 0xc1, 0xc2,
  ORDER.SA, XA.FOREGROUND, COLOR.BLUE, 0xc3, 0xc4,
  ORDER.SA, XA.ALL, 0x00, 0xc5,
  ...sba(20), ORDER.SF, 0x00, 0xe2,
  ...sba(40), ORDER.SFE, 0x02, XA.BASIC, 0x60, XA.CHARSET, CHARSET.APL,
  ...sba(60), ORDER.SF, 0x60,
  ...sba(21), ORDER.IC
]);

/** `Set Reply Mode` の構造化フィールド */
const setReplyMode = (mode: number, types: number[] = []): Uint8Array =>
  Uint8Array.from([
    CMD3270.WRITE_STRUCTURED_FIELD, 0x00, 5 + types.length, 0x09, 0x00, mode, ...types
  ]);

const MODES: { name: string; srm: Uint8Array }[] = [
  { name: "欄モード（既定）", srm: setReplyMode(REPLY_MODE.FIELD) },
  { name: "拡張欄モード", srm: setReplyMode(REPLY_MODE.EXTENDED_FIELD) },
  { name: "文字モード（種類指定なし）", srm: setReplyMode(REPLY_MODE.CHARACTER) },
  {
    name: "文字モード（色・ハイライト・文字セット）",
    srm: setReplyMode(REPLY_MODE.CHARACTER, [XA.FOREGROUND, XA.HIGHLIGHT, XA.CHARSET])
  }
];

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function shot(mini: Mini3270, rec: Uint8Array): Promise<string> {
  const before = mini.inbound().length;
  mini.send(rec);
  await waitFor(() => mini.inbound().length, before + 1);
  return mini.inbound()[before] ?? "";
}

describe.skipIf(!enabled)("Set Reply Mode を効かせた読み取り", () => {
  /** 各モードで Read Buffer を撃ち、応答を hex で集める */
  async function collect(who: "ref" | "ours", port: number, httpPort: number): Promise<string[]> {
    const mini = await startMini3270({ records: [SCREEN], port });
    const out: string[] = [];
    let stop: () => Promise<void>;
    try {
      if (who === "ref") {
        const ref = await S3270.start({ host: "127.0.0.1", port, httpPort, name: `srm-${port}` });
        expect(await ref.waitReady()).toBe(true);
        expect(await ref.waitForContent()).toBe(true);
        stop = () => ref.stop();
      } else {
        const s = new Tn3270Session({ host: "127.0.0.1", port, model: 2 });
        let n = 0;
        s.on("screen", () => n++);
        await s.connect();
        expect(await waitFor(() => n, 1)).toBe(true);
        stop = async () => s.close();
      }
      for (const m of MODES) {
        mini.send(m.srm);
        await new Promise((r) => setTimeout(r, 300));
        out.push(await shot(mini, Uint8Array.from([CMD3270.READ_BUFFER])));
      }
      // **モードが既定へ戻る条件を切り分ける。**
      // 「消して書いたら戻る」ではなく「**消して書く＋WCC のリセットビット**」の両方
      mini.send(MODES[1]!.srm);
      await new Promise((r) => setTimeout(r, 300));
      mini.send(Uint8Array.from([CMD3270.WRITE, WCC.RESTORE])); // 平の Write
      await new Promise((r) => setTimeout(r, 300));
      out.push(await shot(mini, Uint8Array.from([CMD3270.READ_BUFFER])));
      mini.send(SCREEN); // Erase/Write。ただし WCC はリセットビット無し
      await new Promise((r) => setTimeout(r, 400));
      out.push(await shot(mini, Uint8Array.from([CMD3270.READ_BUFFER])));
      mini.send(Uint8Array.from([...SCREEN].map((b, i) => (i === 1 ? WCC.RESET | WCC.RESTORE : b))));
      await new Promise((r) => setTimeout(r, 400));
      out.push(await shot(mini, Uint8Array.from([CMD3270.READ_BUFFER])));
      await stop();
      return out;
    } finally {
      await mini.close();
    }
  }

  it("**どのモードでも応答バイトが s3270 と一致する**", async () => {
    expect(await s3270Available()).toBe(true);
    const ref = await collect("ref", 3402, 6406);
    const ours = await collect("ours", 3403, 0);

    // 空振り防止——モードごとに形が変わっていること
    expect(ref[0], "欄モードなのに SF が無い").toContain("1d60");
    expect(ref[1], "拡張欄モードなのに SFE が無い").toContain("2903c060");
    expect(ref[3], "文字モードなのに SA が無い").toContain("2842");
    expect(ref[1], "拡張欄モードに SA が混ざっている").not.toContain("2842");
    expect(ref[4], "平の Write でモードが戻ってしまっている").toContain("2903c060");
    expect(ref[5], "リセットビットの無い Erase/Write で戻ってしまっている").toContain("2903c060");
    expect(ref[6], "Erase/Write ＋リセットビットで戻っていない").toContain("1d60");

    const labels = [
      ...MODES.map((m) => m.name),
      "平の Write の後",
      "Erase/Write（リセットビット無し）の後",
      "Erase/Write ＋リセットビットの後"
    ];
    for (let i = 0; i < labels.length; i++) {
      expect(ours[i], labels[i]).toBe(ref[i]);
    }
  }, 200_000);
});
