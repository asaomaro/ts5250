import type { Field } from "@as400web/core";
import { dbcsByteLength } from "./fieldValidate.js";

/**
 * **送信前の必須検証**（FFW の `MANDATORY_ENTER` 0x0008 / `MANDATORY_FILL` 0x0007）。
 *
 * ホストはこれを検証しない——実機で `CHECK(ME)` 欄を空・`CHECK(MF)` 欄を部分入力のまま
 * Enter を送ったところ、RPG が値をそのまま受け取った（`scripts/research-ffw.mjs` の実験 A）。
 * 参照実装も AID 送信時の検証を持たない（GNU tn5250 は検証自体が無く、tn5250j は Field Exit の
 * 中だけ）。**端末が止めなければ誰も止めない。**
 *
 * `ScreenGrid.vue` ではなくここに置くのは、判定が純関数で単体テストできるため
 * （コンポーネントに埋めると「空振りしていないか」を確かめる手段が無くなる）。
 */
export type MandatoryViolation = "mandatory-enter" | "mandatory-fill";

export interface MandatoryFinding {
  field: Field;
  reason: MandatoryViolation;
}

/**
 * 画面順で**最初の**違反を返す（無ければ undefined）。
 *
 * @param fields  画面の全フィールド（保護欄は自動で除外する）
 * @param edits   未送信の編集（`fieldIndex → 値`）。打鍵のたびに更新されるので、
 *                snapshot の `value` より新しい。**こちらを優先する**
 */
export function findMandatoryViolation(
  fields: readonly Field[],
  edits: ReadonlyMap<number, string>
): MandatoryFinding | undefined {
  for (const f of fields) {
    if (f.protected) continue;
    const edited = edits.get(f.index);
    // **非表示欄（パスワード等）は snapshot が値を持たない**（`value: hidden ? "" : ...`）。
    // 未編集なら「空」と「打ってあるが見えない」を区別できないので検査しない
    // （分からないものを弾かない側へ倒す）。
    if (f.hidden && edited === undefined) continue;
    const value = edited ?? f.value;
    const filled = value.trim().length > 0;

    if (f.mandatoryEnter && !filled) return { field: f, reason: "mandatory-enter" };

    // MANDATORY_FILL は「全部埋める」か「全部空」のどちらか（DDS の CHECK(MF) の定義）。
    // **部分入力だけを弾く**——空を弾くのは MANDATORY_ENTER の役目で、別の指定。
    if (f.adjust === "mandatory-fill" && filled && !isFull(f, value)) {
      return { field: f, reason: "mandatory-fill" };
    }
  }
  return undefined;
}

/**
 * 欄が全桁埋まっているか。
 *
 * `f.length` は**送信バイト予算**（DBCS は SO/SI と 2 バイトを含む）なので、
 * DBCS 欄では JS の文字数ではなく `dbcsByteLength` で見る。
 * 末尾の空白は「埋まっていない」扱い（送信値も末尾空白を落としている）。
 */
function isFull(f: Field, value: string): boolean {
  const v = value.replace(/ +$/, "");
  return (f.dbcsType ? dbcsByteLength(v) : v.length) >= f.length;
}
