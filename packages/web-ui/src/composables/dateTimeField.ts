/**
 * **EDTMSK で分割された欄から「日付らしい欄 / 時刻らしい欄」を見分ける。**
 *
 * ホストは `EDTMSK`（編集マスク）で割った数値欄を、区切り文字を挟んだ**複数の別々の欄**として送る
 * （`Field.continued` = first/middle/last。FCW `0x86xx`＝継続入力フィールド）。この**分解の形**が、
 * 日付・時刻を見分ける唯一の材料になる——`EDTCDE` / `EDTWRD` / `EDTMSK` そのものは DDS の
 * コンパイル時キーワードで、ワイヤには載らない。
 *
 * 【判定を「形が先・区切りが後」の 2 段にした理由 — spec 方針1 / decisions D2】
 *
 * 実機（IBM i 7.3・日本語機）で `TESTLIB/DTMDSPF` を実測した結果:
 *
 * 1. **区切り文字は、欄に値があるときしか画面に届かない。** 空の時刻欄（`EDTWRD('  :  :  ')`）は
 *    編集ワードごとゼロ抑制され、`:` が 1 桁も刷られない。しかも編集ワードの適用はホスト側なので、
 *    利用者がローカルで打っても現れない＝**空欄の間ずっと届かない**。
 * 2. **`-` は日付にも SSN にも出る。** `EDTWRD('   -  -    ')` の欄に値を入れると `123-45-6789`。
 *    区切りを先に見ると SSN を日付と誤る。
 *
 * → **常に届く「区間の桁数」で先に絞り**（`3,2,4` の SSN はここで落ちる）、**区切りは後段の確定にだけ使う**。
 *    区切りが届いていない `2,2,2` / `2,2` は日付とも時刻とも決めず `"both"` を返す（呼び出し側が
 *    利用者に選ばせる）。**推測を真実として扱わない**——これは 2026-07-30 に一度
 *    「datepicker を作らない」と決めた理由そのもの（`20260730-input-assist-datetime` の decisions D1）で、
 *    覆ったのは「分解しない」という**前提の実測**のほうだけ。
 *
 * 桁順（どの区間が年 / 月 / 日か）は**利用者合意のうえで固定**する（`YMD` / `HMS`）。
 * `YY/MM/DD` と `DD/MM/YY`、`MM/DD` と `YY/MM`、`HH:MM` と `MM:SS` は区別しない。
 * 呼び出し側は**解釈中の書式を UI に表示すること**（違えば直接打鍵に切り替えられる）。
 */
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

export type CharOf = (cell: Cell) => string;
const defaultCharOf: CharOf = (c) => (c.char === "" ? " " : c.char);

/** ピッカーが扱う種別。`both` = 形は合うが日付か時刻か決まらない（区切りが画面に出ていない） */
export type DateTimeKind = "date" | "time" | "both";

/** 日付として解釈したときの区間の役割。`y4`=西暦4桁 / `y2`=西暦下2桁 / `m`=月 / `d`=日 */
export type DatePart = "y4" | "y2" | "m" | "d";
/** 時刻として解釈したときの区間の役割。`h`=時 / `mi`=分 / `s`=秒 */
export type TimePart = "h" | "mi" | "s";

export interface DateTimeShape {
  /** 区間の桁数（先頭→最終）。例 [4,2,2] */
  lens: readonly number[];
  /** 日付としての並び。`lens` と 1:1。`null` = 日付としては解釈しない */
  dateParts: readonly DatePart[] | null;
  /** 時刻としての並び。`lens` と 1:1。`null` = 時刻としては解釈しない */
  timeParts: readonly TimePart[] | null;
}

export interface DateTimeTarget {
  /** 区間の並び（先頭→最終） */
  run: readonly Field[];
  kind: DateTimeKind;
  shape: DateTimeShape;
  /** 区間の間の桁に載っていた文字（区間数 - 1 個）。骨組みが出ていなければ `" "` */
  seps: readonly string[];
  /** ボタンを置く桁（最終区間の右隣 1 桁） */
  btn: { row: number; col: number };
}

