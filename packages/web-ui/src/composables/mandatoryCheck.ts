import type { Field } from "@ts5250/tn5250";
// browser サブパスから取る（root は node:net/node:tls を巻き込むため不可）
import { selfCheckDigitOk } from "@ts5250/tn5250/browser";
import { dbcsByteLength } from "./fieldValidate.js";

/**
 * **送信前の必須検証**（FFW の `MANDATORY_ENTER` 0x0008 / `MANDATORY_FILL` 0x0007 と自己点検）。
 *
 * ホストはこれを検証しない——実機で `CHECK(ME)` 欄を空・`CHECK(MF)` 欄を部分入力のまま
 * Enter を送ったところ、RPG が値をそのまま受け取った（`scripts/research-ffw.mjs` の実験 A）。
 * **端末が止めなければ誰も止めない。**
 *
 * **いつ・何で判定するかは ACS に合わせる**（`20260921-mandatory-check-acs`。実機の ACS で 9 通りを測った）:
 * ME は全 AID（CA キーを除く）で・MDT で・画面が変更済みのときだけ、MF と自己点検はカーソル下の欄だけを
 * AID のときと欄を出るときに見る。~~Enter のときだけ・全欄を内容で判定する（`20260729-ffw-behavior-bits` D1）~~
 * は破棄した。
 *
 * `ScreenGrid.vue` ではなくここに置くのは、判定が純関数で単体テストできるため
 * （コンポーネントに埋めると「空振りしていないか」を確かめる手段が無くなる）。
 */
export type MandatoryViolation = "mandatory-enter" | "mandatory-fill" | "self-check" | "field-exit-required";

export interface MandatoryFinding {
  field: Field;
  reason: MandatoryViolation;
}

/** 欄の MDT（ホストが立てた MDT か、未送信の編集がある。ACS `Field5250.isMDTField` 相当） */
function mdtOf(f: Field, edits: ReadonlyMap<number, string>): boolean {
  return f.mdt || edits.has(f.index);
}

/**
 * **MF（必須埋め）の違反か**（ACS `Field5250.checkMandatoryFillField`）。
 * MF 欄で MDT があり、**満杯でも空でもない**（部分入力）とき。空を弾くのは ME の役目で別の指定。
 * 空の判定は従来どおり空白も空とみなす（ACS はヌルだけを空とみなす。空白だけ打った欄の差は未確認）。
 */
export function mandatoryFillViolated(f: Field, edits: ReadonlyMap<number, string>): boolean {
  if (f.adjust !== "mandatory-fill" || !mdtOf(f, edits)) return false;
  const value = edits.get(f.index) ?? f.value;
  return value.trim().length > 0 && !isFull(f, value);
}

/**
 * **自己点検（CHECK(M10)/CHECK(M11)）の違反か**（ACS `Field5250.checkModulusField`。MDT は見ない）。
 * **非表示欄で未編集のものは見ない**（snapshot は値を持たないので判定できない。分からないものは弾かない）。
 */
export function selfCheckViolated(f: Field, edits: ReadonlyMap<number, string>): boolean {
  if (f.selfCheck === undefined) return false;
  const edited = edits.get(f.index);
  if (f.hidden && edited === undefined) return false;
  const value = edited ?? f.value;
  return value.trim().length > 0 && !selfCheckDigitOk(value, f.selfCheck);
}

/**
 * **1 つの欄の検査**（MF → 自己点検の順）。AID のときは**カーソル下の欄**に、**欄を出るとき**は出る欄に掛ける
 * （ACS `PS5250.processAIDCode` / `moveCursorWithMandFillCheck`。実機でも、カーソルの無い欄の部分入力は
 * Enter で送れ、Tab で出ようとすると止まった。research F2 の場合 6・7）。
 */
export function findFieldViolation(
  f: Field | undefined,
  edits: ReadonlyMap<number, string>
): MandatoryFinding | undefined {
  if (!f || f.protected) return undefined;
  if (mandatoryFillViolated(f, edits)) return { field: f, reason: "mandatory-fill" };
  if (selfCheckViolated(f, edits)) return { field: f, reason: "self-check" };
  return undefined;
}

/**
 * **ME（必須入力）の違反**（ACS `FFT5250.checkMandatoryFieldCheck`）。画面順で最初のものを返す。
 *
 * - **内容ではなく MDT で判定する**——打ってから消した欄（MDT あり・空）は通る（実機の場合 8）
 * - **画面のどこも変更していなければ見ない**（ACS の `masterMDT`。実機の場合 1: 未変更の Enter は送れた）
 * - CA キー（SOH の申告）では呼ばないこと（呼び出し側の `sendKey` が決める）
 */
export function findMandatoryEnterViolation(
  fields: readonly Field[],
  edits: ReadonlyMap<number, string>
): MandatoryFinding | undefined {
  if (edits.size === 0 && !fields.some((f) => f.mdt)) return undefined;
  const hit = fields.find((f) => !f.protected && f.mandatoryEnter === true && !mdtOf(f, edits));
  return hit ? { field: hit, reason: "mandatory-enter" } : undefined;
}

/**
 * **欄を出ないまま AID を押せない欄か**（ACS のエラー 0020。`20260921-aid-without-field-exit`）。
 *
 * ACS `PS5250.processAIDCode` は、カーソル下の欄が**符号付き数値・CHECK(RZ)・CHECK(RB)** で、
 * 打ったあと欄を出ていなければ送らない。**自動 Enter 欄は除く**（満杯で自分から Enter を送るため）。
 * 右寄せは端末の仕事なので、出ずに送ると**左詰めのまま**ホストへ届く（実機で `12    `。research F2）。
 */
export function needsFieldExit(f: Field): boolean {
  if (f.autoEnter === true) return false;
  return f.signedNumeric === true || f.adjust === "right-zero" || f.adjust === "right-blank";
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
