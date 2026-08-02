import { describe, it, expect } from "vitest";
import { detectWindowRect } from "../src/composables/fkeyLegend.js";
import type { Cell, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * **反転表示が途切れなく閉じた矩形を作っていれば窓と判定する。**
 *
 * ホストの ATNPGM の窓（Attn の「コマンド入力」）は枠を**反転表示の空白セル**で描き、
 * 罫線文字を 1 つも使わない。そのため罫線ベースの検出では拾えず、
 * 窓が出ている間も**背面の F キー凡例がボタンとして残る**（押すと窓側の文脈で解釈されて
 * ラベルと食い違う）という実害が出ていた。
 *
 * 実機（PDM ＋ Attn）で採取した反転の分布:
 *
 * ```
 * 行18: 24-78            ← 上端（途切れなし）
 * 行19: 24-24 , 78-78    ← 左右端
 * 行20: 24-24 , 78-78
 * 行21: 24-24 , 78-78
 * 行22: 24-24 , 78-78
 * 行23: 24-78            ← 下端（上端と完全一致）
 * ```
 *
 * 反転は見出し行・メッセージ行・選択行の強調にも使われるため、**閉じていることを厳しく要求する**。
 * 弾く形のテストを判定する形と同数以上そろえてある。
 */

const ROWS = 24;
const COLS = 80;

function cell(char = " ", reverse = false): Cell {
  return {
    char,
    kind: "sbcs",
    color: reverse ? "white" : "green",
    reverse,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  } as Cell;
}

/** 反転セルの位置を `行 → [桁の閉区間…]` で与えてスナップショットを作る（1 始まり） */
function snapOf(reverseMap: Record<number, [number, number][]>, extra: Partial<ScreenSnapshot> = {}) {
  const cells: Cell[][] = [];
  for (let r = 1; r <= ROWS; r++) {
    const spans = reverseMap[r] ?? [];
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) {
      row.push(cell(" ", spans.some(([a, b]) => c >= a && c <= b)));
    }
    cells.push(row);
  }
  return {
    sessionId: "s",
    rows: ROWS,
    cols: COLS,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: [],
    ...extra
  } as unknown as ScreenSnapshot;
}

/** 実機の Attn 窓の反転分布 */
const ATTN: Record<number, [number, number][]> = {
  18: [[24, 78]],
  19: [[24, 24], [78, 78]],
  20: [[24, 24], [78, 78]],
  21: [[24, 24], [78, 78]],
  22: [[24, 24], [78, 78]],
  23: [[24, 78]]
};

describe("反転枠の窓判定", () => {
  it("実機の Attn 窓を判定し、外周をそのまま返す", () => {
    // **削らない**——上下端の行は枠ではなく中身（タイトル・F キー凡例が載る）。
    // 削ると 23 行目の凡例＝ボタンにしたい対象が落ちる。
    expect(detectWindowRect(snapOf(ATTN))).toEqual({ row1: 18, row2: 23, col1: 24, col2: 78 });
  });

  it("上下 2 本の反転バーだけでは判定しない（側面が繋がっていない）", () => {
    expect(detectWindowRect(snapOf({ 18: [[24, 78]], 23: [[24, 78]] }))).toBeNull();
  });

  it("側面が 1 行でも途切れたら判定しない", () => {
    const broken = { ...ATTN, 21: [[24, 24]] as [number, number][] }; // 右端が欠ける
    expect(detectWindowRect(snapOf(broken))).toBeNull();
  });

  it("上端と下端の桁が食い違えば判定しない", () => {
    const mismatched = { ...ATTN, 23: [[24, 70]] as [number, number][] };
    expect(detectWindowRect(snapOf(mismatched))).toBeNull();
  });

  it("反転の連なりが最小幅未満なら判定しない", () => {
    const narrow: Record<number, [number, number][]> = {
      18: [[24, 30]], // 7 桁
      19: [[24, 24], [30, 30]],
      20: [[24, 24], [30, 30]],
      21: [[24, 30]]
    };
    expect(detectWindowRect(snapOf(narrow))).toBeNull();
  });

  it("上下が隣接していれば（間の行が無ければ）判定しない", () => {
    expect(detectWindowRect(snapOf({ 18: [[24, 78]], 19: [[24, 78]] }))).toBeNull();
  });

  it("反転が 1 つも無い画面は判定しない", () => {
    expect(detectWindowRect(snapOf({}))).toBeNull();
  });

  it("入れ子のように複数あれば面積が最大のものを採る", () => {
    const two: Record<number, [number, number][]> = {
      ...ATTN,
      // 小さい枠を上の方に置く（面積は Attn 窓より小さい）
      5: [[10, 20]],
      6: [[10, 10], [20, 20]],
      7: [[10, 20]]
    };
    expect(detectWindowRect(snapOf(two))).toEqual({ row1: 18, row2: 23, col1: 24, col2: 78 });
  });
});

