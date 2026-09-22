import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { MSG_NO_ROOM } from "../src/composables/opMessages.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **DBCS の欄の挿入モードの余地**（ACS `PS5250.reserveRoomForInsert`。`20260921-dbcs-insert-room`）。実機の ACS のコアで測った
 * （`scripts/acs-probe/dbcs-insert-room.txt`。DBCSFE の画面・930）:
 * - J・G・E（DBCS）は、末尾の**全角空白（U+3000）を空きに数える**——`あい□□□` の先頭へ `う` を挿入すると `うあい□□`（成功）。当 PJ は 0012 で拒否していた
 * - カーソルが**最終桁**なら空白でも 0012（J・E は SI の桁、O は最終のセル）。1 桁手前は入る
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});

/** J・E: 欄 (5,20) から SO ＋ スロット（全角 1 字＝2 桁）＋ SI。長さ＝スロット×2＋2 */
function dbcsSnapshot(type: "only" | "either" | "open", slots: string[]): { snapshot: ScreenSnapshot; field: Field } {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const r = cells[4]!;
  const col = 20;
  r[col - 1] = cell(" ", "so");
  slots.forEach((ch, i) => {
    r[col + i * 2] = cell(ch, "dbcs-lead");
    r[col + i * 2 + 1] = cell("", "dbcs-tail");
  });
  r[col + slots.length * 2] = cell(" ", "si");
  const field = { index: 1, row: 5, col, length: slots.length * 2 + 2, protected: false, hidden: false, numeric: false, mdt: false, value: slots.join(""), dbcsType: type } as Field;
  const next = { index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
  return { snapshot: { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col }, keyboardLocked: false, cells, fields: [field, next] } as unknown as ScreenSnapshot, field };
}

/** O: SBCS の並び（12 桁）。`text` を欄の先頭から置く */
function openSnapshot(text: string): { snapshot: ScreenSnapshot; field: Field } {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  [...text].forEach((ch, i) => (cells[4]![19 + i] = cell(ch)));
  const field = { index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: text, dbcsType: "open" } as Field;
  const next = { index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
  return { snapshot: { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [field, next] } as unknown as ScreenSnapshot, field };
}

/** O: 末尾が全角空白の欄（`ABCDEFGH` ＋ SO ＋ U+3000 ＋ SI ＝ 12 桁で満杯） */
function openWideBlankSnapshot(): { snapshot: ScreenSnapshot; field: Field } {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  [..."ABCDEFGH"].forEach((ch, i) => (cells[4]![19 + i] = cell(ch)));
  cells[4]![27] = cell(" ", "so");
  cells[4]![28] = cell("\u3000", "dbcs-lead");
  cells[4]![29] = cell("", "dbcs-tail");
  cells[4]![30] = cell(" ", "si");
  const field = { index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "ABCDEFGH\u3000", dbcsType: "open" } as Field;
  const next = { index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
  return { snapshot: { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [field, next] } as unknown as ScreenSnapshot, field };
}

async function open(snapshot: ScreenSnapshot) {
  const edits = new Map<number, string>();
  const w = mount(ScreenGrid, {
    props: { snapshot, edits, focused: true, busy: false, cursor: snapshot.cursor, onEdit: (i: number, v: string) => void edits.set(i, v) },
    attachTo: document.body
  });
  mounted.push(w as never);
  await nextTick();
  const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
  el.focus();
  await nextTick();
  const key = async (k: string) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    await nextTick();
  };
  const at = async (caret: number) => {
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };
  const select = async (from: number, to: number) => {
    el.setSelectionRange(from, to);
    await nextTick();
  };
  const compose = async (text: string) => {
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    el.value = el.value + text; // 確定した字（合成開始桁までの前置きの後ろ）
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
  };
  const paste = async (text: string) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => text };
    el.dispatchEvent(ev);
    await nextTick();
  };
  return { key, at, select, compose, paste, value: () => edits.get(1), notices: () => ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0]) };
}

describe("DBCS（J・E）の挿入: 末尾の全角空白は空き", () => {
  for (const type of ["only", "either"] as const) {
    it(`**${type}: \`あい□□□\` の先頭へ挿入 → \`うあい□□\`**（当 PJ は 0012 で拒否していた）`, async () => {
      const { snapshot } = dbcsSnapshot(type, ["あ", "い", "　", "　", "　"]);
      const { key, at, value, notices } = await open(snapshot);
      await at(1); // SO の次＝最初の全角
      await key("Insert");
      await key("う");
      // J は末尾の全角空白が詰め物として値から落ちる（`trimPad`。ホストが SO…SI を整える）。E は全角空白も値のまま
      expect(value()).toBe(type === "only" ? "うあい" : "うあい　　");
      expect(notices()).toEqual([]);
    });

    it(`**${type}: 3 スロット目（空きの先頭）へ挿入 → \`あいう□□\`**`, async () => {
      const { snapshot } = dbcsSnapshot(type, ["あ", "い", "　", "　", "　"]);
      const { key, at, value } = await open(snapshot);
      await at(3);
      await key("Insert");
      await key("う");
      expect(value()).toBe(type === "only" ? "あいう" : "あいう　　");
    });

    it(`${type}: 空きが無い（満杯）なら 0012 で値を変えない`, async () => {
      const { snapshot } = dbcsSnapshot(type, ["あ", "い", "う", "え", "お"]);
      const { key, at, value, notices } = await open(snapshot);
      await at(1);
      await key("Insert");
      await key("か");
      expect(value(), "変わらない").toBeUndefined();
      expect(notices()).toContain(MSG_NO_ROOM);
    });

    it(`**${type}: カーソルが最終桁（SI の桁）なら、空きがあっても 0012**`, async () => {
      const { snapshot } = dbcsSnapshot(type, ["あ", "い", "　", "　", "　"]);
      const { key, at, value, notices } = await open(snapshot);
      await at(6); // 最後のスロットの後ろ＝SI の桁
      await key("Insert");
      await key("う");
      expect(value()).toBeUndefined();
      expect(notices()).toContain(MSG_NO_ROOM);
    });
  }

  it("**上書きモードは変えない**（最終桁の判定は挿入だけ）", async () => {
    const { snapshot } = dbcsSnapshot("only", ["あ", "い", "　", "　", "　"]);
    const { key, at, value } = await open(snapshot);
    await at(1);
    await key("う"); // 上書き: 先頭の あ が う に
    expect(value()).toBe("うい");
  });
});