export interface DateValue {
  /** 西暦 4 桁。2 桁欄では窓（下記 `YEAR_PIVOT`）で復元した値 */
  year: number;
  /** 1–12 */
  month: number;
  /** 1–31 */
  day: number;
}
export interface TimeValue {
  /** 0–23 */
  hour: number;
  /** 0–59 */
  minute: number;
  /** 0–59。`HH:MM` の欄では常に 0 */
  second: number;
}

/**
 * **2 桁年の窓。** `00–69` → `20xx` / `70–99` → `19xx`（広く使われる窓）。
 *
 * ホストへ書き込むのは 2 桁だけなので、**窓はピッカーの表示にしか効かない**
 * （どの年を選んでも欄に入るのは下 2 桁）。1970 年より前・2070 年以降を 2 桁欄で扱う画面では
 * 表示上の年が合わないが、直接打鍵は従来どおり可能（decisions D6）。
 */
const YEAR_PIVOT = 70;
export function expandYear2(yy: number): number {
  return yy < YEAR_PIVOT ? 2000 + yy : 1900 + yy;
}

/**
 * 日付の区切りとみなす文字。
 *
 * **実測で届いたのは `/` のみ**（`EDTCDE(Y)` と `EDTWRD('0   /  /  ')`）。`-` は SSN の欄で
 * 届くことを実測しており（だから形で先に絞る）、日付でも使われうる。**`.` は未実測**——
 * 編集ワード次第であり得るが、この実機では確認していない。形で絞ったあとの受け入れなので
 * 誤検出のリスクは低いと判断して含めている（decisions D5）。外すならこの集合から 1 文字消せばよい。
 */
const DATE_SEPS = new Set(["/", "-", "."]);
/** 時刻の区切り。実測で `EDTWRD('  :  :  ')` の欄に値を入れると届くことを確認済み。 */
const TIME_SEPS = new Set([":"]);

/**
 * 区間の桁数から書式を決める表（spec「判定表」）。
 *
 * **`2,2,4`（`DD/MM/YYYY` 系）は入れない。** 先頭 2 区間が「日・月」か「月・日」かを決める材料が
 * 届かず、固定した `YMD` 順にも当てはまらない（decisions D4）。
 * **`3,2,4`（SSN）も当然入らない**——ここで落ちるのが「形が先」の狙い。
 */
const SHAPES: readonly DateTimeShape[] = [
  { lens: [4, 2, 2], dateParts: ["y4", "m", "d"], timeParts: null },
  { lens: [2, 2, 2], dateParts: ["y2", "m", "d"], timeParts: ["h", "mi", "s"] },
  { lens: [2, 2], dateParts: ["m", "d"], timeParts: ["h", "mi"] },
];

function shapeOf(lens: readonly number[]): DateTimeShape | null {
  return SHAPES.find((s) => s.lens.length === lens.length && s.lens.every((n, i) => n === lens[i])) ?? null;
}

/**
 * **継続入力フィールドの区間の並び**（先頭 → 単独欄は自分 1 つ）。
 *
 * `composables/continuedRun.ts` の `continuedRunOf` と同じ歩き方だが、こちらは
 * **画面全体を 1 度だけ走査する**ために並びを直接組み立てる（欄ごとに呼ぶと O(n^2) になる）。
 * 判定条件（先頭・中間・最終の並び方）は同じで、片方だけ直すと食い違う点に注意。
 */
function runsOf(fields: readonly Field[]): Field[][] {
  const ordered = [...fields].sort((a, b) => a.index - b.index);
  const runs: Field[][] = [];
  let cur: Field[] | null = null;
  for (const f of ordered) {
    if (f.continued === undefined) {
      cur = null;
      continue;
    }
    if (cur === null || f.continued === "first") {
      cur = [f];
      runs.push(cur);
    } else {
      cur.push(f);
    }
    if (f.continued === "last") cur = null;
  }
  return runs;
}

/** その桁を覆う欄（無ければ undefined）。区間の間が「欄外＝静的・保護」かを見るのに使う。 */
function fieldCovering(fields: readonly Field[], row: number, col: number): Field | undefined {
  return fields.find((f) => f.row === row && col >= f.col && col < f.col + f.length);
}

