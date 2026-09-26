import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { MSG_NO_ROOM } from "../src/composables/opMessages.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";

/**
 * **挿入モードの O 欄で、SO/SI を含む必要桁を ACS に合わせる**（ACS `PS5250.insertChar` / `reserveRoomForInsert`。`20260926-dbcs-insert-sosi-room`）。
 * 実機の ACS のコア（`scripts/acs-probe/dbcs-insert-room.txt`。930・DSM の DBCSFE の O 欄 12 桁）で測った表を、同じ中身・カーソル・字で当 PJ に当てる:
 * - C3: `A`・SO・`あいう`・SI・`B`＋空き 2、`B` の桁へ全角 → ACS は 4 桁要るので 0012（当 PJ は前の並びに繋げて入れていた）
 * - C4: 同じ欄の最初の全角へ半角 → ACS は SI・字・SO の 3 桁要るので 0012（当 PJ は 1 桁で入れていた）
 * - C5: `A`・SO・`あい`・SI・`B`＋空き 4、最初の全角へ半角 → 入る
 * 入ったあとの値は当 PJ の正規化した並びのまま（ACS の空の SO/SI・別の並びは論理値で表せない。同 decisions D2）。
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

/**
 * O 欄（5,20 から 12 桁）。`parts` を欄の先頭から置く——文字列は半角の並び、配列は全角の並び（前後に SO・SI の桁を置く）。
 * 例: `["A", ["あ", "い", "う"], "B"]` → `A`・SO・`あいう`・SI・`B`（10 桁）
 */
function openSnapshot(parts: (string | string[])[], opts: { continued?: boolean; type?: "open" | "only" } = {}): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const r = cells[4]!;
  let c = 19;
  let value = "";
  for (const p of parts) {
    if (typeof p === "string") {
      for (const ch of p) r[c++] = cell(ch);
      value += p;
    } else {
      r[c++] = cell(" ", "so");
      for (const ch of p) {
        r[c++] = cell(ch, "dbcs-lead");
        r[c++] = cell("", "dbcs-tail");
      }
      r[c++] = cell(" ", "si");
      value += p.join("");
    }
  }
  const field = {
    index: 1, row: 5, col: 20, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value, dbcsType: opts.type ?? "open",
    ...(opts.continued ? { continued: "first" } : {})
  } as Field;
  // 継続欄は区間の並び（first … last）で成り立つので、次の欄を last にする（`ContinuedPart`。`packages/tn5250/src/screen/types.ts:45`）
  const next = {
    index: 2, row: 8, col: 20, length: 6, protected: false, hidden: false, numeric: false, mdt: false, value: "",
    ...(opts.continued ? { continued: "last", dbcsType: "open" } : {})
  } as Field;
  return { sessionId: "d1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [field, next] } as unknown as ScreenSnapshot;
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
  // 入力欄の桁（view の添字）。O 欄の view は SO・SI の印を 1 桁ずつ含む
  const at = async (caret: number) => {
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  };
  const select = async (from: number, to: number) => {
    el.setSelectionRange(from, to);
    await nextTick();
  };
  const insert = async (caret: number, ch: string) => {
    await at(caret);
    await key("Insert");
    await key(ch);
  };
  const paste = async (text: string) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => text };
    el.dispatchEvent(ev);
    await nextTick();
  };
  const compose = async (text: string) => {
    el.dispatchEvent(new CompositionEvent("compositionstart"));
    await nextTick();
    const at = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, at) + text + el.value.slice(el.selectionEnd ?? at); // 確定した字を合成開始桁に差し込む
    el.dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
  };
  return { key, at, select, insert, paste, compose, value: () => edits.get(1), notices: () => ((w.emitted("notice") as unknown[][] | undefined) ?? []).map((a) => a[0]) };
}

// view の添字: A=0・SO=1・あ=2・い=3・う=4・SI=5・B=6
const C3_C4 = ["A", ["あ", "い", "う"], "B"]; // 10 桁＋空き 2
/** C3 の位置（B）へ全角を上書きした結果（上書きは桁を動かさない既存の規則。この work では変えない） */
const OVERWRITE_C3 = "Aあいうえ";

