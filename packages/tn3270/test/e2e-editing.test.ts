import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA, CHARSET } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270, type Mini3270 } from "./harness/mini3270.js";

/**
 * **欄溢れと編集キー（後退・破壊的後退・削除・EOF 消去）の照合。**
 *
 * DBCS は 1 文字が 2 桁なので、境界の勘定がここで狂う。
 * `Read Buffer` の応答を桁ごとに開いて突き合わせる——**画面の見た目ではなくバッファの中身**を
 * 比べたいため（NUL と空白 0x40 は見た目が同じで意味が違う）。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 素の欄 11〜15 ／ 混在入力 21〜25 ／ DBCS 欄 41〜45（どれも 5 桁） */
const SCREEN = Uint8Array.from([
  CMD3270.ERASE_WRITE, WCC.RESTORE,
  ...sba(0), ORDER.SF, 0x60, 0xd7,
  ...sba(10), ORDER.SF, 0x00, ...sba(16), ORDER.SF, 0x60,
  ...sba(20), ORDER.SFE, 0x02, XA.BASIC, 0x00, XA.INPUT_CONTROL, 0x01,
  ...sba(26), ORDER.SF, 0x60,
  ...sba(40), ORDER.SFE, 0x02, XA.BASIC, 0x00, XA.CHARSET, CHARSET.DBCS,
  ...sba(46), ORDER.SF, 0x60,
  ...sba(11), ORDER.IC
]);

/** 欄の先頭アドレス。s3270 では Home ＋ Tab の回数で同じ場所へ行く */
const FIELDS = { plain: 11, mixed: 21, dbcs: 41 } as const;

type Step =
  | { type: string }
  | { key: "backspace" | "erase" | "delete" | "eraseEof" }
  | { home: keyof typeof FIELDS };

const CASES: { name: string; at: keyof typeof FIELDS; steps: Step[]; rejects: boolean }[] = [
  { name: "素の欄にちょうど 5 文字", at: "plain", steps: [{ type: "ABCDE" }], rejects: false },
  { name: "素の欄に 6 文字（溢れ）", at: "plain", steps: [{ type: "ABCDEF" }], rejects: true },
  { name: "混在欄に日本語 1 文字（4 桁）", at: "mixed", steps: [{ type: "日" }], rejects: false },
  { name: "混在欄に日本語 2 文字（6 桁で溢れる）", at: "mixed", steps: [{ type: "日本" }], rejects: true },
  { name: "DBCS 欄に日本語 2 文字（4 桁）", at: "dbcs", steps: [{ type: "日本" }], rejects: false },
  { name: "DBCS 欄に日本語 3 文字（6 桁で溢れる）", at: "dbcs", steps: [{ type: "日本語" }], rejects: true },
  { name: "混在欄: 日本語のあと後退キー", at: "mixed", steps: [{ type: "日" }, { key: "backspace" }], rejects: false },
  { name: "DBCS 欄: 日本語のあと後退キー", at: "dbcs", steps: [{ type: "日本" }, { key: "backspace" }], rejects: false },
  { name: "DBCS 欄: 破壊的な後退", at: "dbcs", steps: [{ type: "日本" }, { key: "erase" }], rejects: false },
  { name: "混在欄: 破壊的な後退で SO/SI ごと消える", at: "mixed", steps: [{ type: "日" }, { key: "erase" }], rejects: false },
  { name: "素の欄: 破壊的な後退", at: "plain", steps: [{ type: "AB" }, { key: "erase" }], rejects: false },
  { name: "素の欄: 削除キーで詰める", at: "plain", steps: [{ type: "ABC" }, { home: "plain" }, { key: "delete" }], rejects: false },
  { name: "DBCS 欄: 削除キーで 2 桁詰める", at: "dbcs", steps: [{ type: "日本" }, { home: "dbcs" }, { key: "delete" }], rejects: false },
  { name: "混在欄: EOF 消去", at: "mixed", steps: [{ type: "日" }, { home: "mixed" }, { key: "eraseEof" }], rejects: false }
];

