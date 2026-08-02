import { describe, it, expect } from "vitest";
import { detectWindowRect } from "../src/composables/fkeyLegend.js";
import type { Cell, ScreenSnapshot, WriteExtent } from "@ts5250/tn5250";

/**
 * **受信データの書き込み範囲で「反転枠が本当に窓か」を裏取りする。**
 *
 * 2026-07-28 の実測で、罫線・反転からの推測は 2 経路とも誤検出することが分かっていた:
 *
 * | 画面 | 従来 | 誤る経路 |
 * |---|---|---|
 * | ① 本物の窓（F1 ヘルプ相当） | 検出（正） | — |
 * | ② 一覧画面（`---` 区切り 2 本） | null（正） | — |
 * | ③ 表（左右に `:` が並ぶ帳票） | **誤検出** | 罫線 |
 * | ④ 反転バナー（見出し行＋末尾行が反転） | **誤検出** | 反転 |
 *
 * 2026-07-29 に実機（IBM i 7.3）で `lastWrite` を採ったところ、
 * **当初の前提は半分しか成り立たなかった**:
 *
 * - Attn の窓（反転枠）… `cleared=false` / `rect=r18-24` ＝ **重ね書き**
 * - **F1 ヘルプ窓（①）… `cleared=true` / `rect=r1-24` ＝ 全画面書き直し**
 * - 通常画面 … `cleared=true` / `rect=r1-24`
 *
 * ヘルプ窓は通常画面と受信データ上で区別が付かない（`real-help-window.test.ts`）。
 * よって **CLEAR を根拠に窓を否定できるのは反転経路だけ**——罫線経路に掛けると ① を落とす。
 *
 * 結果として本コミットが直すのは **④ のみ**。③ は従来どおり誤検出のまま残る（回帰はしない）。
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

function snapOf(
  opts: {
    text?: Record<number, string>;
    reverse?: Record<number, [number, number][]>;
    lastWrite?: WriteExtent;
  } = {}
): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 1; r <= ROWS; r++) {
    const line = opts.text?.[r] ?? "";
    const spans = opts.reverse?.[r] ?? [];
    const row: Cell[] = [];
    for (let c = 1; c <= COLS; c++) {
      row.push(cell(line[c - 1] ?? " ", spans.some(([a, b]) => c >= a && c <= b)));
    }
    cells.push(row);
  }
  const snap = {
    sessionId: "s",
    rows: ROWS,
    cols: COLS,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: []
  } as unknown as ScreenSnapshot;
  if (opts.lastWrite) snap.lastWrite = opts.lastWrite;
  return snap;
}

const pad = (col: number, s: string) => " ".repeat(col - 1) + s;

/** ④ 反転バナー（見出し行＋末尾行が反転する通常画面）。反転経路が誤検出していた形 */
const BANNER_REVERSE: Record<number, [number, number][]> = {
  18: [[24, 78]],
  19: [[24, 24], [78, 78]],
  20: [[24, 24], [78, 78]],
  21: [[24, 24], [78, 78]],
  22: [[24, 24], [78, 78]],
  23: [[24, 78]]
};

/** ③ 表（左右に `:` が並ぶ帳票）。罫線経路が誤検出していた形 */
const TABLE_TEXT: Record<number, string> = {
  3: pad(5, "-".repeat(70)),
  4: pad(5, ":") + pad(69, ":"),
  5: pad(5, ":") + pad(69, ":"),
  6: pad(5, ":") + pad(69, ":"),
  7: pad(5, ":") + pad(69, ":"),
  8: pad(5, "-".repeat(70))
};

/** ② 一覧画面（PDM 風。`---` 区切りが 2 本あるだけで縦罫が無い）。従来から正しく null */
const LIST_TEXT: Record<number, string> = {
  2: "  ライブラリー内のオブジェクトの処理",
  4: pad(3, "-".repeat(74)),
  5: "  OPT  オブジェクト   タイプ    属性     テキスト",
  6: pad(3, "-".repeat(74)),
  7: "       QGPL          *LIB      PROD"
};

/** 通常画面のレコード（実機実測: メニュー・PDM・DSPLIBL すべてこの形） */
const FULL_SCREEN_WRITE: WriteExtent = {
  rect: { row1: 1, row2: 24, col1: 1, col2: 80 },
  cleared: true,
  restored: false,
  cells: 1920
};

