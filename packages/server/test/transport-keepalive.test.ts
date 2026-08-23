import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **すべての TCP 経路がキープアライブを立てている**ことの検査。
 *
 * ## なぜソースを見るのか
 *
 * `setKeepAlive` の効果は**分単位の無通信でしか現れない**。単体テストでは再現できず、
 * 外して**も**型検査もテストもビルドも通る——**サイズも挙動も何も変わらない**ので、
 * 誰も気づかないまま落ちる。だから呼び出しの存在そのものを固定する。
 * （`@ts5250/ebcdic` の `catalog-no-tables.test.ts` と同じ考え方。）
 *
 * ## なぜ要るのか（実機で測った）
 *
 * 2026-08-22 に SR-OSAKA で測った（`scripts/measure-printer-idle-drop.mjs`）:
 *
 * | 経路 | 接続 | アイドル耐性 |
 * |---|---|---|
 * | 待ち行列監視 | `hostserver`（**キープアライブあり**） | 45 分を越える |
 * | 常駐プリンター | `tn5250`（**無し**） | **15 分で届かなくなる** |
 *
 * 5250 / VT / 3270 はどれも「何も届かないのが正常」な使い方を持つ
 * （帳票待ち・シェルのプロンプト・入力待ち）。その間パケットが 1 つも流れないので、
 * 途中の NAT やファイアウォールに落とされても**どちらの端も気づかない**。
 *
 * ⚠ **新しい経路を足したらここにも足すこと。**
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

/** ソケットを自分で張る経路。**ここに載っていない経路は検査されない** */
const SOCKET_SOURCES = [
  "packages/tn5250/src/transport/tcp.ts",
  "packages/tn3270/src/transport/tcp.ts",
  "packages/vt/src/transport/tcp.ts",
  "packages/hostserver/src/transport/host-connection.ts",
  "packages/hostserver/src/transport/ddm-transport.ts"
];

const src = (rel: string): string => readFileSync(join(repo, rel), "utf8");

describe("TCP キープアライブ", () => {
  it.each(SOCKET_SOURCES)("%s が setKeepAlive を呼ぶ", (rel) => {
    expect(src(rel)).toMatch(/setKeepAlive\(true,/u);
  });

  it("**平文と TLS の両方に入っている**（片方だけだと TLS の接続が黙って死ぬ）", () => {
    for (const rel of [
      "packages/tn5250/src/transport/tcp.ts",
      "packages/tn3270/src/transport/tcp.ts",
      "packages/vt/src/transport/tcp.ts"
    ]) {
      const calls = src(rel).match(/socket\.setKeepAlive\(true,/gu) ?? [];
      expect(calls.length, `${rel} は平文・TLS の 2 か所`).toBe(2);
    }
  });

  it("**待ちの値が経路ごとにばらけていない**（同じ性質の待ちを別の値にしない）", () => {
    const delays = new Set<string>();
    for (const rel of SOCKET_SOURCES) {
      for (const m of src(rel).matchAll(/setKeepAlive\(true,\s*([A-Z_0-9]+|[\d_]+)\)/gu)) {
        delays.add(m[1]!.replace(/_/gu, ""));
      }
    }
    // 定数名で書いてあるものは値を解決できないので、**数値で書かれたものだけ**突き合わせる
    const numeric = [...delays].filter((d) => /^\d+$/u.test(d));
    expect(new Set(numeric).size, `見つかった値: ${numeric.join(", ")}`).toBeLessThanOrEqual(1);
    if (numeric.length > 0) expect(numeric[0]).toBe("60000");
  });

  /**
   * ⚠ **`setNoDelay` の隣にあるか**まで見る。接続確立の分岐が増えたときに、
   * 片方の枝だけ足し忘れる形で漏れるため。
   */
  it("`setNoDelay` を呼ぶ箇所と同じ数だけ `setKeepAlive` を呼ぶ", () => {
    for (const rel of SOCKET_SOURCES) {
      const text = src(rel);
      const noDelay = (text.match(/setNoDelay\(/gu) ?? []).length;
      if (noDelay === 0) continue; // `setNoDelay` を使わない経路は対象外
      const keepAlive = (text.match(/setKeepAlive\(/gu) ?? []).length;
      expect(keepAlive, rel).toBeGreaterThanOrEqual(noDelay);
    }
  });
});
