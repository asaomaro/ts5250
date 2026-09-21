import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { MSG_NO_ROOM } from "../src/composables/opMessages.js";
import { dbcsByteLength } from "../src/composables/fieldValidate.js";
import { mandatoryFillViolated } from "../src/composables/mandatoryCheck.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **純 DBCS の欄（DDS の G 型。FCW 0x8220）は SO/SI の桁を持たない。**（`20260922-g-field-sosi`）
 *
 * 実機の DDS の G 型で確かめた: 12 バイトの欄に全角 6 字が SO/SI 無しで入る（ワイヤも SO/SI 無しの 12 バイト。core の
 * `dbcs-pure-field.test.ts`）。当 PJ の編集は G にも SO/SI の 2 桁を数えていたので、6 字目が入らず、列ビューの先頭と末尾に空白の桁が付いた。
 * 実機の ACS のコア（DBCSFE の G）: `あい□□□□`（□＝全角空白）の先頭へ挿入で `う` が入る（末尾の □ が 1 つ押し出される）。
 * 空きの詰め物は**全角空白**（ACS の G の空きは DBCS 空白 0x4040）。半角空白を入れると、途中に字を打ったとき前に半角が残って「全角しか入力できない」で送れない。
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

/** G の欄（(5,20) から 12 桁＝6 スロット）。`slots` の各字を 2 桁の組で置く（SO/SI の桁は無い）。足りないぶんは全角空白 */
function gSnapshot(slots: string[], opts: { emptyCells?: boolean } = {}): { snapshot: ScreenSnapshot; field: Field } {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  if (!opts.emptyCells) {
    for (let i = 0; i < 6; i++) {
      cells[4]![19 + i * 2] = cell(slots[i] ?? "　", "dbcs-lead");
      cells[4]![20 + i * 2] = cell("", "dbcs-tail");
    }
  }
  const field = { index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", dbcsType: "pure" } as Field;
  const next = { index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "" } as Field;
  return { snapshot: { sessionId: "g1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [field, next] } as unknown as ScreenSnapshot, field };
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
  const key = async (k: string, init: KeyboardEventInit = {}) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
    await nextTick();
  };
  const at = async (caret: number) => {
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };
  return { el, key, at, value: () => edits.get(1), notices: () => ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0]), edited: () => (w.emitted("edit") as unknown[][] | undefined) ?? [] };
}

describe("G の欄は SO/SI を数えない", () => {
  it("**バイト長: 全角 6 字は 12 バイト**（J なら SO/SI で 14）", () => {
    const six = "あいうえおか";
    expect(dbcsByteLength(six, undefined, true)).toBe(12);
    expect(dbcsByteLength(six)).toBe(14);
    expect(dbcsByteLength("あい", undefined, true)).toBe(4);
    expect(dbcsByteLength("", undefined, true)).toBe(0);
  });

  it("**列ビューに SO/SI の桁が無い**（入力欄の値は 6 字ちょうど。12 桁）", async () => {
    const { snapshot } = gSnapshot(["あ", "い", "う"]);
    const { el } = await open(snapshot);
    expect(el.value).toBe("あいう　　　");
  });

  it("**編集済みで休止している G の欄も SO/SI の桁が無い**（`edits` の値から列ビューを組む経路）", async () => {
    const { snapshot } = gSnapshot(["あ", "い", "う"]);
    const edits = new Map<number, string>([[1, "かきく"]]);
    const w = mount(ScreenGrid, { props: { snapshot, edits, focused: false, busy: false, cursor: snapshot.cursor }, attachTo: document.body });
    mounted.push(w as never);
    await nextTick();
    const el = w.element.querySelector("input.grid-input:not([readonly])") as HTMLInputElement;
    expect(el.value).toBe("かきく\u3000\u3000\u3000");
  });

  it("**6 字が入る**（12 バイトの欄。以前は 5 字で 6 字目が拒否された）", async () => {
    const { snapshot } = gSnapshot([]);
    const { key, value } = await open(snapshot);
    for (const ch of "かきくけこさ") await key(ch);
    expect(value()).toBe("かきくけこさ");
  });

  it("**満杯の欄で挿入は 0012**（6 字が入った状態でもう 1 字）", async () => {
    const { snapshot } = gSnapshot(["あ", "い", "う", "え", "お", "か"]);
    const { key, at, notices, edited } = await open(snapshot);
    await at(0);
    await key("Insert");
    await key("き");
    expect(notices()).toContain(MSG_NO_ROOM);
    expect(edited(), "値を変えない").toEqual([]);
  });

  it("**挿入: 末尾の全角空白を押し出して入る**（実機の ACS: `あい□□□□` の先頭へ `う` → `うあい□□□`）", async () => {
    const { snapshot } = gSnapshot(["あ", "い"]);
    const { key, at, value, notices } = await open(snapshot);
    await at(0);
    await key("Insert");
    await key("う");
    expect(value(), "詰め物の全角空白は値に含めない（コアが欄長まで 4040 で詰める）").toBe("うあい");
    expect(notices()).toEqual([]);
  });
});

