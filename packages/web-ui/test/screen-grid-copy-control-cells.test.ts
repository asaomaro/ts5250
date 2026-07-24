import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

/**
 * **画面に出ていない桁は、クリップボードにも「見えているとおり」の空白で載せる。**
 *
 * 表示されない桁は SO/SI だけではない:
 *   - 属性桁（色制御。画面上 1 桁を占め空白に見える）
 *   - 非表示属性の桁（パスワード等。core が空白でマスク済み）
 *   - 表示できない SBCS バイト（U+FFFD。描画は空白）
 *   - 欄の値に埋め込まれた属性・表示不能バイトの**私用面センチネル**（描画は空白）
 * SO/SI と違って**桁は占める**ので、落とさず空白 1 桁として写す（貼り付け先の桁が揃う）。
 * センチネルをそのまま載せると、私用面の文字がクリップボードに乗るうえ `isFullWidth` が
 * 私用面を全角と見なすため桁の数え方まで狂う。
 */
function cell(char = " ", extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  };
}

function blank(): Cell[][] {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return cells;
}

async function copyRect(
  cells: Cell[][],
  fields: Field[],
  rect: { r1: number; c1: number; r2: number; c2: number }
): Promise<string | undefined> {
  const snapshot: ScreenSnapshot = {
    sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields
  };
  const w = mount(ScreenGrid, {
    props: { snapshot, edits: new Map(), focused: true },
    attachTo: document.body
  });
  await nextTick();
  (w.vm as unknown as { setBlockSelection: (r: unknown) => void }).setBlockSelection(rect);
  const cd = { setData: vi.fn() };
  const ev = new Event("copy") as Event & { clipboardData: typeof cd };
  ev.clipboardData = cd;
  document.dispatchEvent(ev);
  w.unmount();
  return cd.setData.mock.calls[0]?.[1] as string | undefined;
}

/** 値に埋め込まれるセンチネル（core の attr-sentinel と同じ規則: U+E000 + バイト） */
const ATTR_SENTINEL = String.fromCharCode(0xe000 + 0x28); // 欄途中の色替え（赤）
const RAW_SENTINEL = String.fromCharCode(0xe000 + 0x9f); // 表示できない SBCS バイト

describe("表示されない桁のコピー", () => {
  it("入力欄の埋め込み属性・表示不能バイトは空白 1 桁で写る（桁もずれない）", async () => {
    const f: Field = {
      index: 1, row: 3, col: 5, length: 10,
      protected: false, hidden: false, numeric: false, mdt: false,
      value: `AB${ATTR_SENTINEL}CD${RAW_SENTINEL}E`
    };
    // 桁 5..12 = A B 属性 C D 不能 E パディング
    expect(await copyRect(blank(), [f], { r1: 3, c1: 5, r2: 3, c2: 12 })).toBe("AB CD E ");
  });

  it("保護テキストの属性桁・非表示桁・表示不能バイトも空白 1 桁で写る", async () => {
    const cells = blank();
    cells[2]![4] = cell("A");
    cells[2]![5] = cell(" ", { kind: "attr", color: "red" }); // 色制御
    cells[2]![6] = cell("�"); // 表示できないバイト
    cells[2]![7] = cell(" ", { nonDisplay: true }); // 非表示属性の桁
    cells[2]![8] = cell("B");
    expect(await copyRect(cells, [], { r1: 3, c1: 5, r2: 3, c2: 9 })).toBe("A   B");
  });

  it("hidden 欄は伏せ字も実値も載せない（空白のみ）", async () => {
    const f: Field = {
      index: 1, row: 3, col: 5, length: 6,
      protected: false, hidden: true, numeric: false, mdt: false, value: ""
    };
    expect(await copyRect(blank(), [f], { r1: 3, c1: 5, r2: 3, c2: 10 })).toBe("      ");
  });
});
