/**
 * **欄を出るキー（Tab・Backtab・Home）と AID の前の検査**——ACS `PS5250.moveCursorWithMandFillCheck`・`processAIDCode`。
 *
 * AID の前は、カーソル下の欄の MF → 自己点検、画面が変更済みなら ME（CA キーを除く）を見る（`fieldViolation`・`mandatoryEnterViolation`。
 * `20260928-hllapi-aid-checks`。実機の ACS のコアで 9 場合を測ってある——`scripts/acs-probe/mandatory-me-mf.txt`）。
 *
 * ACS は Tab・Backtab・Home（ホーム位置でないとき）で行き先を決めたあと、**出る欄と行き先の欄が違えば**
 * 出る欄を MF（必須埋め）→ 自己点検の順に見て、違反ならカーソルを出る欄の先頭へ戻してエラー 20 / 21 で止まる。
 * 実機の ACS のコアでも、MF 欄に `AB` を打って Tab・欄頭からの Backtab・Home でどれも欄頭・入力禁止になり、
 * Tab の後ろに続けた字は入らなかった。欄の途中からの Backtab（同じ欄の先頭へ戻るだけ）は止まらない
 * （`scripts/acs-probe/hllapi-tab-mandatory.txt`。`20260927-hllapi-tab-mandatory`）。
 *
 * 判定の意味はペイン（`packages/web-ui/src/composables/mandatoryCheck.ts`）とそろえる——同じ画面で HLLAPI とペインの
 * 結果が食い違わないように（差は非表示欄と符号の桁。下の各所に書いた）。**空白を空とみなす**のもペインと同じ近似（ACS はヌルだけを空とみなすが、HLLAPI の書き込みは
 * 欄を空白で埋めるので、ヌルでは判定できない）。web-ui は未送信の編集を前提にしていてサーバーから使えないので、
 * スナップショットだけで判定する版をここに置く（HLLAPI の書き込みは core に即時に入る）。
 */
import type { Field, ScreenSnapshot } from "@ts5250/tn5250";
import { selfCheckDigitOk } from "@ts5250/tn5250";
import { fieldAt, fieldBytes, fieldStart, posToRowCol } from "./hllapi-ps.js";
import { decodeCp932 } from "./hllapi-cp932.js";

/**
 * `from` の欄を出て `to` へ動くとき、止めるべき違反があればその（出る）欄を返す。
 * `from` / `to` は 1 起点の PS 位置。**同じ欄の中の移動は見ない**（ACS も `getField(元) != getField(行き先)` のときだけ）。
 */
export function leaveViolation(snapshot: ScreenSnapshot, from: number, to: number): Field | undefined {
  const here = fieldAt(snapshot, from);
  if (!here || here.protected) return undefined;
  if (fieldAt(snapshot, to)?.index === here.index) return undefined;
  return fieldViolation(snapshot, here) ? here : undefined;
}

/**
 * 欄 1 つの MF → 自己点検（ACS `checkMandatoryFillField` → `checkModulusField`）。違反なら true。保護欄は見ない。
 */
export function fieldViolation(snapshot: ScreenSnapshot, here: Field): boolean {
  if (here.protected) return false;
  // 非表示欄はスナップショットに値が出ない（`fieldBytes` が空）ので判定しない。**ペインとの差**: ペインは打った値（編集）で判定できるが、
  // HLLAPI で書いたパスワード欄はここから読めない——ACS なら止まるところを通す（docs/HLLAPI.md に既知の差として書いた）
  if (here.hidden) return false;
  const value = decodeCp932(fieldBytes(snapshot, here));
  // 自己点検も符号付き数値の符号の桁を数えない（ACS `Field5250.checkModulusField`。ペインの `selfCheckViolated` も同じ——`20260928-mandatory-sign-digit`）
  const body = here.signedNumeric === true ? value.slice(0, -1) : value;
  if (mandatoryFillViolated(snapshot, here)) return true;
  return here.selfCheck !== undefined && body.trim().length > 0 && !selfCheckDigitOk(body, here.selfCheck);
}