/**
 * 入口の条件（すべて満たすこと）:
 * - 区間数が 2 または 3
 * - 全区間が非保護かつ `numeric`（保護欄にピッカーは出さない）
 * - 全区間が同一行
 * - 隣り合う区間の間が**ちょうど 1 桁**あき、その桁が**どの欄にも属さない**（＝静的・保護）
 *
 * 分類は `seps`（隙間の文字）が全区間で同一であることを要求する。`/` と `:` が混在する並びは
 * ホストの意図が読めないので出さない。
 */
/**
 * 画面から日付・時刻とみなせる分割欄をすべて取り出す。
 *
 * **判定は snapshot だけに依存させる**（欄の現在値を見ない）。値に依存させると、
 * 打鍵のたびに結果が作り直され、それを監視して閉じている**ピッカーが開いた直後に閉じる**
 * ——時刻の列を選ぶたびに閉じてしまい使えなくなる（実機 E2E で踏んだ。decisions D14）。
 * 初期選択に使う実効値は、**開いた時点で呼び出し側が捕まえて** `parseDate` / `parseTime` に渡す。
 */
export function detectDateTimeFields(
  snap: ScreenSnapshot,
  charOf: CharOf = defaultCharOf
): DateTimeTarget[] {
  const out: DateTimeTarget[] = [];
  for (const run of runsOf(snap.fields)) {
    if (run.length < 2 || run.length > 3) continue;
    // 壊れた並び（`first` で始まらない / `last` で終わらない）は判定しない。
    // ホストが送り損ねた並びを推測で補うと、桁の対応がずれたまま値を書き込むことになる。
    if (run[0]!.continued !== "first" || run[run.length - 1]!.continued !== "last") continue;
    if (run.some((f) => f.protected || !f.numeric)) continue;
    const row = run[0]!.row;
    if (run.some((f) => f.row !== row)) continue;

    const shape = shapeOf(run.map((f) => f.length));
    if (!shape) continue;

    // 区間の間はちょうど 1 桁で、どの欄にも属さないこと
    const seps: string[] = [];
    let ok = true;
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i]!, b = run[i + 1]!;
      const gapCol = a.col + a.length;
      if (b.col - gapCol !== 1) { ok = false; break; }
      if (fieldCovering(snap.fields, row, gapCol) !== undefined) { ok = false; break; }
      const cell = snap.cells[row - 1]?.[gapCol - 1];
      seps.push(cell ? charOf(cell) : " ");
    }
    if (!ok || seps.length !== run.length - 1) continue;
    if (seps.some((s) => s !== seps[0])) continue; // 区切りが不揃いな並びは出さない

    const sep = seps[0]!;
    const blank = sep.trim() === "";
    let kind: DateTimeKind;
    if (DATE_SEPS.has(sep)) {
      if (shape.dateParts === null) continue; // 形と区切りが矛盾（例: 時刻専用の形に `/`）
      kind = "date";
    } else if (TIME_SEPS.has(sep)) {
      if (shape.timeParts === null) continue; // 例: `4,2,2` に `:` — 日付の形なので出さない
      kind = "time";
    } else if (blank) {
      // 骨組みが出ていない。形から言えるところまでで止める（decisions D3）
      if (shape.dateParts !== null && shape.timeParts !== null) kind = "both";
      else if (shape.dateParts !== null) kind = "date";
      else kind = "time";
    } else {
      continue; // 知らない区切り文字。名乗らない
    }

    const last = run[run.length - 1]!;
    out.push({ run, kind, shape, seps, btn: { row, col: last.col + last.length } });
  }
  return out;
}

/**
 * 区間の値（`run` と 1:1）を連結した数字列。
 *
 * `values` を省くとホストが送った値（`Field.value`）を使う。**UI は未送信のローカル編集込みの
 * 実効値を渡すこと**——省くと「打った日付ではなく今日」でカレンダーが開く（review M2）。
 */
function joinedDigits(t: DateTimeTarget, values?: readonly string[]): string {
  const vals = values ?? t.run.map((f) => f.value);
  // 数値欄はホストが右詰めで刷る（実測: 値 0 の 2 桁区間は `" 0"`）。桁数に満たない値は
  // 右詰めとみなして左を空白で埋める。
  return t.shape.lens.map((len, i) => (vals[i] ?? "").padStart(len, " ").slice(-len)).join("");
}

