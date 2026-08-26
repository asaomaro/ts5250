import { describe, it, expect } from "vitest";
import {
  detectDateTimeFields,
  parseDate,
  parseTime,
  formatDate,
  formatTime,
  formatLabel,
  expandYear2,
  daysInMonth
} from "../src/composables/dateTimeField.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **EDTMSK 分割欄の日付・時刻判定。**
 *
 * 判定は「形（区間の桁数）が先・区切りが後」（spec 方針1 / decisions D2）。実機実測の根拠:
 *
 * - **区切りは欄に値があるときしか届かない**（空の `TMW` は `:` が 1 桁も刷られない）
 *   → 区切りが空白でも `2,2,2` は日付か時刻のどちらかなので `both` を返す
 * - **`-` は SSN の欄にも出る**（`123-45-6789`）→ 区切りだけで日付と決めない。
 *   `3,2,4` は**形の段階で**落ちる
 *
 * 実機資材は `TESTLIB/DTMDSPF`（`scripts/build-dttest.mjs`）。ここに置く形はすべてそこで実測したもの。
 */

const COLS = 80;
const ROW = 3;

function cell(char = " "): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false
  } as Cell;
}
function fld(over: Partial<Field> & { index: number; col: number; length: number }): Field {
  return { row: ROW, protected: false, hidden: false, numeric: true, mdt: false, value: "", ...over } as Field;
}

/** 区間 `lens` を桁 `startCol` から `sep` で繋いだ並びを作る（`sep` が空白なら骨組み無し）。 */
function runOf(lens: number[], sep: string, opts: { values?: string[]; startCol?: number; over?: Partial<Field>[] } = {}) {
  const startCol = opts.startCol ?? 24;
  const fields: Field[] = [];
  const sepCols: number[] = [];
  let col = startCol;
  lens.forEach((len, i) => {
    const part: Field["continued"] = i === 0 ? "first" : i === lens.length - 1 ? "last" : "middle";
    fields.push(fld({ index: i + 1, col, length: len, continued: part, value: opts.values?.[i] ?? "", ...(opts.over?.[i] ?? {}) }));
    col += len;
    if (i < lens.length - 1) { sepCols.push(col); col += 1; }
  });
  return { fields, sepCols, sep };
}

function snapOf(runs: ReturnType<typeof runOf>[], extra: Field[] = []): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= 24; r++) {
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) row.push(cell());
    cells.push(row);
  }
  const fields: Field[] = [];
  for (const run of runs) {
    for (const f of run.fields) {
      fields.push(f);
      [...f.value].forEach((ch, i) => (cells[f.row - 1]![f.col - 1 + i] = cell(ch)));
    }
    for (const c of run.sepCols) cells[run.fields[0]!.row - 1]![c - 1] = cell(run.sep);
  }
  fields.push(...extra);
  return {
    sessionId: "s", rows: 24, cols: COLS, cursor: { row: ROW, col: 24 },
    keyboardLocked: false, cells, fields
  } as unknown as ScreenSnapshot;
}

const detect = (...runs: ReturnType<typeof runOf>[]) => detectDateTimeFields(snapOf(runs));

