import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270, type Mini3270 } from "./harness/mini3270.js";

/**
 * **挿入モード・数字欄・`Dup`／`Field Mark`／入力消去の照合。**
 *
 * 挿入モードは「打った文字が上書きではなく割り込みになる」——欄の後ろがずれるので、
 * **満杯の欄には入らない**。数字欄は「制限があるのか」を確かめる目的
 * （**実装していないことも事実**として押さえておく）。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 10 非保護(11-15) ／ 20 **数字欄**(21-25) ／ 40 混在入力(41-45) */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE,
  ...sba(0), ORDER.SF, 0x60, 0xd7,
  ...sba(10), ORDER.SF, 0x00, ...sba(16), ORDER.SF, 0x60,
  ...sba(20), ORDER.SF, 0x10, ...sba(26), ORDER.SF, 0x60,
  ...sba(40), ORDER.SFE, 0x02, XA.BASIC, 0x00, XA.INPUT_CONTROL, 0x01,
  ...sba(46), ORDER.SF, 0x60,
  ...sba(11), ORDER.IC
]);

type Step =
  | { at: number }
  | { type: string }
  | { insert: boolean }
  | { key: "dup" | "fieldMark" | "eraseInput" };

const CASES: { name: string; steps: Step[]; rejects: boolean }[] = [
  { name: "上書き（既定）", steps: [{ at: 11 }, { type: "ABC" }, { at: 11 }, { type: "D" }], rejects: false },
  {
    name: "挿入モードで割り込む",
    steps: [{ at: 11 }, { type: "ABC" }, { at: 11 }, { insert: true }, { type: "D" }],
    rejects: false
  },
  {
    name: "満杯の欄には挿入できない",
    steps: [{ at: 11 }, { type: "ABCDE" }, { at: 11 }, { insert: true }, { type: "F" }],
    rejects: true
  },
  {
    name: "混在欄に DBCS を割り込ませる（SO/SI のぶん入らない）",
    steps: [{ at: 41 }, { type: "AB" }, { at: 41 }, { insert: true }, { type: "日" }],
    rejects: true
  },
  {
    name: "挿入モードは AID で解ける",
    steps: [{ at: 11 }, { type: "AB" }, { at: 11 }, { insert: true }, { type: "X" }],
    rejects: false
  },
  { name: "数字欄に数字", steps: [{ at: 21 }, { type: "123" }], rejects: false },
  { name: "**数字欄に英字も入る**（制限は掛かっていない）", steps: [{ at: 21 }, { type: "ABC" }], rejects: false },
  { name: "Dup は次の欄へ飛ぶ", steps: [{ at: 11 }, { type: "A" }, { key: "dup" }], rejects: false },
  { name: "Field Mark は 1 桁進むだけ", steps: [{ at: 11 }, { type: "A" }, { key: "fieldMark" }], rejects: false },
  {
    name: "入力消去は全部消してホームへ",
    steps: [{ at: 11 }, { type: "AB" }, { at: 21 }, { type: "12" }, { key: "eraseInput" }],
    rejects: false
  }
];

const ACTION: Record<string, string> = {
  dup: "Dup()", fieldMark: "FieldMark()", eraseInput: "EraseInput()"
};

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** `Read Buffer` を撃って桁ごとに開く */
async function cells(mini: Mini3270): Promise<string[]> {
  const before = mini.inbound().length;
  mini.send(Uint8Array.from([CMD3270.READ_BUFFER]));
  await waitFor(() => mini.inbound().length, before + 1);
  const b = Buffer.from(mini.inbound()[before] ?? "", "hex");
  const out: string[] = [];
  let i = 3;
  while (i < b.length && out.length < 1920) {
    if (b[i] === ORDER.SF) {
      out.push("[FA]");
      i += 2;
    } else if (b[i] === ORDER.SFE) {
      out.push("[FA]");
      i += 2 + (b[i + 1] ?? 0) * 2;
    } else {
      out.push((b[i] ?? 0).toString(16).padStart(2, "0"));
      i += 1;
    }
  }
  return out;
}

const view = (c: string[], cursor: number): string =>
  [c.slice(11, 16).join(" "), c.slice(21, 26).join(" "), c.slice(41, 46).join(" "), `cur=${cursor}`].join(" | ");

describe.skipIf(!enabled)("挿入モードと特殊キー", () => {
  it("**バッファとカーソルが s3270 と一致する**", async () => {
    expect(await s3270Available()).toBe(true);

    const refOut: string[] = [];
    const mini1 = await startMini3270({ records: [SCREEN], port: 3414 });
    const ref = await S3270.start({
      host: "127.0.0.1", port: 3414, httpPort: 6415, name: "ins-cmp", codePage: "cp930"
    });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);
      for (const c of CASES) {
        mini1.send(SCREEN);
        await new Promise((r) => setTimeout(r, 500));
        let rejected = false;
        for (const st of c.steps) {
          if ("at" in st) await ref.action(`MoveCursor(${Math.floor(st.at / 80)},${st.at % 80})`);
          else if ("insert" in st) await ref.action(st.insert ? "Insert()" : "Reset()");
          else if ("type" in st) {
            const r = await ref.action(`String("${st.type}")`);
            if (r.join(" ").match(/error/i)) rejected = true;
          } else await ref.action(ACTION[st.key]!);
        }
        expect(rejected, `${c.name}: 撥ねる／撥ねないが想定と違う`).toBe(c.rejects);
        const [r0, c0] = ((await ref.action("Query(Cursor)"))[0] ?? "").split(" ").map(Number);
        refOut.push(view(await cells(mini1), (r0 ?? 0) * 80 + (c0 ?? 0)));
      }
    } finally {
      await ref.stop();
      await mini1.close();
    }

    const ourOut: string[] = [];
    const mini2 = await startMini3270({ records: [SCREEN], port: 3415 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: 3415, model: 2, ccsid: 930 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      expect(await waitFor(() => n, 1)).toBe(true);
      for (const c of CASES) {
        const seen = n;
        mini2.send(SCREEN);
        await waitFor(() => n, seen + 1);
        s.setInsertMode(false);
        let rejected = false;
        for (const st of c.steps) {
          if ("at" in st) s.setCursor(Math.floor(st.at / 80) + 1, (st.at % 80) + 1);
          else if ("insert" in st) s.setInsertMode(st.insert);
          else if ("type" in st) {
            try {
              s.type(st.type);
            } catch {
              rejected = true;
            }
          } else s[st.key]();
        }
        expect(rejected, `${c.name}: 撥ねる／撥ねないが想定と違う`).toBe(c.rejects);
        const cur = s.snapshot().cursor;
        ourOut.push(view(await cells(mini2), (cur.row - 1) * 80 + cur.col - 1));
      }
    } finally {
      s.close();
      await mini2.close();
    }

    expect(refOut[1], "挿入で後ろがずれていない").toContain("c4 c1 c2 c3");
    expect(refOut[7], "Dup の 0x1c が入っていない").toContain("1c");
    for (let i = 0; i < CASES.length; i++) {
      expect(ourOut[i], CASES[i]!.name).toBe(refOut[i]);
    }
  }, 400_000);
});