describe("既存経路は変わらない", () => {
  /** 罫線文字で描く窓（F1 ヘルプ相当） */
  function helpWindow(): ScreenSnapshot {
    const cells: Cell[][] = [];
    for (let r = 1; r <= ROWS; r++) {
      const row: Cell[] = [];
      for (let c = 1; c <= COLS; c++) {
        let ch = " ";
        if ((r === 6 || r === 20) && c >= 10 && c <= 70) ch = ".";
        else if (r > 6 && r < 20 && (c === 10 || c === 70)) ch = ":";
        row.push(cell(ch));
      }
      cells.push(row);
    }
    return {
      sessionId: "s", rows: ROWS, cols: COLS, cursor: { row: 1, col: 1 },
      keyboardLocked: false, cells, fields: []
    } as unknown as ScreenSnapshot;
  }

  it("罫線文字の窓は従来どおり内側を返す", () => {
    expect(detectWindowRect(helpWindow())).toEqual({ row1: 7, row2: 19, col1: 11, col2: 69 });
  });

  it("gui.windows があれば反転枠より優先する", () => {
    const snap = snapOf(ATTN, {
      gui: { windows: [{ row: 3, col: 5, width: 40, height: 10 }] }
    } as unknown as Partial<ScreenSnapshot>);
    // ホストが送る位置は枠の左上。中身はその 1 行下・3 桁右から（下の「宣言された窓と枠判定の範囲」参照）
    expect(detectWindowRect(snap)).toEqual({ row1: 4, row2: 13, col1: 8, col2: 47 });
  });

  /**
   * **塗り潰しの反転ブロックは窓ではない。**
   *
   * 上端・下端・側面の 3 条件は「全部が反転している矩形」でも当然すべて満たしてしまう。
   * 枠として本質的なのは**中が空いていること**で、その条件が抜けていた（実機で報告あり）。
   * 見出しの強調・選択行のハイライトが数行続けば起こりうる形。
   */
  it("内側まで全部反転した塗り潰しブロックは窓と判定しない", () => {
    const solid: Record<number, [number, number][]> = {
      18: [[24, 78]],
      19: [[24, 78]],
      20: [[24, 78]],
      21: [[24, 78]],
      22: [[24, 78]],
      23: [[24, 78]]
    };
    expect(detectWindowRect(snapOf(solid))).toBeNull();
  });

  it("最小サイズ（3 行）の塗り潰しブロックも窓と判定しない", () => {
    const solid: Record<number, [number, number][]> = {
      10: [[20, 40]],
      11: [[20, 40]],
      12: [[20, 40]]
    };
    expect(detectWindowRect(snapOf(solid))).toBeNull();
  });

  /**
   * **窓の中に全幅の反転行があっても窓と判定する。**
   * 選択中の行・見出し行が内側いっぱいに反転するのは普通なので、
   * 「内側の全行に非反転セルを要求する」という厳しい条件は採れない
   * （本物の窓を弾いてしまう）。
   */
  it("内側に全幅の反転強調行があっても、他の行が空いていれば窓と判定する", () => {
    const withHighlight: Record<number, [number, number][]> = {
      ...ATTN,
      20: [[24, 78]] // 内側の 1 行だけ全幅反転（選択行の強調）
    };
    expect(detectWindowRect(snapOf(withHighlight))).toEqual({
      row1: 18, row2: 23, col1: 24, col2: 78
    });
  });
});

/**
 * **宣言された窓の「使える範囲」と、表示設定の枠が使う矩形が一致しているか。**
 *
 * 枠の装飾・スモーク（窓の外を暗くする）・F キー凡例の絞り込みは、どれも
 * `detectWindowRect` の矩形を「窓の中身の範囲」として使う。ここが実際の窓と
 * ずれていると、枠が窓から外れ、窓の最終行の凡例が拾えず、窓の一部が暗くなる。
 *
 * 実際の使える範囲は実機（）で確定している。ホストが送るのは
 * SBA の位置（row, col）と深さ・幅だけで、**中身はその 1 行下・3 桁右から**始まる:
 *
 * | 画面 | ホストの窓 | DDS の定数 | ホストが書いた位置 |
 * |---|---|---|---|
 * | GRIDCL4 | SBA(16,19) 40x5 | `2 3'EXPLICIT BORDER CHARS'` | 行 18 桁 24 |
 * | GRIDCL5 | SBA(8,24) 30x8 | `2 3'WINDOW CONTENT'` | 行 10 桁 29 |
 *
 * どちらも「窓相対 (2,3) → 絶対 (row+2, col+4)」＝**中身の原点は (row+1, col+3)**。
 * 枠は中身の上下に 1 行・左右に 2 桁を使う（ACS の画素実測とも一致）。
 */
describe("宣言された窓と枠判定の範囲", () => {
  const declared = (w: { row: number; col: number; width: number; height: number }): ScreenSnapshot =>
    ({
      sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false,
      cells: Array.from({ length: 24 }, () =>
        Array.from({ length: 80 }, () => ({ char: " ", kind: "sbcs", color: "green" }))
      ),
      fields: [],
      gui: {
        selectionFields: [],
        windows: [{ id: 1, ...w, restrictCursor: false, pulldown: false }],
        scrollBars: [], gridLines: []
      }
    }) as unknown as ScreenSnapshot;

  it("実機 GRIDCL5 の窓（SBA(8,24) 30x8）の中身の範囲を返す", () => {
    // 中身は行 9〜16・桁 27〜56。ホストは "WINDOW CONTENT" を行 10 桁 29 に書いた
    expect(detectWindowRect(declared({ row: 8, col: 24, width: 30, height: 8 })))
      .toEqual({ row1: 9, row2: 16, col1: 27, col2: 56 });
  });

  it("実機 GRIDCL4 の窓（SBA(16,19) 40x5）でも一致する", () => {
    // 中身は行 17〜21・桁 22〜61。ホストは "EXPLICIT BORDER CHARS" を行 18 桁 24 に書いた
    expect(detectWindowRect(declared({ row: 16, col: 19, width: 40, height: 5 })))
      .toEqual({ row1: 17, row2: 21, col1: 22, col2: 61 });
  });

  it("中身の行数・桁数は宣言どおり", () => {
    const r = detectWindowRect(declared({ row: 8, col: 24, width: 30, height: 8 }))!;
    expect(r.row2 - r.row1 + 1).toBe(8);
    expect(r.col2 - r.col1 + 1).toBe(30);
  });
});