describe("DBCS（O）の挿入: 最終のセルは 0012・1 桁手前は入る。全角空白は空きに数えない", () => {
  it("**最終のセルにカーソルなら、空白でも 0012**", async () => {
    const { snapshot } = openSnapshot("ABCDEFGHIJK");
    const { key, at, value, notices } = await open(snapshot);
    await at(11);
    await key("Insert");
    await key("X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**1 桁手前は入る**（`ABCDEFGHIJK` の 11 桁目へ X → `ABCDEFGHIJXK`）", async () => {
    const { snapshot } = openSnapshot("ABCDEFGHIJK");
    const { key, at, value } = await open(snapshot);
    await at(10);
    await key("Insert");
    await key("X");
    expect(value()).toBe("ABCDEFGHIJXK");
  });
});

describe("DBCS 欄への貼り付け（挿入モード）も同じ規則", () => {
  it("**J: 先頭へ挿入で貼ると、末尾の全角空白を空きに使う**（`あい□□□` に `う` → `うあい□□`）", async () => {
    const { snapshot } = dbcsSnapshot("only", ["あ", "い", "\u3000", "\u3000", "\u3000"]);
    const { key, at, paste, value, notices } = await open(snapshot);
    await at(1);
    await key("Insert");
    await paste("う");
    expect(value()).toBe("うあい");
    expect(notices()).toEqual([]);
  });

  it("**J: 最終桁（SI の桁）での貼り付けは、空きがあっても 0012 で値を変えない**（事前の検査をすり抜けるぶん）", async () => {
    const { snapshot } = dbcsSnapshot("only", ["あ", "い", "\u3000", "\u3000", "\u3000"]);
    const { key, at, paste, value, notices } = await open(snapshot);
    await at(6);
    await key("Insert");
    await paste("う");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("上書きの貼り付けは通知を出さない（入るところまで黙って入れる）", async () => {
    const { snapshot } = dbcsSnapshot("only", ["あ", "い", "\u3000", "\u3000", "\u3000"]);
    const { at, paste, value, notices } = await open(snapshot);
    await at(1);
    await paste("う");
    expect(value()).toBe("うい");
    expect(notices()).toEqual([]);
  });
});

describe("O の挿入: 全角空白を空きに数えない・選択の置換／上書き／貼り付け／IME の最終桁", () => {
  it("**O: 末尾が全角空白の満杯欄は、全角空白を空きに数えず 0012**（ACS 実測 F1。J・G・E は数える）", async () => {
    const { snapshot } = openWideBlankSnapshot();
    const { key, at, value, notices } = await open(snapshot);
    await at(0);
    await key("Insert");
    await key("X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**上書きは最終のセルでも入る**（最終桁の判定は挿入だけ）", async () => {
    const { snapshot } = openSnapshot("ABCDEFGHIJKL");
    const { key, at, value, notices } = await open(snapshot);
    await at(11);
    await key("X");
    expect(value()).toBe("ABCDEFGHIJKX");
    expect(notices()).toEqual([]);
  });

  it("**選択を置き換える打鍵は、最終のセルでも入る**（消した跡を埋めるだけ。ACS の GUI の選択置換は**未測定**なので、従来どおり入れる）", async () => {
    const { snapshot } = openSnapshot("ABCDEFGHIJKL");
    const { key, at, select, value, notices } = await open(snapshot);
    await at(0);
    await key("Insert");
    await select(11, 12);
    await key("X");
    expect(value()).toBe("ABCDEFGHIJKX");
    expect(notices()).toEqual([]);
  });

  it("**IME の確定で選択を置き換えるときも同じ**", async () => {
    const { snapshot } = openSnapshot("ABCDEFGHIJKL");
    const { key, at, select, compose, value, notices } = await open(snapshot);
    await at(0);
    await key("Insert");
    await select(11, 12);
    await compose("X");
    expect(value()).toBe("ABCDEFGHIJKX");
    expect(notices()).toEqual([]);
  });

  it("**貼り付け（挿入）: 最終のセルなら 0012**（事前の検査は欄全体の余地だけ見るので通る。1 字ずつの打鍵と同じ）", async () => {
    const { snapshot } = openSnapshot("ABCDEFGHIJK");
    const { key, at, paste, value, notices } = await open(snapshot);
    await at(11);
    await key("Insert");
    await paste("X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });
});