describe("判定（正例）— 区切りが画面に出ている", () => {
  // 実機 D8M / D8U: EDTWRD('0   /  /  ') + EDTMSK → 4,2,2 ＋ `/`
  it("4,2,2 ＋ `/` は日付（YYYY/MM/DD）", () => {
    const got = detect(runOf([4, 2, 2], "/"));
    expect(got).toHaveLength(1);
    expect(got[0]!.kind).toBe("date");
    expect(formatLabel(got[0]!, "date")).toBe("YYYY/MM/DD");
  });

  // 実機 DMA: EDTCDE(Y) + EDTMSK → 2,2,2 ＋ `/`
  it("2,2,2 ＋ `/` は日付（YY/MM/DD）", () => {
    const got = detect(runOf([2, 2, 2], "/"));
    expect(got[0]!.kind).toBe("date");
    expect(formatLabel(got[0]!, "date")).toBe("YY/MM/DD");
  });

  // 実機 TMW（値あり）: EDTWRD('  :  :  ') + EDTMSK → 2,2,2 ＋ `:`
  it("2,2,2 ＋ `:` は時刻（HH:MM:SS）", () => {
    const got = detect(runOf([2, 2, 2], ":"));
    expect(got[0]!.kind).toBe("time");
    expect(formatLabel(got[0]!, "time")).toBe("HH:MM:SS");
  });

  it("2,2 ＋ `/` は日付（MM/DD）", () => {
    const got = detect(runOf([2, 2], "/"));
    expect(got[0]!.kind).toBe("date");
    expect(formatLabel(got[0]!, "date")).toBe("MM/DD");
  });

  it("2,2 ＋ `:` は時刻（HH:MM）", () => {
    const got = detect(runOf([2, 2], ":"));
    expect(got[0]!.kind).toBe("time");
    expect(formatLabel(got[0]!, "time")).toBe("HH:MM");
  });

  it("`-` も日付の区切りとして受ける（形で先に絞っているので SSN と混ざらない）", () => {
    expect(detect(runOf([4, 2, 2], "-"))[0]!.kind).toBe("date");
  });
});

describe("判定（曖昧）— 区切りが画面に出ていない", () => {
  /**
   * 実機の `TMW` は空欄だと `:` が 1 桁も刷られず、`DMA` と**完全に同形**で届く。
   * ここで日付と決め打つと空の時刻欄に日付ピッカーが出る（decisions D3 で退けた案）。
   */
  it("2,2,2 ＋ 空白は both（日付か時刻か決めない）", () => {
    expect(detect(runOf([2, 2, 2], " "))[0]!.kind).toBe("both");
  });
  it("2,2 ＋ 空白は both", () => {
    expect(detect(runOf([2, 2], " "))[0]!.kind).toBe("both");
  });
  it("4,2,2 ＋ 空白は日付と断定してよい（先頭 4 桁の時刻形式は無い）", () => {
    expect(detect(runOf([4, 2, 2], " "))[0]!.kind).toBe("date");
  });
});

describe("判定（負例）— 出してはいけないもの", () => {
  // 実機 SSN: EDTWRD('   -  -    ') + EDTMSK → 3,2,4 ＋ `-`
  it("3,2,4（SSN）は区切りが `-` でも出さない", () => {
    expect(detect(runOf([3, 2, 4], "-"))).toHaveLength(0);
  });

  it("2,2,4（DD/MM/YYYY 系）は桁順を推測できないので出さない", () => {
    expect(detect(runOf([2, 2, 4], "/"))).toHaveLength(0);
  });

  it("4,2,2 ＋ `:` は形と区切りが矛盾するので出さない", () => {
    expect(detect(runOf([4, 2, 2], ":"))).toHaveLength(0);
  });

  // 実機 DMB / DTY / TMO / D8Z: EDTMSK 無し（または片方だけ保護）は分割されず 1 欄で届く
  it("単独欄（continued 無し）は出さない", () => {
    const snap = snapOf([], [fld({ index: 1, col: 24, length: 8, value: " 0/00/00" })]);
    expect(detectDateTimeFields(snap)).toHaveLength(0);
  });

  it("継続でない普通の数値欄が並んでいても出さない", () => {
    const snap = snapOf([], [
      fld({ index: 1, col: 24, length: 2 }),
      fld({ index: 2, col: 27, length: 2 }),
      fld({ index: 3, col: 30, length: 2 })
    ]);
    expect(detectDateTimeFields(snap)).toHaveLength(0);
  });

  it("区間の間が 2 桁以上あいていたら出さない", () => {
    const fields = [
      fld({ index: 1, col: 24, length: 2, continued: "first" }),
      fld({ index: 2, col: 28, length: 2, continued: "middle" }), // 間が 2 桁
      fld({ index: 3, col: 31, length: 2, continued: "last" })
    ];
    const snap = snapOf([], fields);
    expect(detectDateTimeFields(snap)).toHaveLength(0);
  });

  it("区間の間の桁が別の入力欄に覆われていたら出さない（静的な区切りではない）", () => {
    const run = runOf([2, 2, 2], "/");
    const snap = snapOf([run], [fld({ index: 9, col: run.sepCols[0]!, length: 1 })]);
    expect(detectDateTimeFields(snap)).toHaveLength(0);
  });

  it("保護された区間が混ざっていたら出さない", () => {
    expect(detect(runOf([2, 2, 2], "/", { over: [{}, { protected: true }, {}] }))).toHaveLength(0);
  });

  it("非数値の区間が混ざっていたら出さない", () => {
    expect(detect(runOf([2, 2, 2], "/", { over: [{}, { numeric: false }, {}] }))).toHaveLength(0);
  });

  it("区切りが不揃い（`/` と `:` の混在）なら出さない", () => {
    const run = runOf([2, 2, 2], "/");
    const snap = snapOf([run]);
    snap.cells[ROW - 1]![run.sepCols[1]! - 1] = cell(":");
    expect(detectDateTimeFields(snap)).toHaveLength(0);
  });

  it("知らない区切り文字（`#`）では名乗らない", () => {
    expect(detect(runOf([2, 2, 2], "#"))).toHaveLength(0);
  });

  it("`first` で始まらない壊れた並びは出さない", () => {
    const fields = [
      fld({ index: 1, col: 24, length: 2, continued: "middle" }),
      fld({ index: 2, col: 27, length: 2, continued: "last" })
    ];
    const snap = snapOf([], fields);
    snap.cells[ROW - 1]![25] = cell("/");
    expect(detectDateTimeFields(snap)).toHaveLength(0);
  });
});