/** Attn の窓のレコード（実機実測: cleared=false / rect=r18-24 / cells=353） */
const ATTN_OVERLAY_WRITE: WriteExtent = {
  rect: { row1: 18, row2: 24, col1: 1, col2: 80 },
  cleared: false,
  restored: false,
  cells: 353
};

describe("反転枠を受信データで裏取りする", () => {
  describe("④ 反転バナーの誤検出が消える", () => {
    it("記録が無ければ従来どおり誤検出する（回帰の再現）", () => {
      expect(detectWindowRect(snapOf({ reverse: BANNER_REVERSE }))).not.toBeNull();
    });

    it("CLEAR を伴う通常画面なら窓と判定しない", () => {
      expect(
        detectWindowRect(snapOf({ reverse: BANNER_REVERSE, lastWrite: FULL_SCREEN_WRITE }))
      ).toBeNull();
    });

    it("RESTORE SCREEN の直後（窓を閉じた）も窓と判定しない", () => {
      const restored: WriteExtent = {
        rect: { row1: 1, row2: 24, col1: 1, col2: 80 },
        cleared: false,
        restored: true,
        cells: 1920
      };
      expect(
        detectWindowRect(snapOf({ reverse: BANNER_REVERSE, lastWrite: restored }))
      ).toBeNull();
    });
  });

  describe("Attn の窓は通す（重ね書きで来るため）", () => {
    it("CLEAR なしの部分書き込みなら従来どおり反転枠を返す", () => {
      const without = detectWindowRect(snapOf({ reverse: BANNER_REVERSE }));
      const withExtent = detectWindowRect(
        snapOf({ reverse: BANNER_REVERSE, lastWrite: ATTN_OVERLAY_WRITE })
      );
      expect(without).toEqual({ row1: 18, row2: 23, col1: 24, col2: 78 });
      expect(withExtent).toEqual(without);
    });
  });

  describe("罫線経路には掛けない（ヘルプ窓を落とさないため）", () => {
    it("③ 帳票は CLEAR を渡しても従来どおり誤検出する（本コミットでは直らない）", () => {
      // **意図的にそのまま**。③ とヘルプ窓は受信データ上で同じ形（CLEAR ＋ 全画面）をしており、
      // ここで切ると本物のヘルプ窓（実機 fixture: real-help-window.test.ts）が落ちる。
      const without = detectWindowRect(snapOf({ text: TABLE_TEXT }));
      const withExtent = detectWindowRect(snapOf({ text: TABLE_TEXT, lastWrite: FULL_SCREEN_WRITE }));
      expect(without).not.toBeNull();
      expect(withExtent).toEqual(without);
    });

    it("② 一覧画面は記録の有無によらず窓と判定しない", () => {
      expect(detectWindowRect(snapOf({ text: LIST_TEXT }))).toBeNull();
      expect(detectWindowRect(snapOf({ text: LIST_TEXT, lastWrite: FULL_SCREEN_WRITE }))).toBeNull();
    });
  });

  describe("記録が無い snapshot（既存テスト資産との互換）", () => {
    it("lastWrite が無ければ 1 つも結果が変わらない", () => {
      // 既存 4 本（window-view / stacked-window / reverse-frame-window / pane-cursor-window）は
      // 手組み snapshot・描画済み fixture で lastWrite を持たない
      expect(detectWindowRect(snapOf({ reverse: BANNER_REVERSE }))).not.toBeNull();
      expect(detectWindowRect(snapOf({ text: TABLE_TEXT }))).not.toBeNull();
      expect(detectWindowRect(snapOf({ text: LIST_TEXT }))).toBeNull();
      expect(detectWindowRect(snapOf({}))).toBeNull();
    });
  });

  describe("ホストの宣言（gui.windows）が最優先", () => {
    it("CLEAR 付きでも gui.windows があればそちらを返す", () => {
      const snap = snapOf({ reverse: BANNER_REVERSE, lastWrite: FULL_SCREEN_WRITE });
      snap.gui = {
        selectionFields: [],
        windows: [{ id: 1, row: 8, col: 24, width: 30, height: 8 } as never],
        scrollBars: [],
        gridLines: []
      };
      expect(detectWindowRect(snap)).toEqual({ row1: 9, row2: 16, col1: 27, col2: 56 });
    });
  });
});
