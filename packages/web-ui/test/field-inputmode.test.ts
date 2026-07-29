import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { Cell, Field, ScreenSnapshot } from "@as400web/core";

/**
 * **モバイルの数字キーパッド（`inputmode`）。**
 *
 * ホストが「数字だけ」と申告した欄にだけ絞る。`digitsOnly`（FFW の digits-only）は
 * `field-validate.ts` の許容集合が `/^[0-9]*$/` で**本当に数字しか通らない**ので、
 * キーパッドを絞っても打てる文字は減らない。
 *
 * **`numeric` 全体には付けない。** numeric-only / signed-numeric は `.` `,` `+` `-` を
 * 許容しており、絞ると**打てるはずの文字が打てなくなる**
 * （AGENTS.md「環境の検出結果で選択肢を塞がない」）。
 */

const cell = (ch = " "): Cell =>
  ({ char: ch, kind: "sbcs", color: "green", reverse: false, underline: false,
     blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

const fld = (index: number, row: number, extra: Partial<Field>): Field =>
  ({ index, row, col: 2, length: 5, protected: false, numeric: false,
     hidden: false, mdt: false, value: "     ", ...extra }) as Field;

function snapOf(fields: Field[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push([...Array(80)].map(() => cell()));
  return { sessionId: "im", rows: 24, cols: 80, cursor: { row: 1, col: 1 },
           keyboardLocked: false, cells, fields } as ScreenSnapshot;
}

const modeOf = (w: ReturnType<typeof mount>, index: number) =>
  w.find(`input.grid-input[data-field-index="${index}"]`).attributes("inputmode");

describe("inputmode（モバイルの数字キーパッド）", () => {
  it("digits-only の欄にだけ numeric を付ける", () => {
    const w = mount(ScreenGrid, {
      props: {
        snapshot: snapOf([
          fld(0, 5, { numeric: true, digitsOnly: true }),
          fld(1, 6, { numeric: true }), // numeric-only（. , + - を許容）
          fld(2, 7, { numeric: true, signedNumeric: true }),
          fld(3, 8, {}) // 英数字欄
        ]),
        edits: new Map(), focused: false
      }
    });
    expect(modeOf(w, 0)).toBe("numeric");
    // **絞らない**——打てるはずの記号が打てなくなるため
    expect(modeOf(w, 1)).toBeUndefined();
    expect(modeOf(w, 2)).toBeUndefined();
    expect(modeOf(w, 3)).toBeUndefined();
    w.unmount();
  });

  it("保護欄には付けない", () => {
    const w = mount(ScreenGrid, {
      props: {
        snapshot: snapOf([fld(0, 5, { numeric: true, digitsOnly: true, protected: true })]),
        edits: new Map(), focused: false
      }
    });
    expect(modeOf(w, 0)).toBeUndefined();
    w.unmount();
  });
});