/** MF だけの違反（AID の前の検査で、ACS の順〔MF → 0x20 → 自己点検〕に並べるため。保護欄・非表示欄は `fieldViolation` と同じく見ない） */
export function mandatoryFillOnly(snapshot: ScreenSnapshot, here: Field): boolean {
  if (here.protected || here.hidden) return false;
  return mandatoryFillViolated(snapshot, here);
}

/**
 * **ME（必須入力）の違反**（ACS `FFT5250.checkMandatoryFieldCheck`）: 画面が変更済み（ACS の `masterMDT`。ペインと同じく「どこかの欄に MDT」で近似）のとき、
 * MDT の無い ME の欄のうち最初のもの（欄の表の順＝番号の順）。保護欄は見ない。**内容ではなく MDT**——打ってから消した欄は通る
 */
export function mandatoryEnterViolation(snapshot: ScreenSnapshot): Field | undefined {
  if (!snapshot.fields.some((f) => f.mdt)) return undefined;
  return [...snapshot.fields]
    .sort((a, b) => a.index - b.index)
    .find((f) => !f.protected && f.mandatoryEnter === true && !runHasMdt(snapshot.fields, f));
}

/**
 * MF の違反か（ACS `Field5250.checkMandatoryFillField`）: MDT があり、空でも満杯でもない。
 * **末尾の空白は埋まっていない扱い**（ペインの `isFull` と同じ）。PS のバイトではなく**セルの種類**で見る:
 * - 中身は字のセル（半角の空白以外・全角）だけ。SO/SI は PS では空白になるうえ、全角のまま空にした E 欄は SO だけが残る
 *   （`ScreenBuffer.placeEmptyShift`）——SO/SI を中身に数えると空欄を「途中まで」と誤る
 * - 使った桁は最後の字まで。**字の直後の SI だけ**は数える（全角で終わる満杯の欄）。J 欄は欄の末尾に SI を置く（途中にヌル）ので、
 *   末尾の SI を無条件に数えると途中までの J 欄を「満杯」と誤る
 */
function mandatoryFillViolated(snapshot: ScreenSnapshot, f: Field): boolean {
  if (f.adjust !== "mandatory-fill" || !runHasMdt(snapshot.fields, f)) return false;
  const size = { rows: snapshot.rows, cols: snapshot.cols };
  const start = fieldStart(f, size);
  if (start === undefined) return false;
  // **符号付き数値は最終桁（符号の桁）を数えない**（ACS `Field5250.isFieldFull` / `isAllNulls`）
  const n = f.signedNumeric === true ? f.length - 1 : f.length;
  let used = 0;
  let any = false;
  for (let i = 0; i < n; i++) {
    const rc = posToRowCol(start + i, size);
    const cell = rc ? snapshot.cells[rc.row - 1]?.[rc.col - 1] : undefined;
    if (cell === undefined) continue;
    const content = cell.kind === "dbcs-lead" || cell.kind === "dbcs-tail" || (cell.kind === "sbcs" && cell.char !== " " && cell.char !== "");
    if (content) {
      any = true;
      used = i + 1;
    } else if (cell.kind === "si" && any && used === i) {
      used = i + 1;
    }
  }
  return any && used < n;
}

/**
 * **継続欄は並びのどこかに MDT があれば MDT**（ACS `PS5250.setMDT` は並びの全区間に立てる。
 * core は送信の都合で先頭区間だけに立てる——`ScreenBuffer.setFieldValue`）。
 * 並びは index の順に連続している（core の `continuedRun` と同じ歩き方）。
 */
function runHasMdt(fields: readonly Field[], f: Field): boolean {
  if (f.mdt) return true;
  if (f.continued === undefined) return false;
  const ordered = [...fields].sort((a, b) => a.index - b.index);
  let i = ordered.findIndex((x) => x.index === f.index);
  while (i > 0 && ordered[i]?.continued !== "first" && ordered[i - 1]?.continued !== undefined) i--;
  for (let j = i; j < ordered.length; j++) {
    const x = ordered[j]!;
    if (x.continued === undefined || (j > i && x.continued === "first")) break;
    if (x.mdt) return true;
    if (x.continued === "last") break;
  }
  return false;
}