/** 連結値を区間ごとに割り戻して数値にする。数字以外が混ざっていれば null。 */
function segmentNumbers(t: DateTimeTarget, values?: readonly string[]): number[] | null {
  const s = joinedDigits(t, values);
  const nums: number[] = [];
  let at = 0;
  for (const len of t.shape.lens) {
    const part = s.slice(at, at + len).trim();
    at += len;
    if (part === "" || !/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return nums;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** その年月の日数（グレゴリオ暦の閏年規則）。 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return DAYS_IN_MONTH[month - 1] ?? 31;
}

/**
 * 欄の現在値を日付として解釈する。解釈できなければ `null`。
 *
 * **範囲外（`00/00/00` のような初期値）も `null`**。呼び出し側は今日を初期選択にする
 * ——ただし**書き込まない**（ホストが送った値を UI が上書きしない）。
 */
export function parseDate(t: DateTimeTarget, values?: readonly string[]): DateValue | null {
  const parts = t.shape.dateParts;
  if (!parts) return null;
  const nums = segmentNumbers(t, values);
  if (!nums) return null;
  const today = new Date();
  let year = today.getFullYear(), month = 0, day = 0;
  parts.forEach((p, i) => {
    const n = nums[i]!;
    if (p === "y4") year = n;
    else if (p === "y2") year = expandYear2(n);
    else if (p === "m") month = n;
    else day = n;
  });
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (year < 1 || year > 9999) return null;
  return { year, month, day };
}

/** 欄の現在値を時刻として解釈する。解釈できなければ `null`。 */
export function parseTime(t: DateTimeTarget, values?: readonly string[]): TimeValue | null {
  const parts = t.shape.timeParts;
  if (!parts) return null;
  const nums = segmentNumbers(t, values);
  if (!nums) return null;
  let hour = 0, minute = 0, second = 0;
  parts.forEach((p, i) => {
    const n = nums[i]!;
    if (p === "h") hour = n;
    else if (p === "mi") minute = n;
    else second = n;
  });
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/**
 * 選んだ日付を「区間の連結桁数ぶんの数字列」にする（**区切りは含めない**）。
 *
 * 区切りを含めずに渡すのが要点——骨組みが出ていない欄では画面に区切りが無く、
 * 含めた文字列は `pasteFrom` 側の読み飛ばしに頼ることになる。桁数ちょうどの数字列なら
 * 骨組みの有無に左右されない（research N3）。
 */
export function formatDate(t: DateTimeTarget, v: DateValue): string {
  const parts = t.shape.dateParts;
  if (!parts) return "";
  return parts
    .map((p, i) => {
      const len = t.shape.lens[i]!;
      const n = p === "y4" ? v.year : p === "y2" ? v.year % 100 : p === "m" ? v.month : v.day;
      return String(n).padStart(len, "0").slice(-len);
    })
    .join("");
}

/** 選んだ時刻を数字列にする（`formatDate` と同じ約束）。 */
export function formatTime(t: DateTimeTarget, v: TimeValue): string {
  const parts = t.shape.timeParts;
  if (!parts) return "";
  return parts
    .map((p, i) => {
      const len = t.shape.lens[i]!;
      const n = p === "h" ? v.hour : p === "mi" ? v.minute : v.second;
      return String(n).padStart(len, "0").slice(-len);
    })
    .join("");
}

/** 解釈中の書式（`YYYY/MM/DD` 等）。**UI の見出しに出す**——桁順を固定している以上、名乗る責任がある。 */
export function formatLabel(t: DateTimeTarget, as: "date" | "time"): string {
  const sep = t.seps[0]!.trim() === "" ? (as === "date" ? "/" : ":") : t.seps[0]!;
  const parts = as === "date" ? t.shape.dateParts : t.shape.timeParts;
  if (!parts) return "";
  const word: Record<DatePart | TimePart, string> = {
    y4: "YYYY", y2: "YY", m: "MM", d: "DD", h: "HH", mi: "MM", s: "SS"
  };
  return parts.map((p) => word[p]).join(sep);
}
