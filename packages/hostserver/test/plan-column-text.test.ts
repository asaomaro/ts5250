import { describe, it, expect } from "vitest";
import { codecForCcsid, katakanaChar, SO, SI } from "@ts5250/ebcdic";
import { unmangleColumnText } from "../src/db/plan-column-text.js";

/**
 * モニター列の論理名。**日本語システムでは catalog の説明が壊れて届く**——
 * DBCS 混在の文字列が SBCS（カタカナ）表で 1 バイトずつ変換されていて、
 * SO/SI が文字として残っている（実機 7.3 で実測。`QQTFN` の COLUMN_TEXT が
 * `"｣ﾃ｣ｰ｣J…"` の形で届く）。
 *
 * 1 文字 = 元の 1 バイトなので逆に引けば戻せる。ただし**カタカナ表に無いバイトは
 * ホスト側で落ちていて元の値が残っていない**（実測で 71 列中 33 列）。
 * そういう行は論理名として採用しない——半端に欠けた日本語より、
 * 列名そのものの方が誤解が無い。
 *
 * 壊れた固定文字列を貼るとこちらの写し間違いを試すことになるので、
 * **ホストがやった変換をそのまま再現して**壊し、戻せるかを見る。
 */
const codec = codecForCcsid(5026);
const SO_CHAR = String.fromCharCode(SO);
const SI_CHAR = String.fromCharCode(SI);

/**
 * ホスト側で起きている変換を再現する（DBCS 混在 → 1 バイト 1 文字）。
 * `lossy` は**カタカナ表に無いバイトがあった**＝ホストでも落ちる、の意味。
 */
function mangle(text: string): { text: string; lossy: boolean } {
  const { bytes } = codec.encode(text);
  let lossy = false;
  const out = [...bytes]
    .map((b) => {
      if (b === SO) return SO_CHAR;
      if (b === SI) return SI_CHAR;
      const ch = katakanaChar(b);
      // **表に無いバイトは `\uFFFD` が返る。** ホストでも同じように潰れる（実測は `U+001A`）
      if (!ch || ch === "\uFFFD") {
        lossy = true;
        return ch || "";
      }
      return ch;
    })
    .join("");
  return { text: out, lossy };
}

/** 壊し方の両方（戻せる／戻せない）が実際に出る並びを選んである */
const LABELS = ["結合位置", "副選択番号", "照会されたテーブルの名前", "テーブルの合計行数", "システム名"];

describe("壊れた列説明を戻す", () => {
  it("**戻せるものと戻せないものが両方ある**（この前提が崩れたら下の 2 件が空回りする）", () => {
    const m = LABELS.map((l) => mangle(l));
    expect(m.some((x) => !x.lossy)).toBe(true);
    expect(m.some((x) => x.lossy)).toBe(true);
  });

  it("潰された日本語を戻す（バイトが全部残っているとき）", () => {
    for (const label of LABELS) {
      const m = mangle(label);
      if (m.lossy) continue;
      expect(unmangleColumnText(m.text)).toBe(label);
    }
  });

  it("**バイトが落ちていれば採用しない**（欠けた日本語を論理名にしない）", () => {
    for (const label of LABELS) {
      const m = mangle(label);
      if (!m.lossy) continue;
      expect(unmangleColumnText(m.text)).toBeUndefined();
    }
  });

  it("英語システム（SO/SI が無い）はそのまま通す", () => {
    expect(unmangleColumnText("Table name")).toBe("Table name");
  });

  it("空白だけなら論理名にしない", () => {
    expect(unmangleColumnText("   ")).toBeUndefined();
  });
});