describe("ボタンの位置", () => {
  it("最終区間の右隣 1 桁", () => {
    const got = detect(runOf([4, 2, 2], "/"));
    // 24..27 / 29..30 / 32..33 → 右隣は 34
    expect(got[0]!.btn).toEqual({ row: ROW, col: 34 });
  });
});

describe("値の解釈と組み立て", () => {
  it("現在値を日付として読む（4,2,2）", () => {
    const t = detect(runOf([4, 2, 2], "/", { values: ["2026", "08", "25"] }))[0]!;
    expect(parseDate(t)).toEqual({ year: 2026, month: 8, day: 25 });
  });

  it("現在値を時刻として読む（2,2,2 ＋ `:`）", () => {
    const t = detect(runOf([2, 2, 2], ":", { values: ["12", "34", "56"] }))[0]!;
    expect(parseTime(t)).toEqual({ hour: 12, minute: 34, second: 56 });
  });

  /**
   * **ホストのゼロ抑制で区間の値が先頭空白で届く。** 実機 `TMW`（`EDTWRD('  :  :  ')`）に
   * `093015` を送ると ` 9:30:15` で返る——編集ワードの先頭に `0` が無いので時の先頭ゼロが消える
   * （2026-08-26 実測）。数値欄は右詰めなので、先頭空白を右詰めとみなして読む。
   */
  it("ホストのゼロ抑制で先頭が空白になった値も読める", () => {
    const t = detect(runOf([2, 2, 2], ":", { values: [" 9", "30", "15"] }))[0]!;
    expect(parseTime(t)).toEqual({ hour: 9, minute: 30, second: 15 });
  });

  /**
   * **`Field.value` はホストが送った値**で、利用者が打った未送信の編集を含まない。
   * ピッカーの初期選択は**画面に見えている値**でなければならない（打った日付ではなく
   * 今日でカレンダーが開いてしまう。review M2）ので、`valueOf` で実効値を渡せるようにしてある。
   */
  it("`values` を渡すとホストの値より優先する（未送信の編集を反映する）", () => {
    const t = detect(runOf([4, 2, 2], "/", { values: ["2026", "08", "25"] }))[0]!;
    expect(parseDate(t)).toEqual({ year: 2026, month: 8, day: 25 });                       // 省くとホストの値
    expect(parseDate(t, ["2019", "03", "07"])).toEqual({ year: 2019, month: 3, day: 7 });  // 渡せばそちら
  });

  /**
   * **検出は snapshot だけに依存させる**（値を見ない）。値に依存させると打鍵のたびに結果が
   * 作り直され、それを監視して閉じているピッカーが**開いた直後に閉じる**（decisions D14）。
   */
  it("同じ snapshot からは同じ判定が出る（値を見ていない）", () => {
    const a = detect(runOf([4, 2, 2], "/", { values: ["2026", "08", "25"] }));
    const b = detect(runOf([4, 2, 2], "/", { values: ["", "", ""] }));
    expect(a.map((t) => t.kind)).toEqual(b.map((t) => t.kind));
    expect(a[0]!.shape.lens).toEqual(b[0]!.shape.lens);
  });

  it("空欄・初期値（00/00/00）は解釈しない（呼び出し側が今日を初期選択にする）", () => {
    expect(parseDate(detect(runOf([4, 2, 2], "/"))[0]!)).toBeNull();
    expect(parseDate(detect(runOf([2, 2, 2], "/", { values: ["00", "00", "00"] }))[0]!)).toBeNull();
  });

  it("範囲外（13 月・32 日・25 時）は解釈しない", () => {
    expect(parseDate(detect(runOf([4, 2, 2], "/", { values: ["2026", "13", "01"] }))[0]!)).toBeNull();
    expect(parseDate(detect(runOf([4, 2, 2], "/", { values: ["2026", "02", "30"] }))[0]!)).toBeNull();
    expect(parseTime(detect(runOf([2, 2, 2], ":", { values: ["25", "00", "00"] }))[0]!)).toBeNull();
  });

  it("組み立ては区切りを含まない桁数ちょうどの数字列（骨組みの有無に左右されない）", () => {
    const d8 = detect(runOf([4, 2, 2], "/"))[0]!;
    expect(formatDate(d8, { year: 2026, month: 8, day: 25 })).toBe("20260825");
    const d6 = detect(runOf([2, 2, 2], "/"))[0]!;
    expect(formatDate(d6, { year: 2026, month: 8, day: 25 })).toBe("260825");
    const md = detect(runOf([2, 2], "/"))[0]!;
    expect(formatDate(md, { year: 2026, month: 8, day: 25 })).toBe("0825");
    const t6 = detect(runOf([2, 2, 2], ":"))[0]!;
    expect(formatTime(t6, { hour: 1, minute: 2, second: 3 })).toBe("010203");
    const t4 = detect(runOf([2, 2], ":"))[0]!;
    expect(formatTime(t4, { hour: 9, minute: 5, second: 0 })).toBe("0905");
  });

  it("組み立て → 解釈で往復する", () => {
    const t = detect(runOf([2, 2, 2], "/"))[0]!;
    const s = formatDate(t, { year: 2026, month: 8, day: 25 });
    const back = detect(runOf([2, 2, 2], "/", { values: [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)] }))[0]!;
    expect(parseDate(back)).toEqual({ year: 2026, month: 8, day: 25 });
  });
});

describe("2 桁年の窓（decisions D6）", () => {
  it("00–69 は 20xx、70–99 は 19xx", () => {
    expect(expandYear2(0)).toBe(2000);
    expect(expandYear2(26)).toBe(2026);
    expect(expandYear2(69)).toBe(2069);
    expect(expandYear2(70)).toBe(1970);
    expect(expandYear2(99)).toBe(1999);
  });
  it("2 桁欄へ書き込むのは下 2 桁だけ（窓は表示にしか効かない）", () => {
    const t = detect(runOf([2, 2, 2], "/"))[0]!;
    expect(formatDate(t, { year: 1999, month: 1, day: 1 })).toBe("990101");
    expect(formatDate(t, { year: 2026, month: 1, day: 1 })).toBe("260101");
  });
});

describe("閏年", () => {
  it("グレゴリオ暦の規則に従う", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
  it("2 月 29 日は閏年なら読める", () => {
    expect(parseDate(detect(runOf([4, 2, 2], "/", { values: ["2024", "02", "29"] }))[0]!))
      .toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseDate(detect(runOf([4, 2, 2], "/", { values: ["2026", "02", "29"] }))[0]!)).toBeNull();
  });
});