describe("G の欄の詰め物は全角空白（半角空白を途中に残さない）", () => {
  it("**離れた空きの桁へ打っても、前の空きは全角空白**（半角空白が入ると「全角しか入力できない」で送れなかった）", async () => {
    const { snapshot } = gSnapshot(["あ", "い", "う"]);
    const { key, at, value } = await open(snapshot);
    await at(4); // 5 スロット目
    await key("か");
    expect(value()).toBe("あいう　か");
    expect(value()!.includes(" "), "半角空白が混ざっていない").toBe(false);
  });

  it("空の G の欄の途中に打つ", async () => {
    const { snapshot } = gSnapshot([]);
    const { key, at, value } = await open(snapshot);
    await at(3); // 4 スロット目
    await key("か");
    expect(value()).toBe("　　　か");
  });

  it("**触っただけでは値が変わらない**（空きが NUL のホストの G でも、カーソルを動かして編集の印を立てない）", async () => {
    const { snapshot } = gSnapshot([], { emptyCells: true });
    const { key, edited } = await open(snapshot);
    await key("ArrowRight");
    await key("ArrowRight");
    await key("ArrowLeft");
    expect(edited()).toEqual([]);
  });

  it("Space は全角空白（`20260922-dbcs-space-key`）で、末尾なら値から落ちる", async () => {
    const { snapshot } = gSnapshot(["あ", "い", "う"]);
    const { key, at, value } = await open(snapshot);
    await at(4);
    await key(" ");
    expect(value(), "全角空白を打ち足しても、末尾の全角空白は詰め物と同じ扱い").toBe("あいう");
  });

  it("上書き: 全角 1 字が全角 1 字に替わるだけで桁は動かない", async () => {
    const { snapshot } = gSnapshot(["あ", "い", "う"]);
    const { key, at, value } = await open(snapshot);
    await at(1);
    await key("か");
    expect(value()).toBe("あかう");
  });

  it("Delete: 1 字消えて後ろが詰まり、詰め物は全角空白のまま", async () => {
    const { snapshot } = gSnapshot(["あ", "い", "う"]);
    const { key, at, value, el } = await open(snapshot);
    await at(1);
    await key("Delete");
    expect(value()).toBe("あう");
    expect(el.value).toBe("あう　　　　");
  });
});

describe("MF の満杯判定・J との差", () => {
  it("**G の欄が 6 字で満杯**（MF の満杯判定のバイト予算に SO/SI を数えない）", () => {
    const g = { index: 1, dbcsType: "pure", length: 12, adjust: "mandatory-fill", mdt: true } as unknown as Field;
    expect(mandatoryFillViolated(g, new Map([[1, "あいうえおか"]])), "6 字＝12 バイトで満杯").toBe(false);
    expect(mandatoryFillViolated(g, new Map([[1, "あいうえお"]])), "5 字は部分入力").toBe(true);
    const j = { index: 1, dbcsType: "only", length: 12, adjust: "mandatory-fill", mdt: true } as unknown as Field;
    expect(mandatoryFillViolated(j, new Map([[1, "あいうえお"]])), "J は SO/SI 込みで 5 字が満杯").toBe(false);
  });

  it("J の欄は従来どおり SO/SI を数える（5 字が満杯。6 字目は入らない）", async () => {
    const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
    cells[4]![19] = cell(" ", "so");
    for (let i = 0; i < 5; i++) { cells[4]![20 + i * 2] = cell("あ", "dbcs-lead"); cells[4]![21 + i * 2] = cell("", "dbcs-tail"); }
    cells[4]![30] = cell(" ", "si");
    const field = { index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "", dbcsType: "only" } as Field;
    const snapshot = { sessionId: "g1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [field] } as unknown as ScreenSnapshot;
    const { key, at, notices } = await open(snapshot);
    await at(1);
    await key("Insert");
    await key("い");
    expect(notices()).toContain(MSG_NO_ROOM);
  });
});