describe("O 欄の挿入: ACS の必要桁が空きに足りなければ 0012（C3・C4）", () => {
  it("**C3: 並びの直後の半角の字（B）へ全角・空き 2 → 0012、値は変わらない**（ACS は SO・字・SI の 4 桁）", async () => {
    const { insert, value, notices } = await open(openSnapshot(C3_C4));
    await insert(6, "え");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**C4: 並びの最初の全角へ半角・空き 2 → 0012、値は変わらない**（ACS は SI・字・SO の 3 桁）", async () => {
    const { insert, value, notices } = await open(openSnapshot(C3_C4));
    await insert(2, "X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });
});

describe("O 欄の挿入: 空きが足りれば入る（値は当 PJ の正規化した並び）", () => {
  it("**C5: `A`・SO・`あい`・SI・`B`＋空き 4、最初の全角へ半角 → 入る**", async () => {
    const { insert, value, notices } = await open(openSnapshot(["A", ["あ", "い"], "B"]));
    await insert(2, "X");
    expect(value()).toBe("AXあいB");
    expect(notices()).toEqual([]);
  });

  it("C3 の位置でも空きが多ければ入る（`A`・SO・`あ`・SI・`B`＋空き 7）", async () => {
    const { insert, value } = await open(openSnapshot(["A", ["あ"], "B"]));
    // view: A=0・SO=1・あ=2・SI=3・B=4
    await insert(4, "え");
    expect(value()).toBe("AあえB");
  });

  it("**境界: C3 の位置で空き 4 ちょうど → 入る**（`A`・SO・`あい`・SI・`B`＋空き 4。必要 4）", async () => {
    const { insert, value, notices } = await open(openSnapshot(["A", ["あ", "い"], "B"]));
    // view: A=0・SO=1・あ=2・い=3・SI=4・B=5
    await insert(5, "え");
    expect(value()).toBe("AあいえB");
    expect(notices()).toEqual([]);
  });

  it("**境界: C3 の位置で空き 3 → 0012**（`A`・SO・`あい`・SI・`BC`＋空き 3。必要 4 に 1 桁足りない。当 PJ の並びなら 11 桁で入っていた）", async () => {
    const { insert, value, notices } = await open(openSnapshot(["A", ["あ", "い"], "BC"]));
    // view: A=0・SO=1・あ=2・い=3・SI=4・B=5
    await insert(5, "え");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**境界: C4 の位置で空き 3 ちょうど → 入る**（`AB`・SO・`あい`・SI・`C`＋空き 3。必要 3）", async () => {
    const { insert, value, notices } = await open(openSnapshot(["AB", ["あ", "い"], "C"]));
    // view: A=0・B=1・SO=2・あ=3
    await insert(3, "X");
    expect(value()).toBe("ABXあいC");
    expect(notices()).toEqual([]);
  });

  it("並びの中の全角へ全角（必要 2）は空き 2 でも入る（ACS と同じ）", async () => {
    const { insert, value } = await open(openSnapshot(C3_C4));
    await insert(3, "え"); // い の桁
    expect(value()).toBe("AあえいうB");
  });

  it("半角の中へ半角（必要 1）は空き 2 でも入る", async () => {
    const { insert, value } = await open(openSnapshot(["AB", ["あ", "い", "う"], "C"]));
    // view: A=0・B=1・SO=2…
    await insert(1, "X");
    expect(value()).toBe("AXBあいうC");
  });

  it("並びの中ほどの全角へ半角（SI・字・SO の 3 桁。当 PJ も 3 桁）は空き 3 で入る", async () => {
    const { insert, value } = await open(openSnapshot(["A", ["あ", "い"], "B"])); // 8 桁＋空き 4
    await insert(3, "X"); // い の桁
    expect(value()).toBe("AあXいB");
  });
});

describe("既に ACS と一致している場合は変わらない（背景の表の B2・B3・C1・C2・F1）", () => {
  it("B2: 11 桁の最終のセルへ半角 → 0012", async () => {
    const { insert, value, notices } = await open(openSnapshot(["ABCDEFGHIJK"]));
    await insert(11, "X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });
  it("B3: 1 桁手前へ半角 → 入る", async () => {
    const { insert, value } = await open(openSnapshot(["ABCDEFGHIJK"]));
    await insert(10, "X");
    expect(value()).toBe("ABCDEFGHIJXK");
  });
  it("C1: 8 桁＋空き 4 の末尾へ全角 → 入る（4 桁ちょうど）", async () => {
    const { insert, value } = await open(openSnapshot(["ABCDEFGH"]));
    await insert(8, "あ");
    expect(value()).toBe("ABCDEFGHあ");
  });
  it("C2: 9 桁＋空き 3 の末尾へ全角 → 0012", async () => {
    const { insert, value, notices } = await open(openSnapshot(["ABCDEFGHI"]));
    await insert(9, "あ");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });
  it("F1: `ABCDEFGH`・SO・全角空白・SI（満杯）の先頭へ半角 → 0012（全角空白は空きに数えない）", async () => {
    const { insert, value, notices } = await open(openSnapshot(["ABCDEFGH", ["　"]]));
    await insert(0, "X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });
});

describe("対象外: この検査を掛けない場合", () => {
  it("上書きモードは変えない（C3 の位置へ全角を上書き）", async () => {
    const { at, key, value } = await open(openSnapshot(C3_C4));
    await at(6);
    await key("え");
    expect(value()).toBe(OVERWRITE_C3);
  });

  it("継続欄は ACS の別の手順（併合と語詰め）なので、ここでは見ない（従来どおり入る）", async () => {
    const { insert, value } = await open(openSnapshot(C3_C4, { continued: true }));
    await insert(6, "え");
    expect(value()).toBe("AあいうえB");
  });

  // J 欄は全角だけなので (i)(ii)（全角と半角の境目）は起きない——O 欄に限る条件を外しても結果は変わらない（等価変異。decisions D5）。
  // ここでは J 欄の挿入が従来どおりであることだけを確かめる
  it("J 欄（全角専用）の挿入は従来どおり", async () => {
    const { insert, value, notices } = await open(openSnapshot([["あ", "い", "　", "　", "　"]], { type: "only" }));
    await insert(1, "う");
    expect(value()).toBe("うあい");
    expect(notices()).toEqual([]);
  });

  it("選択を置き換える挿入（`replaced`）には掛けない（満杯の欄で最初の全角を選び、半角で置き換える）", async () => {
    // `A`・SO・`あいうえ`・SI・`B` で 12 桁ちょうど。あ を消すと空きは 2——(ii) の検査を掛けると 3 に足りず 0012 になるが、
    // 置き換えは消した跡を埋めるだけなので掛けない（最終桁の判定と同じ扱い）。当 PJ の並びでは入る（`AXいうえB` は 11 桁）
    const { at, key, select, value, notices } = await open(openSnapshot(["A", ["あ", "い", "う", "え"], "B"]));
    await at(2);
    await key("Insert");
    await select(2, 3); // あ を選ぶ
    await key("X");
    expect(value()).toBe("AXいうえB");
    expect(notices()).toEqual([]);
  });
});

/** 挿入の 3 経路（打鍵・貼り付け・IME の確定）は同じ規則になる（どれも `dbcsType` を通る。design「依拠する既存の事実」） */
describe("貼り付け・IME の確定も同じ規則（C3・C4）", () => {
  it("**貼り付け: C3 の位置へ全角を挿入で貼る → 0012、値は変わらない**（事前の検査は欄全体の桁数だけなので通る。止めるのは必要桁の検査）", async () => {
    const { at, key, paste, value, notices } = await open(openSnapshot(C3_C4));
    await at(6);
    await key("Insert");
    await paste("え");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**貼り付け: 途中の字で止まれば、そこまでは入る**（`AB`・SO・`あい`・SI・`C`＋空き 3 の最初の全角へ `XY` → X は入り、Y は必要 3 に空き 2 で 0012）", async () => {
    const { at, key, paste, value, notices } = await open(openSnapshot(["AB", ["あ", "い"], "C"]));
    await at(3);
    await key("Insert");
    await paste("XY");
    expect(value()).toBe("ABXあいC");
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**IME の確定: C4 の位置へ半角を挿入で確定 → 0012、値は変わらない**", async () => {
    const { at, key, compose, value, notices } = await open(openSnapshot(C3_C4));
    await at(2);
    await key("Insert");
    await compose("X");
    expect(value()).toBeUndefined();
    expect(notices()).toContain(MSG_NO_ROOM);
  });

  it("**IME の確定で選択を複数字で置き換えるとき、判定を外すのは 1 字目だけ**（2 字目が C4 相当なら 0012。以前は全部の字で外していた）", async () => {
    // `A`・SO・`あいうえ`・SI・`B`（満杯）の あ を選び、`XY` を確定: X は置き換えで入る（`AXいうえB`＝11 桁・空き 1）。
    // Y はカーソルが い（並びの最初の全角）で半角＝必要 3 に空き 1 → 0012。X までは入ったまま
    const { at, key, select, compose, value, notices } = await open(openSnapshot(["A", ["あ", "い", "う", "え"], "B"]));
    await at(2);
    await key("Insert");
    await select(2, 3);
    await compose("XY");
    expect(value()).toBe("AXいうえB");
    expect(notices()).toContain(MSG_NO_ROOM);
  });
});

