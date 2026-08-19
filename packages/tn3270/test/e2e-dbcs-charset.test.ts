import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA, CHARSET, SO, SI } from "../src/protocol/constants.js";
import { S3270, s3270Available } from "./harness/s3270.js";
import { startMini3270 } from "./harness/mini3270.js";

/**
 * **文字セット属性（`XA.CHARSET` = 0xf8）による DBCS と、行末をまたぐ DBCS の照合。**
 *
 * `SO`/`SI` だけが DBCS の入口だと思って実装していたが、
 * **x3270 は 3 通り**を区別していた（`enum dbcs_why`）——SO/SI 区間・DBCS 欄・SA 指定。
 * また対の左右は**行ではなく区間の先頭からの偶奇**で決まるため、
 * **DBCS 1 文字が行末で割れる**。どちらも自実装に無かった。
 *
 * ここでは同じバイト列を s3270（`-codepage cp930`）と自実装に流し、**画面全体**を比べる。
 */

const enabled = process.env["TN3270_E2E"] === "1";
const codec = codecForCcsid(930);
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];
/** SO/SI を外した生の DBCS バイト列（DBCS 欄はこの形で運ぶ） */
const raw = (s: string): number[] => [...codec.encode(s).bytes].filter((b) => b !== SO && b !== SI);
const jp = raw("北海道");

const CASES: { name: string; body: number[]; must: RegExp }[] = [
  {
    name: "SFE の文字セット属性で欄まるごと DBCS（SO/SI なし）",
    // **アドレス 0 に置かない**——理由は下の「x3270 との差」を参照
    body: [...sba(0), ORDER.SF, 0x60, ...sba(1), ORDER.SFE, 0x02, XA.BASIC, 0x60,
           XA.CHARSET, CHARSET.DBCS, ...raw("日本語")],
    must: /日本語/
  },
  {
    name: "SA の文字セット属性で文字の並びだけ DBCS",
    body: [...sba(0), ORDER.SF, 0x60, ORDER.SA, XA.CHARSET, CHARSET.DBCS, ...raw("東京"),
           ORDER.SA, XA.CHARSET, CHARSET.BASE, 0xc1, 0xc2],
    must: /東京/
  },
  {
    name: "文字セット属性 0xf1（APL）は DBCS ではない",
    body: [...sba(0), ORDER.SF, 0x60, ...sba(1), ORDER.SFE, 0x02, XA.BASIC, 0x60,
           XA.CHARSET, CHARSET.APL, ...raw("福岡")],
    must: /./
  },
  {
    name: "DBCS 1 文字が行末で割れる（SO 区間）",
    body: [...sba(75), ORDER.SF, 0x60, SO, ...jp, SI],
    must: /北海/
  },
  {
    name: "対にならない左半分（奇数バイト）",
    body: [...sba(0), ORDER.SF, 0x60, SO, jp[0]!, jp[1]!, jp[2]!, SI],
    must: /北/
  },
  {
    name: "SI が来ないまま画面の終わりまで行く",
    body: [...sba(0), ORDER.SF, 0x60, SO, ...raw("大阪")],
    must: /大阪/
  }
];

const norm = (l: string): string => l.replace(/\s+$/, "");

function ourLines(record: Uint8Array): string[] {
  const s = new Screen3270(2);
  applyInbound(s, record);
  return snapshot(s, { ccsid: 930 }).cells.map((row) =>
    norm(row.map((c) => (c.kind === "dbcs-tail" ? "" : c.char)).join(""))
  );
}

describe.skipIf(!enabled)("文字セット属性の DBCS と行またぎ", () => {
  it("**どの入口でも画面全体が s3270 と一致する**", async () => {
    expect(await s3270Available()).toBe(true);
    // **1 画面につき 1 事例**——複数を 1 レコードに混ぜると相互作用で測定が壊れる（実際に踏んだ）
    const mini = await startMini3270({
      records: [Uint8Array.from([CMD3270.ERASE_WRITE, WCC.RESTORE, ...sba(0), ORDER.SF, 0x60, 0xc1])],
      port: 3394
    });
    const ref = await S3270.start({
      host: "127.0.0.1", port: 3394, httpPort: 6399, name: "dbcs-cs", codePage: "cp930"
    });
    try {
      expect(await ref.waitReady()).toBe(true);
      expect(await ref.waitForContent()).toBe(true);

      for (const c of CASES) {
        const record = Uint8Array.from([CMD3270.ERASE_WRITE, WCC.RESTORE, ...c.body]);
        mini.send(record);
        await new Promise((r) => setTimeout(r, 900));
        const refLines = (await ref.ascii()).map(norm);
        expect(refLines.join("\n"), `${c.name}: s3270 に何も出ていない`).toMatch(c.must);
        expect(ourLines(record), c.name).toEqual(refLines);
      }
    } finally {
      await ref.stop();
      await mini.close();
    }
  }, 240_000);
});