const ACTION: Record<string, string> = {
  backspace: "BackSpace()",
  erase: "Erase()",
  delete: "Delete()",
  eraseEof: "EraseEOF()"
};
const TABS: Record<keyof typeof FIELDS, number> = { plain: 0, mixed: 1, dbcs: 2 };

async function waitFor(get: () => number, want: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (get() >= want) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** `Read Buffer` を撃って桁ごとに開く（属性桁は `[FA]`） */
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

/** 見たい 3 欄とカーソルだけを取り出す */
const view = (c: string[], cursor: number): string =>
  [c.slice(11, 16).join(" "), c.slice(21, 26).join(" "), c.slice(41, 46).join(" "), `cur=${cursor}`].join(" | ");

describe.skipIf(!enabled)("欄溢れと編集キー", () => {
  it("**バッファとカーソルが s3270 と一致する**", async () => {
    expect(await s3270Available()).toBe(true);

    // --- s3270
    const refOut: string[] = [];
    const mini1 = await startMini3270({ records: [SCREEN], port: 3406 });
    const ref = await S3270.start({
      host: "127.0.0.1", port: 3406, httpPort: 6409, name: "edit-cmp", codePage: "cp930"
    });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);
      for (const c of CASES) {
        mini1.send(SCREEN);
        await new Promise((r) => setTimeout(r, 600));
        await ref.action("Home()");
        for (let t = 0; t < TABS[c.at]; t++) await ref.action("Tab()");
        let rejected = false;
        for (const st of c.steps) {
          if ("type" in st) {
            const r = await ref.action(`String("${st.type}")`);
            if (r.join(" ").match(/error/i)) rejected = true;
          } else if ("home" in st) {
            await ref.action("Home()");
            for (let t = 0; t < TABS[st.home]; t++) await ref.action("Tab()");
          } else {
            await ref.action(ACTION[st.key]!);
          }
        }
        expect(rejected, `${c.name}: 撥ねる／撥ねないが想定と違う`).toBe(c.rejects);
        const cur = Number((await ref.action("Query(Cursor)"))[0]?.split(" ")[1] ?? -1);
        refOut.push(view(await cells(mini1), cur));
      }
    } finally {
      await ref.stop();
      await mini1.close();
    }

    // --- 自実装
    const ourOut: string[] = [];
    const mini2 = await startMini3270({ records: [SCREEN], port: 3407 });
    const s = new Tn3270Session({ host: "127.0.0.1", port: 3407, model: 2, ccsid: 930 });
    let n = 0;
    s.on("screen", () => n++);
    try {
      await s.connect();
      expect(await waitFor(() => n, 1)).toBe(true);
      for (const c of CASES) {
        const seen = n;
        mini2.send(SCREEN);
        await waitFor(() => n, seen + 1);
        const go = (f: keyof typeof FIELDS): void => s.setCursor(1, FIELDS[f] + 1);
        go(c.at);
        let rejected = false;
        for (const st of c.steps) {
          if ("type" in st) {
            try {
              s.type(st.type);
            } catch {
              rejected = true;
            }
          } else if ("home" in st) {
            go(st.home);
          } else {
            s[st.key]();
          }
        }
        expect(rejected, `${c.name}: 撥ねる／撥ねないが想定と違う`).toBe(c.rejects);
        const cur = s.snapshot().cursor;
        ourOut.push(view(await cells(mini2), (cur.row - 1) * 80 + cur.col - 1));
      }
    } finally {
      s.close();
      await mini2.close();
    }

    // 空振り防止——実際に文字が入っていること
    expect(refOut[0]).toContain("c1 c2 c3 c4 c5");
    expect(refOut[4]).toContain("45 62 45 66");
    for (let i = 0; i < CASES.length; i++) {
      expect(ourOut[i], CASES[i]!.name).toBe(refOut[i]);
    }
  }, 400_000);
});
