import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { FFW } from "../src/protocol/constants.js";

/**
 * **実機に発行させて採った 5250 コマンド**（2026-08-22・実機 / IBM i 7.3）。
 *
 * これらは**通常の画面では届かない**（20 画面 142 レコードの国勢調査でも 0 件）。
 * だが **IBM 自身が発行する API を出荷している**——動的画面管理（DSM）。
 * `QSYSINC/H(QSNAPI)` の手続きを呼ぶ C プログラムを実機に置いて出させた
 * （`scripts/host-src/dscmd.c` / `scripts/diag-5250-commands.mjs`）。
 *
 * | 発行させた API | 届いたバイト | ホスト側の結果 |
 * |---|---|---|
 * | `QsnRollUp(行数3, 上端2, 下端20)` | `04 23 03 02 14` | rc=0 |
 * | `QsnRollDown(行数3, 上端2, 下端20)` | `04 23 83 02 14` | rc=0 |
 * | `QsnReadImm` | `04 72` | rc=37 bytesRead=37 |
 * | `QsnReadMDTImmAlt` | `04 83` | rc=1 欄数=1 |
 * | `QsnPutInpCmd(0x66)` | `04 66` | rc=1024 |
 * | `QsnPutOutCmd(0xFE)` | `04 fe` | rc=0（**待たない**） |
 *
 * **ここで固定するのは実機のバイト列そのもの。**
 */

const codec = codecForCcsid(37);
const ESC = 0x04;

function makeBuffer(): ScreenBuffer {
  const b = new ScreenBuffer();
  b.setAttr(b.addrOf(5, 24), 0x24);
  b.addField(b.addrOf(5, 25), 10, FFW.ID_VALUE, 0x24);
  b.setAttr(b.addrOf(6, 24), 0x27);
  b.addField(b.addrOf(6, 25), 8, FFW.ID_VALUE, 0x27);
  return b;
}

const apply = (bytes: number[]): { result: ReturnType<typeof applyDataStream>; warns: string[] } => {
  const warns: string[] = [];
  const result = applyDataStream(Uint8Array.from(bytes), makeBuffer(), codec, (m) => warns.push(m));
  return { result, warns };
};

describe("ROLL(0x23) — 実機で発行させたバイト列", () => {
  /**
   * **方向ビットが実機で確定した。** `0x80` **落ち＝上へ / 立ち＝下へ**。
   *
   * 当方は以前これを逆に実装しており、原典 2 つを読んで直した（`20260730-tn5250-cross-check`）が
   * **実機では未確認のままだった**。`QsnRollUp` / `QsnRollDown` を出させて確かめた:
   *
   * ```
   * QsnRollUp  (行数3, 上端2, 下端20)  →  04 23 03 02 14
   * QsnRollDown(行数3, 上端2, 下端20)  →  04 23 83 02 14
   * ```
   *
   * **引数の並びも実測で決まった**——`(行数, 上端, 下端)`。最初 `(上端, 下端, 行数)` だと
   * 思って渡し、`CPFA315 ロール・パラメーターが正しくない` で落ちた。
   */
  it("**上へ**（`04 23 03 02 14`）——`0x80` が落ちている", () => {
    const { warns } = apply([ESC, 0x23, 0x03, 0x02, 0x14]);
    expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
  });

  it("**下へ**（`04 23 83 02 14`）——`0x80` が立っている", () => {
    const { warns } = apply([ESC, 0x23, 0x83, 0x02, 0x14]);
    expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
  });

  it("**パラメータは 3 バイト**——後続のコマンドを食わない", () => {
    // ROLL の直後に READ MDT FIELDS を置く。読み飛ばしすぎれば取りこぼす
    const { result, warns } = apply([ESC, 0x23, 0x03, 0x02, 0x14, ESC, 0x52, 0x00, 0x08]);
    expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
    expect(result.readRequested, "後続の READ が生き残る").toBe(true);
  });
});

describe("即時読み取り — 実機で発行させたバイト列", () => {
  it("`04 72`（READ IMMEDIATE）は即応答を要求する", () => {
    const { result } = apply([ESC, 0x72]);
    expect(result.readImmediateRequested).toBe(true);
    expect(result.readRequested, "入力待ちには入らない").toBe(false);
  });

  /**
   * **`0x83` は返さないとホストが固まる。** 実機で `QsnReadMDTImmAlt` を出させたら、
   * こちらは応答待ちで時間切れ、ホストは API から戻ってこなかった。
   * 実装したら `rc=1 / 欄数=1 / エラー無し` で通った。
   */
  it("`04 83`（READ MDT IMMEDIATE ALT）も即応答を要求する", () => {
    const { result } = apply([ESC, 0x83]);
    expect(result.readMdtImmediateAltRequested).toBe(true);
    expect(result.readRequested).toBe(false);
  });

  it("どちらもパラメータを持たない（実機のレコードは 12B ＝ ヘッダ 10 ＋ 2）", () => {
    for (const cmd of [0x72, 0x83]) {
      const { result, warns } = apply([ESC, cmd, ESC, 0x52, 0x00, 0x08]);
      expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
      expect(result.readRequested, `0x${cmd.toString(16)} の後続 READ が生き残る`).toBe(true);
    }
  });
});

describe("READ SCREEN TO PRINT — 実機で発行させたバイト列", () => {
  /**
   * **返さないとホストが固まる。** 実機で `QsnPutInpCmd(0x66)` を出させて確かめた。
   * 画面イメージ（`READ SCREEN`(0x62) と同じ形）を返したら `rc=1024 / エラー無し`で通った。
   */
  it("`04 66` は**画面イメージ**の返信を要求する", () => {
    const { result } = apply([ESC, 0x66]);
    expect(result.readScreenRequested).toBe(true);
  });

  it("グリッド版（`0x6a`）も同じ形", () => {
    expect(apply([ESC, 0x6a]).result.readScreenRequested).toBe(true);
  });

  it("拡張版（`0x68` / `0x6c`）は行区切り形式で返す", () => {
    expect(apply([ESC, 0x68]).result.readScreenExtendedRequested).toBe(true);
    expect(apply([ESC, 0x6c]).result.readScreenExtendedRequested).toBe(true);
  });
});

describe("未知のコマンド — 実機で発行させて確かめた", () => {
  /**
   * **ホストは待たない。** 実機で `QsnPutOutCmd(0xFE)` を出させたところ、
   * こちらは警告してレコードの残りを捨てただけだが、ホストは `rc=0` で正常に戻り、
   * セッションもそのまま続いた。
   *
   * **出力コマンドに負応答は要らない**——原典 2 つは返すが、返さなくても止まらない。
   * 形式を確かめられないものを推測で送るより、黙って捨てて**警告で気づけるようにする**方を採る。
   */
  it("`04 fe` は警告してレコードの残りを捨てる（気づけるように）", () => {
    const { result, warns } = apply([ESC, 0xfe, ESC, 0x52, 0x00, 0x08]);
    expect(warns.some((w) => w.includes("unknown command 0xfe"))).toBe(true);
    expect(result.readRequested, "残りは捨てる（長さが分からない以上そうするしかない）").toBe(false);
  });
});
