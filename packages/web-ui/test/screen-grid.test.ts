import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import type { ScreenSnapshot, Cell, Field } from "@as400web/core";

function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false,
    ...extra
  };
}

function makeSnap(fields: Field[] = []): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) {
      if (r === 0 && c < 5) row.push(cell("HELLO"[c]!, { color: c < 2 ? "white" : "green" }));
      else row.push(cell(" "));
    }
    cells.push(row);
  }
  return {
    sessionId: "s",
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields
  };
}

describe("ScreenGrid", () => {
  it("24 行を描画し、属性カラーを class にマップする", () => {
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(), edits: new Map(), focused: true } });
    expect(w.findAll(".grid-row")).toHaveLength(24);
    const html = w.html();
    expect(html).toContain("c-white");
    expect(html).toContain("c-green");
  });

  it("入力フィールドを inline input として描画し、hidden は何も表示しない（ACS 準拠）", () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "TARO" },
      { index: 2, row: 7, col: 10, length: 8, protected: false, hidden: true, numeric: false, mdt: false, value: "PW" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const inputs = w.findAll("input.grid-input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.attributes("type")).toBe("text");
    // hidden も type=text（password は伏せ字を出してしまう）。表示の抑止は値側で行う
    expect(inputs[1]!.attributes("type")).toBe("text");
    expect((inputs[0]!.element as HTMLInputElement).value.trimEnd()).toBe("TARO");
    // ACS は非表示欄に何も描かない（伏せ字も出さない）。桁だけ保つ
    expect((inputs[1]!.element as HTMLInputElement).value).toBe(" ".repeat(8));
  });

  it("保護（表示専用）フィールドは readonly 入力として描画される（下線抑止 CSS の対象）", () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: true, hidden: false, numeric: false, mdt: false, value: "SRCLINE" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: false } });
    const input = w.find("input.grid-input");
    expect(input.attributes("readonly")).toBeDefined(); // readonly → .grid-input[readonly] で下線非表示
    expect((input.element as HTMLInputElement).value.trimEnd()).toBe("SRCLINE");
  });

  it("非 hidden 入力欄はフィールド長までスペース埋め表示（欄内任意桁にカーソル可）", () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "AB" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: false } });
    const v = (w.find("input.grid-input").element as HTMLInputElement).value;
    expect(v).toBe("AB        "); // 10 桁までスペース埋め
    expect(v.length).toBe(10);
  });

  it("行またぎフィールド（コマンド行）は行ごとのスライスに割って全桁を描画する", () => {
    // (20,7) len=153 は 80 桁画面で row20(col7〜80=74桁) と row21(col1〜79=79桁) にまたがる
    const fields: Field[] = [
      { index: 1, row: 20, col: 7, length: 153, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: false } });
    const inputs = w.findAll("input.grid-input");
    expect(inputs).toHaveLength(2); // 行ごとに 1 つ
    expect(inputs[0]!.attributes("data-slice")).toBe("0");
    expect(inputs[0]!.attributes("maxlength")).toBe("74");
    expect(inputs[0]!.attributes("style")).toContain("74ch");
    expect(inputs[1]!.attributes("data-slice")).toBe("1");
    expect(inputs[1]!.attributes("maxlength")).toBe("79");
    expect(inputs[1]!.attributes("style")).toContain("79ch");
    // 同一フィールドの 2 スライス（74+79=153＝全桁が編集対象）
    expect(inputs[0]!.attributes("data-field-index")).toBe("1");
    expect(inputs[1]!.attributes("data-field-index")).toBe("1");
  });

  it("行またぎ欄への単一行ペーストは矩形で折り返す（開始桁に揃えて次の行へ）", async () => {
    const fields: Field[] = [
      { index: 1, row: 20, col: 7, length: 153, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const first = w.findAll("input.grid-input")[0]!;
    await first.trigger("focus");
    // 1 行目の可視 74 桁（col7..80）を超える長さを貼り付ける（80 文字）
    const long = "A".repeat(80);
    await first.trigger("paste", { clipboardData: { getData: () => long } } as unknown as ClipboardEvent);
    const emits = w.emitted("edit") as [number, string][];
    // ACS の矩形規則: あふれた 6 文字は「次の行の**同じ開始桁**（col7）」へ回る。
    // 行またぎ欄では col7 = 欄の 80 桁目にあたるため、74..79 桁は元のまま（空白）残る。
    // 旧実装は単一行だけ連続して詰めており（80 桁ぶんが隙間なく並ぶ）、矩形規則と食い違っていた。
    expect(emits.at(-1)![1]).toBe("A".repeat(74) + " ".repeat(6) + "A".repeat(6));
  });

  it("DBCS 欄も行またぎ（折返し）で全長ぶんのスライスに割る", () => {
    // 1399 のコマンド行相当: (20,7) len=153 → row20 に 74 桁、row21 に 79 桁
    const fields: Field[] = [
      { index: 1, row: 20, col: 7, length: 153, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: false } });
    const inputs = w.findAll("input.grid-input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.attributes("maxlength")).toBe("74");
    expect(inputs[1]!.attributes("maxlength")).toBe("79");
    // 各スライスの表示はその行の桁数ぴったり（列ビューでも桁で割る）
    expect((inputs[0]!.element as HTMLInputElement).value).toHaveLength(74);
    expect((inputs[1]!.element as HTMLInputElement).value).toHaveLength(79);
  });

  it("入力欄フォーカスで cursor イベントをフィールド位置で emit する", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    await w.find("input.grid-input").trigger("focus");
    expect(w.emitted("cursor")?.[0]).toEqual([6, 10]);
  });

  it("幅広フィールドの input 幅は行残り桁にクランプされる", () => {
    const fields: Field[] = [
      // col=75, length=20 → 行残りは 80-74=6 桁にクランプ
      { index: 1, row: 3, col: 75, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const style = w.find("input.grid-input").attributes("style") ?? "";
    expect(style).toContain("6ch"); // クランプ後
    expect(style).not.toContain("20ch");
  });

  it("満杯欄で ArrowRight 末尾まで移動→Backspace で最終文字を削除できる", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 3, protected: false, hidden: false, numeric: false, mdt: false, value: "ABC" } // フルケタ
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(0, 0);
    await input.trigger("keydown", { key: "ArrowRight" }); // 0→1
    await input.trigger("keydown", { key: "ArrowRight" }); // 1→2
    await input.trigger("keydown", { key: "ArrowRight" }); // 2→3（末尾）
    expect(el.selectionStart).toBe(3); // 最終文字の後ろに止まれる
    await input.trigger("keydown", { key: "Backspace" }); // 最終文字 C を削除
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "AB"]);
  });

  it("keydown 制御で文字入力し edit を emit する（上書きモード・v-model 不使用）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "A" });
    await input.trigger("keydown", { key: "B" });
    await input.trigger("keydown", { key: "C" });
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "ABC"]);
  });

  it("uppercaseInput（930/5026）: 半角英小文字を入力すると大文字化する", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map(), focused: true, uppercaseInput: true }
    });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "a" });
    await input.trigger("keydown", { key: "b" });
    await input.trigger("keydown", { key: "1" }); // 数字はそのまま
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "AB1"]);
  });

  it("uppercaseInput 無効時（既定）は英小文字がそのまま入る", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "a" });
    await input.trigger("keydown", { key: "b" });
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "ab"]);
  });

  it("uppercaseInput: 貼り付けた英小文字も大文字化する", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map(), focused: true, uppercaseInput: true }
    });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("paste", {
      clipboardData: { getData: () => "abc123" }
    } as unknown as ClipboardEvent);
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "ABC123"]);
  });

  it("hidden 欄: 打っても何も表示しない（ACS 準拠）・桁は保つ", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 40, protected: false, hidden: true, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    expect(el.value).toBe(" ".repeat(40)); // 欄長ぶんの空白でカーソル移動は確保
    await input.trigger("keydown", { key: "a" });
    await input.trigger("keydown", { key: "b" });
    expect(el.value).toBe(" ".repeat(40)); // 打っても見た目は変わらない（ACS と同じ）
    expect(el.value.length).toBe(40); // 未入力桁へカーソルを置けること（native caret の上限＝値長）
    expect(el.value).not.toContain("a"); // 実値は DOM に出ない
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "ab"]); // 送信値は実値
  });

  it("hidden 欄: ホストが空白パディング済みの値を返しても桁が崩れない", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 40, protected: false, hidden: true, numeric: false, mdt: false, value: " ".repeat(40) }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    expect(el.value).toBe(" ".repeat(40)); // 休止時
    await input.trigger("focus");
    expect(el.value).toBe(" ".repeat(40)); // フォーカス時も同じ
  });

  it("hidden 欄: ホストが値を返しても DOM には出さない", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: true, numeric: false, mdt: false, value: "abc" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const el = w.find("input.grid-input").element as HTMLInputElement;
    expect(el.value).toBe(" ".repeat(8)); // 何も描かない（伏せ字すら出さない）
    expect(el.value).not.toContain("a"); // 実値は DOM に出ない
  });

  it("非 hidden 欄はスペース埋めのまま（maxlength を満たし IME 挿入余地を確保）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    expect(el.value).toBe(" ".repeat(8)); // hidden と違いスペース埋めは維持する
  });

  it("上書きモード: 途中入力しても後続桁がシフトしない", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "ABCDE" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    el.setSelectionRange(1, 1); // カーソルを B に
    await input.trigger("focus");
    el.setSelectionRange(1, 1);
    await input.trigger("keydown", { key: "X" });
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("AXCDE"); // B が X に置換、後続シフトなし
  });

  it("IME 確定は native input の現在値を取り込み二重化しない", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    await input.trigger("compositionstart");
    el.value = "ABC"; // IME 確定後の native 値
    el.setSelectionRange(3, 3);
    await input.trigger("compositionend");
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("ABC"); // 二重化せず ABC
  });

  it("IME 合成で DBCS 全角を入力できる（空欄はスペース埋めを外して挿入余地を作る）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 12, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus"); // スペース埋め表示（maxlength ぶん）
    await input.trigger("compositionstart");
    // 空欄なので prefix="" ＝ スペース埋めが外れて挿入余地ができる
    expect(el.value).toBe("");
    el.value = "日本語"; // IME が確定文字を挿入
    await input.trigger("compositionend");
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("日本語"); // DBCS 全角が取り込まれる
  });

  it("IME 確定で欄のバイト予算（SO/SI・DBCS 2 バイト込み）を超える DBCS は切り捨てる", async () => {
    // length=6（バイト予算 6）。あい=SO+4+SI=6 まで。あいう=8 は超過 → う を切り捨て
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 6, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    await input.trigger("compositionstart");
    el.value = "あいう"; // IME が 3 文字確定（8 バイト相当）
    await input.trigger("compositionend");
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("あい"); // 6 バイトに収まる「あい」のみ、「う」は切り捨て
  });

  it("既入力の後ろに IME 合成すると、既入力を残し候補が入力位置に出る（先頭に出ない）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 12, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "あいう" }
    ];
    const snapshot = makeSnap(fields);
    // 未編集 DBCS 欄の論理値はセルから復元されるため、欄セルに既入力を配置（row6=index5, col10=index9）
    ["あ", "い", "う"].forEach((ch, i) => (snapshot.cells[5]![9 + i] = cell(ch)));
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    // フォーカス中は列ビュー " あいう "（SO/SI 込み）。末尾（う の直後）へカーソルを置く
    expect(el.value.replace(/ +$/, "")).toBe(" あいう"); // 末尾は欄長までパディング
    // 列ビュー " あいう     "（SO=0 / あ=1 / い=2 / う=3 / SI=4 / 以降パディング）。
    // 「う の直後」の論理カーソルは SI の後ろ（view 5）。value 末尾はパディング末尾であって
    // 既入力の直後ではない（欄長までスペース埋めされているため）。
    el.setSelectionRange(5, 5);
    await input.trigger("compositionstart");
    // 合成中は純論理値 prefix「あいう」（SO/SI 無し）＋候補 → 候補が先頭でなく入力位置に出る
    expect(el.value).toBe("あいう");
    expect(el.selectionStart).toBe(3); // caret は prefix の末尾＝合成開始位置（論理 3）
    el.value = "あいうえお"; // IME が「えお」を既入力の後ろに挿入
    await input.trigger("compositionend");
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("あいうえお"); // 既入力＋確定分が二重化せず結合
  });

  it("hidden（パスワード）欄は何も表示せず・実値は DOM に出ず・送信値は実入力", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 20, protected: false, hidden: true, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    // type=password は伏せ字を出してしまうため使わない（ACS は何も描かない）
    expect(input.attributes("type")).toBe("text");
    expect(input.attributes("autocomplete")).toBe("off");
    await input.trigger("focus");
    for (const ch of ["P", "A", "S", "S"]) await input.trigger("keydown", { key: ch });
    // ACS 準拠: 打鍵しても何も描かない。桁だけ保つ
    expect((input.element as HTMLInputElement).value).toBe(" ".repeat(20));
    expect((input.element as HTMLInputElement).value).not.toContain("P"); // 実値は DOM に出ない
    // 送信値（emit）は実入力
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "PASS"]);
  });

  it("hidden 欄は IME 合成を無効化する（伏せ字 value がモデルへ流れ込むのを防ぐ）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 20, protected: false, hidden: true, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    for (const ch of ["A", "B"]) await input.trigger("keydown", { key: ch });
    await input.trigger("compositionstart");
    el.value = "**あ"; // IME が伏せ字表示の上に確定文字を置いた状況を模す
    await input.trigger("compositionend");
    // 伏せ字（*）も確定文字も取り込まれず、既入力のまま
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "AB"]);
  });

  it("DBCS 欄: 未入力桁までスペース埋めされ、任意桁にカーソルを置ける（SBCS 欄と同じ）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 12, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true }, attachTo: document.body });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    expect(el.value).toBe(" ".repeat(12)); // 空欄でも欄長ぶん（旧: 空文字でカーソルを動かせなかった）
    el.setSelectionRange(5, 5);
    expect(el.selectionStart).toBe(5); // 未入力桁へカーソルを置ける
    w.unmount();
  });

  it("DBCS 欄: 上書きが既定・Insert で挿入（SBCS 欄と同じ。旧: 挿入固定）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 12, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true }, attachTo: document.body });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    for (const ch of ["A", "B", "C"]) await input.trigger("keydown", { key: ch });
    let emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("ABC"); // 打った順に入る
    // 2 桁目へ戻して上書き
    el.setSelectionRange(1, 1);
    await input.trigger("keydown", { key: "X" });
    emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("AXC"); // 上書き（挿入なら AXBC）
    // Insert トグルで挿入
    el.setSelectionRange(1, 1);
    await input.trigger("keydown", { key: "Insert" });
    await input.trigger("keydown", { key: "Y" });
    emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("AYXC");
    w.unmount();
  });

  it("DBCS 欄は休止時 SO/SI 込みの列ビューで表示し、編集/送信は SO/SI を除いた純データ", async () => {
    // ホストが書いた DBCS 欄セル: A(sbcs) SO あ(lead) tail SI …（col10=index9 から）
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const snapshot = makeSnap(fields);
    const row = snapshot.cells[5]!;
    row[9] = cell("A");
    row[10] = { ...cell(" "), kind: "so" };
    row[11] = { ...cell("あ"), kind: "dbcs-lead" };
    row[12] = { ...cell(""), kind: "dbcs-tail" };
    row[13] = { ...cell(" "), kind: "si" };
    // 休止表示（focused: false ＝ 自動フォーカスなし）: 列ビュー "A あ "（SO/SI が半角スペース）
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: false }, attachTo: document.body });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    expect(el.value).toBe("A あ " + "   "); // columnView("Aあ")＋欄長(8桁)までのスペース埋め

    // フォーカス中も列ビュー（SO/SI 込み）で編集する（ライブ表示）。
    // 未入力桁にもカーソルを置けるよう欄長（8 桁）までスペース埋めする（SBCS 欄と同じ）
    await input.trigger("focus");
    expect(el.value).toBe("A あ " + "   ");

    // 末尾へ移動して SBCS 追加 → 送信値（emit）は SO/SI を含まない純データ、表示は列ビュー
    await input.trigger("keydown", { key: "End" });
    await input.trigger("keydown", { key: "B" });
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("AあB"); // 純データ（末尾パディングは送らない）
    expect(el.value).toBe("A あ B" + "  "); // columnView("AあB")：あ の後ろに SI スペース＋埋め

    // blur で休止表示へ。standalone mount では edit は props.edits へ反映されないため
    // セル由来の論理値 "Aあ" の列ビューに戻る
    await input.trigger("blur");
    expect(el.value).toBe("A あ " + "   "); // 休止表示もパディング込み
    w.unmount();
  });

  it("DBCS 欄の矢印カーソルは SO/SI スペースをスキップする（ライブ列ビュー）", async () => {
    // 論理 "AあB" → 列ビュー "A あ B"（index1=SO, index3=SI）。cursor は A/あ/B/末尾のみに止まる
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const snapshot = makeSnap(fields);
    const row = snapshot.cells[5]!;
    row[9] = cell("A");
    row[10] = { ...cell(" "), kind: "so" };
    row[11] = { ...cell("あ"), kind: "dbcs-lead" };
    row[12] = { ...cell(""), kind: "dbcs-tail" };
    row[13] = { ...cell(" "), kind: "si" };
    row[14] = cell("B");
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: false }, attachTo: document.body });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    expect(el.value).toBe("A あ B" + "  "); // columnView("AあB")＋欄長までの埋め
    expect(el.selectionStart).toBe(0); // A の前
    await input.trigger("keydown", { key: "ArrowRight" });
    expect(el.selectionStart).toBe(2); // SO(桁1) を飛ばして あ へ
    await input.trigger("keydown", { key: "ArrowRight" });
    expect(el.selectionStart).toBe(4); // SI(桁3) を飛ばして B へ
    await input.trigger("keydown", { key: "ArrowRight" });
    expect(el.selectionStart).toBe(5); // 末尾
    await input.trigger("keydown", { key: "ArrowLeft" });
    expect(el.selectionStart).toBe(4); // B へ戻る（SI スキップ）
    w.unmount();
  });

  it("DBCS 欄のコピー/カットは SO/SI（列ビューの半角スペース）を含まない純論理値", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const snapshot = makeSnap(fields);
    const row = snapshot.cells[5]!;
    row[9] = cell("A");
    row[10] = { ...cell(" "), kind: "so" };
    row[11] = { ...cell("あ"), kind: "dbcs-lead" };
    row[12] = { ...cell(""), kind: "dbcs-tail" };
    row[13] = { ...cell(" "), kind: "si" };
    row[14] = cell("B");
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: false }, attachTo: document.body });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus"); // 列ビュー "A あ B"

    // 全選択コピー → SO/SI を含まない "AあB"
    el.setSelectionRange(0, el.value.length);
    const copied = { setData: vi.fn() };
    await input.trigger("copy", { clipboardData: copied });
    expect(copied.setData).toHaveBeenCalledWith("text/plain", "AあB");

    // あ だけ選択（列ビュー index 2..3）→ "あ" のみ
    el.setSelectionRange(2, 3);
    const one = { setData: vi.fn() };
    await input.trigger("copy", { clipboardData: one });
    expect(one.setData).toHaveBeenCalledWith("text/plain", "あ");

    // カット: 全選択 → クリップボードは "AあB"、欄は空・送信値も空
    el.setSelectionRange(0, el.value.length);
    const cutCd = { setData: vi.fn() };
    await input.trigger("cut", { clipboardData: cutCd });
    expect(cutCd.setData).toHaveBeenCalledWith("text/plain", "AあB");
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe(""); // 選択範囲を論理から削除
    w.unmount();
  });

  it("showShiftMarks 有効時、DBCS 欄の SO/SI を { } で表示（コピーは { } を含まない）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const snapshot = makeSnap(fields);
    const row = snapshot.cells[5]!;
    row[9] = cell("A");
    row[10] = { ...cell(" "), kind: "so" };
    row[11] = { ...cell("あ"), kind: "dbcs-lead" };
    row[12] = { ...cell(""), kind: "dbcs-tail" };
    row[13] = { ...cell(" "), kind: "si" };
    const w = mount(ScreenGrid, {
      props: { snapshot, edits: new Map(), focused: false, showShiftMarks: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    expect(el.value).toBe("A{あ}" + "   "); // 休止表示: SO={ / SI=}（＋欄長までの埋め）
    await input.trigger("focus");
    expect(el.value).toBe("A{あ}" + "   "); // 編集中も { }（＋欄長までの埋め）

    // コピーは { }（SO/SI）を含まない純論理値
    el.setSelectionRange(0, el.value.length);
    const cd = { setData: vi.fn() };
    await input.trigger("copy", { clipboardData: cd });
    expect(cd.setData).toHaveBeenCalledWith("text/plain", "Aあ");
    w.unmount();
  });

  it("DBCS 欄へ貼り付けできる（末尾でもブロックされない）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 16, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("paste", { clipboardData: { getData: () => "日本語" } });
    let emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("日本語");
    // 末尾へ移動してさらに貼り付け（cursor===len で typeChar にブロックされない回帰）
    await input.trigger("keydown", { key: "End" });
    await input.trigger("paste", { clipboardData: { getData: () => "あ" } });
    emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("日本語あ");
  });

  it("選択範囲を Delete/入力で削除・置換できる（SBCS）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "HELLO" }
    ];
    // Delete: EL(1..3) を削除 → HLO
    let w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    let input = w.find("input.grid-input");
    let el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(1, 3);
    await input.trigger("keydown", { key: "Delete" });
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("HLO");
    w.unmount();
    // 入力で置換: EL(1..3) を選択して X → HXLO
    w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    input = w.find("input.grid-input");
    el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(1, 3);
    await input.trigger("keydown", { key: "X" });
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("HXLO");
    w.unmount();
  });

  it("選択範囲を Delete/入力で削除・置換できる（DBCS・SO/SI 単位）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 16, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    // 列ビュー " あいう "。あい（view 1..3）を Delete → う のみ
    let w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map([[1, "あいう"]]), focused: true } });
    let input = w.find("input.grid-input");
    let el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(1, 3);
    await input.trigger("keydown", { key: "Delete" });
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("う");
    w.unmount();
    // あい を選択して え を入力 → えう（選択置換）
    w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map([[1, "あいう"]]), focused: true } });
    input = w.find("input.grid-input");
    el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(1, 3);
    await input.trigger("compositionstart");
    el.value = "え";
    await input.trigger("compositionend");
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("えう");
    w.unmount();
  });

  it("マウスドラッグで矩形選択し、コピーは矩形の複数行テキスト（入力/非入力を問わず）", async () => {
    const snapshot = makeSnap([]);
    ["ABCDEFGHIJ", "KLMNOPQRST", "UVWXYZ0123"].forEach((s, ri) => {
      [...s].forEach((ch, ci) => (snapshot.cells[2 + ri]![4 + ci] = cell(ch)));
    });
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true }, attachTo: document.body });
    await nextTick(); // fit() のフォント確定を style に反映させる
    const grid = w.find(".grid");
    const el = grid.element as HTMLElement;
    const fontPx = parseFloat(el.style.fontSize) || 6;
    const charW = fontPx * 0.6;
    const lineH = fontPx * 1.25;
    const xOf = (c: number) => (c - 1) * charW + 10 + charW * 0.5; // padding 10px + セル中央
    const yOf = (r: number) => (r - 1) * lineH + 8 + lineH * 0.5; // padding 8px
    // テキストは col5..14。row3..5 の col7..10（= C..F / M..P / W..Z）を矩形選択
    await grid.trigger("mousedown", { button: 0, clientX: xOf(7), clientY: yOf(3) });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: xOf(10), clientY: yOf(5) }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(true);
    const cd = { setData: vi.fn() };
    const ev = new Event("copy") as Event & { clipboardData: typeof cd };
    ev.clipboardData = cd;
    document.dispatchEvent(ev);
    expect(cd.setData).toHaveBeenCalledWith("text/plain", "CDEF\nMNOP\nWXYZ");
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(false); // コピー後は選択解除
    expect(w.emitted("selection-cleared")).toBeTruthy();
    w.unmount();
  });

  it("ドラッグ開始セルにカーソルを置く（ACS 相当。広げてもカーソルは始点から動かない）", async () => {
    const snapshot = makeSnap([]);
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true }, attachTo: document.body });
    await nextTick();
    const grid = w.find(".grid");
    const el = grid.element as HTMLElement;
    const fontPx = parseFloat(el.style.fontSize) || 6;
    const charW = fontPx * 0.6;
    const lineH = fontPx * 1.25;
    const xOf = (c: number) => (c - 1) * charW + 10 + charW * 0.5;
    const yOf = (r: number) => (r - 1) * lineH + 8 + lineH * 0.5;
    await grid.trigger("mousedown", { button: 0, clientX: xOf(7), clientY: yOf(3) });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: xOf(10), clientY: yOf(5) }));
    await nextTick();
    // 始点 (3,7) を 1 度だけ通知する（"cursor" ではない: reconcileFocus を通すと欄へ再フォーカスして選択が壊れる）
    expect(w.emitted("selection-start")).toEqual([[3, 7]]);
    // さらに広げても始点は動かない
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: xOf(12), clientY: yOf(6) }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await nextTick();
    expect(w.emitted("selection-start")).toEqual([[3, 7]]);
    expect(w.emitted("cursor")).toBeFalsy(); // ドラッグはクリック扱いしない
    w.unmount();
  });

  it("ダブルクリックでカーソル下の語を矩形選択する（ACS 相当）", async () => {
    const snapshot = makeSnap([]);
    // row3 の col5.. に "AB CDEF" を置く → CDEF は col8..11
    [..."AB CDEF"].forEach((ch, i) => (snapshot.cells[2]![4 + i] = cell(ch)));
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true }, attachTo: document.body });
    await nextTick();
    const grid = w.find(".grid");
    const fontPx = parseFloat((grid.element as HTMLElement).style.fontSize) || 6;
    const charW = fontPx * 0.6;
    const lineH = fontPx * 1.25;
    const xOf = (c: number) => (c - 1) * charW + 10 + charW * 0.5;
    const yOf = (r: number) => (r - 1) * lineH + 8 + lineH * 0.5;
    await grid.trigger("dblclick", { clientX: xOf(10), clientY: yOf(3) }); // CDEF の途中（E）
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(true);
    // 語頭にカーソル（ドラッグと同じ規則。選択の始点に置く）
    expect(w.emitted("selection-start")).toEqual([[3, 8]]);
    // コピーは語だけ（矩形は語頭〜語尾の 1 行）
    const cd = { setData: vi.fn() };
    const ev = new Event("copy") as Event & { clipboardData: typeof cd };
    ev.clipboardData = cd;
    document.dispatchEvent(ev);
    expect(cd.setData).toHaveBeenCalledWith("text/plain", "CDEF");
    w.unmount();
  });

  it("入力欄に打った未送信の語もダブルクリックで選択できる（cells はホストの内容しか持たない）", async () => {
    const fields: Field[] = [
      { index: 1, row: 3, col: 5, length: 12, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const snapshot = makeSnap(fields);
    // 未送信の入力値（snapshot.cells は空白のまま）。欄は col5.. なので "WRKACTJOB" は col5..13
    const w = mount(ScreenGrid, {
      props: { snapshot, edits: new Map([[1, "WRKACTJOB"]]), focused: true },
      attachTo: document.body
    });
    await nextTick();
    const grid = w.find(".grid");
    const fontPx = parseFloat((grid.element as HTMLElement).style.fontSize) || 6;
    const charW = fontPx * 0.6;
    const lineH = fontPx * 1.25;
    await grid.trigger("dblclick", { clientX: (8 - 1) * charW + 10 + charW * 0.5, clientY: (3 - 1) * lineH + 8 + lineH * 0.5 });
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(true);
    expect(w.emitted("selection-start")).toEqual([[3, 5]]); // 語頭＝欄の先頭桁
    const cd = { setData: vi.fn() };
    const ev = new Event("copy") as Event & { clipboardData: typeof cd };
    ev.clipboardData = cd;
    document.dispatchEvent(ev);
    expect(cd.setData).toHaveBeenCalledWith("text/plain", "WRKACTJOB");
    w.unmount();
  });

  it("空白セルのダブルクリックでは選択しない", async () => {
    const snapshot = makeSnap([]);
    [..."AB"].forEach((ch, i) => (snapshot.cells[2]![4 + i] = cell(ch)));
    const w = mount(ScreenGrid, { props: { snapshot, edits: new Map(), focused: true }, attachTo: document.body });
    await nextTick();
    const grid = w.find(".grid");
    const fontPx = parseFloat((grid.element as HTMLElement).style.fontSize) || 6;
    await grid.trigger("dblclick", { clientX: (20 - 1) * fontPx * 0.6 + 10, clientY: (3 - 1) * fontPx * 1.25 + 8 });
    await nextTick();
    expect(w.find(".rect-sel").exists()).toBe(false);
    w.unmount();
  });

  it("矩形選択中は欄上でもキャレットをオーバーレイで描く（入力欄は blur 済みで native キャレットが居ない）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map(), focused: true, cursor: { row: 6, col: 12 } }
    });
    expect(w.find(".cursor").exists()).toBe(false); // 通常は field モード＝native キャレットが担う
    w.vm.setBlockSelection({ r1: 6, c1: 12, r2: 8, c2: 20 });
    await nextTick();
    // 選択中は blur されるため、隠したままだとカーソルが完全に見えなくなる
    expect(w.find(".cursor").exists()).toBe(true);
    expect(w.find(".cursor").attributes("style")).toContain("11ch"); // col=12 → 11ch（始点のまま）
    w.unmount();
  });

  it("複数行ペーストはペースト開始桁（カーソル位置）を起点に上書きする（ACS 相当）", async () => {
    const fields: Field[] = [
      { index: 1, row: 5, col: 5, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "" },
      { index: 2, row: 6, col: 5, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.findAll("input.grid-input")[0]!;
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(3, 3); // 4 列目（オフセット 3）から貼り付け開始
    await input.trigger("paste", { clipboardData: { getData: () => "12345\n67890" } });
    const emits = w.emitted("edit") as [number, string][];
    const last = (idx: number) => [...emits].reverse().find((e) => e[0] === idx)?.[1];
    expect(last(1)).toBe("   12345"); // 3 桁の先頭空白＋12345
    expect(last(2)).toBe("   67890"); // 次欄も同じ開始桁で
    w.unmount();
  });

  // ACS の挿入ペースト仕様（実機挙動として提示されたもの）:
  //  - 挿入は後続を右へずらす。あふれ判定は行ではなく「欄全体の予算」に対して行う
  //  - 入り切らなければ "No room to insert data." を出し、**何も書かない**（確定するまで書き換えない）
  //  - 矩形は「各行を (開始行+i, 開始桁) へ順に挿入した結果」になる
  const fld = (index: number, row: number, col: number, length: number, value = ""): Field =>
    ({ index, row, col, length, protected: false, hidden: false, numeric: false, mdt: false, value });

  it("挿入モードの単一行ペーストは、入り切らなければ何も書かず NO_ROOM を出す", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap([fld(1, 5, 5, 10, "123123123")]), edits: new Map(), focused: true, insertMode: true }
    });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "123" } }); // 9+3=12 > 10
    expect(w.emitted("notice")).toEqual([["No room to insert data."]]);
    expect(w.emitted("edit")).toBeFalsy(); // 値は書き換えない
    w.unmount();
  });

  it("挿入モードの単一行ペーストは、入るなら後続を右へずらす", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap([fld(1, 5, 5, 10, "123")]), edits: new Map(), focused: true, insertMode: true }
    });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "123" } });
    const emits = w.emitted("edit") as [number, string][];
    expect([...emits].reverse().find((e) => e[0] === 1)?.[1]).toBe("123123");
    expect(w.emitted("notice")).toBeFalsy();
    w.unmount();
  });

  it("挿入モードの矩形ペーストは、1 行でも入り切らなければ全部取り消す", async () => {
    // 1 行目 "123"(→789123 で 6 桁・入る) / 2 行目 "123456"(→789123456 で 9 桁・入る)。
    // ここへもう一度 789/789 を貼ると 2 行目が 12 桁になり入らない → 1 行目も書かない
    const fields = [fld(1, 5, 5, 10, "789123"), fld(2, 6, 5, 10, "789123456")];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map(), focused: true, insertMode: true }
    });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "789\n789" } });
    expect(w.emitted("notice")).toEqual([["No room to insert data."]]);
    expect(w.emitted("edit")).toBeFalsy(); // 1 行目も書き換えない
    w.unmount();
  });

  it("挿入モードの矩形ペーストは、各行を同じ画面桁へ挿入する", async () => {
    const fields = [fld(1, 5, 5, 10, "123"), fld(2, 6, 5, 10, "123456")];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map(), focused: true, insertMode: true }
    });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "789\n789" } });
    const emits = w.emitted("edit") as [number, string][];
    const last = (idx: number) => [...emits].reverse().find((e) => e[0] === idx)?.[1];
    expect(last(1)).toBe("789123");
    expect(last(2)).toBe("789123456");
    w.unmount();
  });

  it("行またぎ欄への挿入ペーストは、1 行ずつ順に挿すのと同じ結果になる（456 → 456   123）", async () => {
    // 欄 (20,1) len=160 → slice0=row20 幅80 / slice1=row21 幅80。値は "123" + 空白77 + "123"
    const cmd = fld(1, 20, 1, 160, "123" + " ".repeat(77) + "123");
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap([cmd]), edits: new Map(), focused: true, insertMode: true }
    });
    const input = w.findAll("input.grid-input")[0]!; // slice0
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "456\n456" } });
    const val = [...(w.emitted("edit") as [number, string][])].reverse().find((e) => e[0] === 1)?.[1] ?? "";
    // 1 行目: offset0 へ挿入 → "456123"、元の 2 行目 "123" は 80→83 桁へずれる
    expect(val.slice(0, 6)).toBe("456123");
    // 2 行目: offset80（row21 col1）へ挿入 → "456" + ずれて空いた 3 桁 + "123"
    expect(val.slice(80, 89)).toBe("456   123");
    w.unmount();
  });

  // ACS 実機挙動: 帯（開始桁〜行末）の幅で各行を折り返し、あふれた分は次の帯行の**同じ桁**へ。
  // 次の行は前の行が使い終わった次の帯行から。10 桁欄が縦に並ぶ画面へ 111/222/333 を貼った実例。
  describe.each([
    { startCol: 9, want: ["11", "1", "22", "2", "33", "3"], why: "帯幅 2" },
    { startCol: 10, want: ["1", "1", "1", "2", "2", "2"], why: "帯幅 1" },
    { startCol: 8, want: ["111", "222", "333"], why: "帯幅 3＝ちょうど収まる" }
  ])("矩形ペーストの帯折返し（開始 $startCol 桁・$why）", ({ startCol, want }) => {
    it(`111/222/333 → ${JSON.stringify(want)}`, async () => {
      // 10 桁欄（col1..10）を縦に 9 本
      const fields: Field[] = Array.from({ length: 9 }, (_, i) => fld(i + 1, 5 + i, 1, 10));
      const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
      const input = w.findAll("input.grid-input")[0]!;
      await input.trigger("focus");
      (input.element as HTMLInputElement).setSelectionRange(startCol - 1, startCol - 1);
      await input.trigger("paste", { clipboardData: { getData: () => "111\n222\n333" } });
      const emits = w.emitted("edit") as [number, string][];
      const last = (idx: number) => [...emits].reverse().find((e) => e[0] === idx)?.[1];
      want.forEach((expected, i) => {
        // 各欄は開始桁の手前が空白、そこから帯のぶん
        expect(last(i + 1)?.slice(startCol - 1)).toBe(expected);
      });
      w.unmount();
    });
  });

  it("ペースト後もカーソルは開始桁から動かない（単一行。ACS 相当）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap([fld(1, 5, 5, 10)]), edits: new Map(), focused: true }
    });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(2, 2); // 欄の 3 桁目 ＝ 画面 (5,7)
    await input.trigger("paste", { clipboardData: { getData: () => "ABC" } });
    const cur = [...(w.emitted("cursor") as [number, number][])].pop();
    expect(cur).toEqual([5, 7]); // 旧: 貼り付けた文字の末尾（5,10）へ動いていた
    w.unmount();
  });

  it("ペーストで欄が満杯になっても次の欄へ自動送りしない（field-full を出さない）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap([fld(1, 5, 5, 5), fld(2, 6, 5, 5)]), edits: new Map(), focused: true }
    });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "ABCDE" } }); // 5 桁欄が満杯
    // 旧: advanceIfFull が field-full を出し、親が次の欄へフォーカスを送っていた。
    // ACS はペーストではカーソルを動かさないので自動送りもしない（打鍵時の自動送りは残す）
    expect(w.emitted("field-full")).toBeFalsy();
    w.unmount();
  });

  it("打鍵で欄が満杯になったときは従来どおり次の欄へ自動送りする（回帰）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap([fld(1, 5, 5, 3), fld(2, 6, 5, 3)]), edits: new Map(), focused: true }
    });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    for (const k of ["A", "B", "C"]) await input.trigger("keydown", { key: k });
    expect(w.emitted("field-full")).toBeTruthy();
    w.unmount();
  });

  it("ペースト後もカーソルは開始桁から動かない（矩形。ACS 相当）", async () => {
    const fields = [fld(1, 5, 5, 10), fld(2, 6, 5, 10)];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(2, 2);
    await input.trigger("paste", { clipboardData: { getData: () => "AB\nCD" } });
    const cur = [...(w.emitted("cursor") as [number, number][])].pop();
    expect(cur).toEqual([5, 7]); // 旧: 欄の値の末尾へ動いていた
    w.unmount();
  });

  it("複数行ペーストは書いた範囲だけ上書きし、後ろの既存文字を残す", async () => {
    // "123456" の先頭へ "789" を貼ったら "789456"（旧: 後ろを捨てて "789" になっていた）
    const fields: Field[] = [
      { index: 1, row: 5, col: 5, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "123456" },
      { index: 2, row: 6, col: 5, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "123456" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "789\n789" } });
    const emits = w.emitted("edit") as [number, string][];
    const last = (idx: number) => [...emits].reverse().find((e) => e[0] === idx)?.[1];
    expect(last(1)).toBe("789456");
    expect(last(2)).toBe("789456");
    w.unmount();
  });

  it("行またぎ欄（コマンド行）への複数行ペーストは折返し先の同じ桁へ落ちる", async () => {
    // コマンド行相当: (20,7) len=100 → slice0=row20 col7 幅74 / slice1=row21 col1 幅26
    const cmd: Field = { index: 1, row: 20, col: 7, length: 100, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap([cmd]), edits: new Map(), focused: true } });
    const input = w.findAll("input.grid-input")[0]!; // slice0
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    // 旧: 折返し先は別欄として引けず 2 行目が捨てられていた
    await input.trigger("paste", { clipboardData: { getData: () => "AAA\nBBB" } });
    const emits = w.emitted("edit") as [number, string][];
    const val = [...emits].reverse().find((e) => e[0] === 1)?.[1];
    // 1 行目は offset 0、2 行目は row21 col7 ＝ 欄先頭から 74+6=80 桁目
    expect(val?.slice(0, 3)).toBe("AAA");
    expect(val?.slice(80, 83)).toBe("BBB");
    w.unmount();
  });

  it("複数行ペーストは同じ画面桁の欄へ流す（1 行に複数欄ある画面でも矩形の形を保つ）", async () => {
    // SEU 編集画面の実寸（PUB400 実機で採取）: 各行に 行コマンド欄(col1 len7) と
    // ソース欄(col9 len71) が並ぶ。桁ではなく「次行の最初の入力欄」を選ぶと、2 行目が
    // 7 桁の行コマンド欄へ切り詰められて流れ込み、ソース行が失われる。
    const src5: Field = { index: 1, row: 5, col: 9, length: 71, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const seq6: Field = { index: 2, row: 6, col: 1, length: 7, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const src6: Field = { index: 3, row: 6, col: 9, length: 71, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap([src5, seq6, src6]), edits: new Map(), focused: true } });
    const input = w.findAll("input.grid-input")[0]!; // src5
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(0, 0);
    await input.trigger("paste", { clipboardData: { getData: () => "12345\n67890" } });
    const emits = w.emitted("edit") as [number, string][];
    const last = (idx: number) => [...emits].reverse().find((e) => e[0] === idx)?.[1];
    expect(last(3)).toBe("67890"); // 2 行目は同じ桁(col10)のソース欄へ
    expect(last(2)).toBeUndefined(); // 行番号欄(col2)は触らない
    w.unmount();
  });

  it("複数行ペーストで下方向の連続入力欄へ 1 行ずつ分配する", async () => {
    const fields: Field[] = [
      { index: 1, row: 5, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" },
      { index: 2, row: 6, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" },
      { index: 3, row: 7, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    await input.trigger("paste", { clipboardData: { getData: () => "AAA\nBBB\nCCC" } });
    const emits = w.emitted("edit") as [number, string][];
    const last = (idx: number) => [...emits].reverse().find((e) => e[0] === idx)?.[1];
    expect(last(1)).toBe("AAA");
    expect(last(2)).toBe("BBB");
    expect(last(3)).toBe("CCC");
    w.unmount();
  });

  it("複数行ペーストは次行に入力欄が無い（空行）ところで止まる", async () => {
    const fields: Field[] = [
      { index: 1, row: 5, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" },
      // row6 は欄なし（空行）→ 2 行目以降は流し込まれない
      { index: 2, row: 7, col: 10, length: 5, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.findAll("input.grid-input")[0]!;
    await input.trigger("focus");
    await input.trigger("paste", { clipboardData: { getData: () => "AAA\nBBB\nCCC" } });
    const emits = w.emitted("edit") as [number, string][];
    const last = (idx: number) => [...emits].reverse().find((e) => e[0] === idx)?.[1];
    expect(last(1)).toBe("AAA");
    expect(last(2)).toBeUndefined(); // row7 の欄には流れない（row6 が空行のため停止）
    w.unmount();
  });

  it("数値フィールドは非数字キーを拒否する", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 5, protected: false, hidden: false, numeric: true, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focus");
    await input.trigger("keydown", { key: "5" });
    await input.trigger("keydown", { key: "A" }); // 拒否される
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("5");
  });

  it("全角は同じ属性のランにまとめて描画し、桁を保つ", () => {
    const snap = makeSnap();
    const r0 = snap.cells[0]!;
    r0[0] = cell("A");
    r0[1] = { ...cell(" "), kind: "so" };
    r0[2] = { ...cell("日"), kind: "dbcs-lead" };
    r0[3] = { ...cell(""), kind: "dbcs-tail" };
    r0[4] = { ...cell(" "), kind: "si" };
    r0[5] = cell("B");
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });
    // 全角は専用スパンに切り出さず、同じ属性の前後と 1 つのランになる
    // （桁は「全角＝半角×2」の等幅前提で合う。入力欄も同じ前提でプレーン文字列を出す）
    expect(w.find(".grid-dbcs").exists()).toBe(false);
    const row = w.findAll(".grid-row")[0]!;
    expect(row.findAll("span.grid-span")).toHaveLength(1);
    // dbcs-tail は文字を出さない（lead の 1 文字が 2 桁ぶんを占める）ので A 日 B が連続する
    expect(row.text()).toContain("A 日 B");
  });

  it("katakanaView で SBCS の生バイトを半角カナ解釈で表示する", () => {
    const snap = makeSnap();
    // 生バイト 0x81（037 では 'a'、930 カナでは半角カナ）を持つセル
    const r0 = snap.cells[0]!;
    r0[0] = { ...cell("a"), rawByte: 0x81 };
    const normal = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });
    expect(normal.findAll(".grid-row")[0]!.text()).toContain("a");
    const kana = mount(ScreenGrid, {
      props: { snapshot: snap, edits: new Map(), focused: true, katakanaView: true }
    });
    // カナビューでは 'a' 以外の文字（半角カナ）になる
    const kanaText = kana.findAll(".grid-row")[0]!.text();
    expect(kanaText).not.toContain("a");
  });

  it("showShiftMarks で SO を { ・SI を } 表示する", () => {
    const snap = makeSnap();
    const r0 = snap.cells[0]!;
    r0[0] = { ...cell(" "), kind: "so" };
    r0[1] = { ...cell("日"), kind: "dbcs-lead" };
    r0[2] = { ...cell(""), kind: "dbcs-tail" };
    r0[3] = { ...cell(" "), kind: "si" };
    const off = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });
    expect(off.findAll(".grid-row")[0]!.text()).not.toContain("{");
    const on = mount(ScreenGrid, {
      props: { snapshot: snap, edits: new Map(), focused: true, showShiftMarks: true }
    });
    const line = on.findAll(".grid-row")[0]!.text();
    expect(line).toContain("{");
    expect(line).toContain("}");
  });

  it("カーソル位置にブロックカーソルを描画する", () => {
    const snap = makeSnap();
    snap.cursor = { row: 6, col: 10 };
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });
    const cursor = w.find(".cursor");
    expect(cursor.exists()).toBe(true);
    // (col-1)=9ch, (row-1)*1.25=6.25em
    expect(cursor.attributes("style")).toContain("9ch");
    expect(cursor.attributes("style")).toContain("6.25em");
  });

  it("cursor prop（有効カーソル）がオーバーレイ位置を駆動する（snapshot.cursor より優先）", () => {
    const snap = makeSnap();
    snap.cursor = { row: 1, col: 1 }; // ホスト位置
    const w = mount(ScreenGrid, {
      props: { snapshot: snap, edits: new Map(), focused: true, cursor: { row: 6, col: 10 } }
    });
    const cursor = w.find(".cursor");
    expect(cursor.exists()).toBe(true);
    expect(cursor.attributes("style")).toContain("9ch"); // prop の col=10 → 9ch（snapshot の 1 ではない）
    expect(cursor.attributes("style")).toContain("6.25em");
  });

  it("有効カーソルが編集可欄上なら field モードでオーバーレイを隠す", () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map(), focused: true, cursor: { row: 6, col: 12 } }
    });
    // (6,12) は欄内（col10..17）→ native キャレットが担うのでオーバーレイ非表示
    expect(w.find(".cursor").exists()).toBe(false);
  });

  it("保護欄上の有効カーソルは free モードでオーバーレイ表示（field ではない）", () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: true, hidden: false, numeric: false, mdt: false, value: "X" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map(), focused: true, cursor: { row: 6, col: 12 } }
    });
    expect(w.find(".cursor").exists()).toBe(true); // 保護は編集不可 → オーバーレイ
  });

  it("欄内で文字入力すると論理カーソルが native キャレット桁へ追従して emit される", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    await input.trigger("focus"); // cursor [6,10]（caret 0）
    await input.trigger("keydown", { key: "A" }); // caret 1 → cursor [6,11]
    const cursors = w.emitted("cursor") as [number, number][];
    expect(cursors.at(-1)).toEqual([6, 11]);
  });

  it("edits マップの値が input に反映される", () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "OLD" }
    ];
    const edits = new Map([[1, "NEW"]]);
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits, focused: true } });
    expect((w.find("input.grid-input").element as HTMLInputElement).value.trimEnd()).toBe("NEW");
  });

  describe("拡張 5250 GUI オーバーレイ", () => {
    function radioSnap(): ScreenSnapshot {
      const s = makeSnap();
      s.gui = {
        selectionFields: [
          {
            id: 1,
            row: 6,
            col: 4,
            kind: "radio",
            fieldType: 0x11,
            multiple: false,
            choices: [
              { index: 1, text: "YES", selected: true, available: true },
              { index: 2, text: "NO", selected: false, available: true }
            ]
          }
        ],
        windows: [],
        scrollBars: []
      };
      return s;
    }

    it("ウィンドウを枠付きオーバーレイ（タイトル付き）で描画する", () => {
      const s = makeSnap();
      s.gui = {
        selectionFields: [],
        windows: [{ id: 9, row: 3, col: 5, width: 20, height: 6, title: "PROMPT", restrictCursor: false, pulldown: false }],
        scrollBars: []
      };
      const w = mount(ScreenGrid, { props: { snapshot: s, edits: new Map(), focused: true } });
      const win = w.find(".gui-window");
      expect(win.exists()).toBe(true);
      expect(win.attributes("style")).toContain("20ch");
      expect(w.find(".gui-window-title").text()).toBe("PROMPT");
    });

    it("ラジオ選択肢を描画し、クリックで gui-select を emit する", async () => {
      const w = mount(ScreenGrid, { props: { snapshot: radioSnap(), edits: new Map(), focused: true } });
      const choices = w.findAll(".gui-selection.radio .gui-choice");
      expect(choices).toHaveLength(2);
      await choices[1]!.trigger("click");
      expect(w.emitted("gui-select")?.[0]).toEqual([1, 2, true]);
      expect(w.emitted("gui-submit")).toBeUndefined(); // ラジオは即送信しない
    });

    it("プッシュボタンはクリックで select＋submit を emit する", async () => {
      const s = makeSnap();
      s.gui = {
        selectionFields: [
          {
            id: 2,
            row: 8,
            col: 2,
            kind: "pushbutton",
            fieldType: 0x41,
            multiple: false,
            choices: [{ index: 1, text: "OK", selected: false, available: true }]
          }
        ],
        windows: [],
        scrollBars: []
      };
      const w = mount(ScreenGrid, { props: { snapshot: s, edits: new Map(), focused: true } });
      await w.find(".gui-selection.pushbutton .gui-choice").trigger("click");
      expect(w.emitted("gui-select")?.[0]).toEqual([2, 1, true]);
      expect(w.emitted("gui-submit")?.[0]).toEqual([2]);
    });

    it("選択不可の選択肢は disabled で emit しない", async () => {
      const s = radioSnap();
      s.gui!.selectionFields[0]!.choices[1]!.available = false;
      const w = mount(ScreenGrid, { props: { snapshot: s, edits: new Map(), focused: true } });
      const choices = w.findAll(".gui-selection.radio .gui-choice");
      expect((choices[1]!.element as HTMLButtonElement).disabled).toBe(true);
      await choices[1]!.trigger("click");
      expect(w.emitted("gui-select")).toBeUndefined();
    });

    it("キーボードロック中は選択肢が disabled になる", () => {
      const s = radioSnap();
      s.keyboardLocked = true;
      const w = mount(ScreenGrid, { props: { snapshot: s, edits: new Map(), focused: true } });
      const choice = w.find(".gui-selection.radio .gui-choice");
      expect((choice.element as HTMLButtonElement).disabled).toBe(true);
    });

    it("スクロールバーをつまみ位置付きで描画する", () => {
      const s = makeSnap();
      s.gui = {
        selectionFields: [],
        windows: [],
        scrollBars: [{ id: 5, row: 4, col: 79, horizontal: false, total: 100, sliderPos: 50, size: 5 }]
      };
      const w = mount(ScreenGrid, { props: { snapshot: s, edits: new Map(), focused: true } });
      const bar = w.find(".gui-scrollbar.vertical");
      expect(bar.exists()).toBe(true);
      expect(bar.find(".gui-thumb").attributes("style")).toContain("top: 50%");
    });

    it("gui が無ければオーバーレイは描画されない", () => {
      const w = mount(ScreenGrid, { props: { snapshot: makeSnap(), edits: new Map(), focused: true } });
      expect(w.find(".gui-window").exists()).toBe(false);
      expect(w.find(".gui-selection").exists()).toBe(false);
    });
  });

  describe("テキストのリンク化", () => {
    function textSnap(line: string): ScreenSnapshot {
      const s = makeSnap();
      const r: Cell[] = [];
      for (let i = 0; i < 80; i++) r.push(cell(line[i] ?? " "));
      s.cells[2] = r;
      return s;
    }

    it("URL を target=_blank rel=noopener の <a> で描画する（既定 ON）", () => {
      const w = mount(ScreenGrid, {
        props: { snapshot: textSnap("see https://pub400.com now"), edits: new Map(), focused: true }
      });
      const a = w.find("a.grid-link");
      expect(a.exists()).toBe(true);
      expect(a.attributes("href")).toBe("https://pub400.com");
      expect(a.attributes("target")).toBe("_blank");
      expect(a.attributes("rel")).toBe("noopener noreferrer");
      expect(a.text()).toBe("https://pub400.com");
    });

    it("メールアドレスを mailto リンクにする", () => {
      const w = mount(ScreenGrid, {
        props: { snapshot: textSnap("mail admin@example.com ok"), edits: new Map(), focused: true }
      });
      expect(w.find("a.grid-link").attributes("href")).toBe("mailto:admin@example.com");
    });

    it("linkify=false ではリンク化しない", () => {
      const w = mount(ScreenGrid, {
        props: { snapshot: textSnap("see https://pub400.com"), edits: new Map(), focused: true, linkify: false }
      });
      expect(w.find("a.grid-link").exists()).toBe(false);
      expect(w.findAll(".grid-row")[2]!.text()).toContain("https://pub400.com");
    });

    it("カタカナ表示中はリンク化を無効化する", () => {
      const w = mount(ScreenGrid, {
        props: { snapshot: textSnap("http://x.io"), edits: new Map(), focused: true, katakanaView: true }
      });
      expect(w.find("a.grid-link").exists()).toBe(false);
    });

    it("入力フィールドのテキストはリンク化しない（text ランのみ対象）", () => {
      const s = makeSnap([
        { index: 1, row: 3, col: 1, length: 20, protected: false, hidden: false, numeric: false, mdt: false, value: "http://x.io" }
      ]);
      const w = mount(ScreenGrid, { props: { snapshot: s, edits: new Map(), focused: true } });
      // input 内の値はリンクにならない
      expect(w.find("a.grid-link").exists()).toBe(false);
      expect(w.find("input.grid-input").exists()).toBe(true);
    });

    it("リンク描画後も行の桁数（80）が保たれる", () => {
      const w = mount(ScreenGrid, {
        props: { snapshot: textSnap("x http://a.io y"), edits: new Map(), focused: true }
      });
      // .text() は末尾空白を trim するため textContent で桁数を確認（リンクは文字数を変えない）
      expect(w.findAll(".grid-row")[2]!.element.textContent).toHaveLength(80);
    });

    it("linkify トグル切替で既存行も即再描画される（v-memo に linkEnabled を含む）", async () => {
      const w = mount(ScreenGrid, {
        props: { snapshot: textSnap("see http://x.io"), edits: new Map(), focused: true, linkify: true }
      });
      expect(w.find("a.grid-link").exists()).toBe(true);
      await w.setProps({ linkify: false });
      expect(w.find("a.grid-link").exists()).toBe(false); // segs 不変でも再描画される
      await w.setProps({ linkify: true });
      expect(w.find("a.grid-link").exists()).toBe(true);
    });
  });

  describe("画面サイズ切替（24x80⇔27x132）でフォントを再フィットする", () => {
    // 24x80 画面（cells は全て空白でよい）
    function snap24x80(): ScreenSnapshot {
      const cells: Cell[][] = [];
      for (let r = 0; r < 24; r++) cells.push(Array.from({ length: 80 }, () => cell(" ")));
      return { sessionId: "s", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields: [] };
    }
    // 27x132 代替画面
    function snap27x132(): ScreenSnapshot {
      const cells: Cell[][] = [];
      for (let r = 0; r < 27; r++) cells.push(Array.from({ length: 132 }, () => cell(" ")));
      return { sessionId: "s", rows: 27, cols: 132, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells, fields: [] };
    }

    // jsdom はレイアウトしないため親（.screen-wrap 相当＝マウント先）の寸法を固定でスタブする
    function withStubbedLayout(width: number, height: number, run: () => Promise<void> | void) {
      const proto = HTMLElement.prototype;
      const ow = Object.getOwnPropertyDescriptor(proto, "clientWidth");
      const oh = Object.getOwnPropertyDescriptor(proto, "clientHeight");
      Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => width });
      Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => height });
      const restore = () => {
        if (ow) Object.defineProperty(proto, "clientWidth", ow);
        else delete (proto as unknown as Record<string, unknown>).clientWidth;
        if (oh) Object.defineProperty(proto, "clientHeight", oh);
        else delete (proto as unknown as Record<string, unknown>).clientHeight;
      };
      return Promise.resolve(run()).finally(restore);
    }

    function fontPx(w: ReturnType<typeof mount>): number {
      const style = w.find(".grid").attributes("style") ?? "";
      return parseFloat(/font-size:\s*([\d.]+)px/.exec(style)?.[1] ?? "0");
    }

    it("24x80→27x132 でフォントが縮む（見切れ防止）／27x132→24x80 で拡大する（小さいまま防止）", async () => {
      await withStubbedLayout(1000, 700, async () => {
        const w = mount(ScreenGrid, {
          props: { snapshot: snap24x80(), edits: new Map(), focused: false },
          attachTo: document.body
        });
        await nextTick();
        const wide24 = fontPx(w);
        expect(wide24).toBeGreaterThan(0);

        // ワイド画面へ遷移 → 132 桁を収めるためフォントは小さくなる
        await w.setProps({ snapshot: snap27x132() });
        await nextTick();
        await nextTick();
        const wide132 = fontPx(w);
        expect(wide132).toBeLessThan(wide24);

        // 24x80 へ戻すと再び拡大（小さいままにならない）
        await w.setProps({ snapshot: snap24x80() });
        await nextTick();
        await nextTick();
        expect(fontPx(w)).toBeCloseTo(wide24, 5);
        w.unmount();
      });
    });
  });
});

describe("DBCS 座標変換の集約（dbcsLayoutOf）", () => {
  // 各ハンドラが dbcsViewLayout を個別に呼び引数を組み立てていたため、
  // 「trim 済みを渡す」「SO/SI マークを渡し忘れる」不整合が繰り返し混入した。
  // 単一入口に集約したことで、下記のような経路差が生じないことを固定する。
  function dbcsField(): Field[] {
    return [
      { index: 1, row: 6, col: 10, length: 12, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
  }

  it("showShiftMarks 有効でもコピーは純論理値（マーク未指定だと caret がずれ範囲が狂う）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(dbcsField()), edits: new Map([[1, "AあB"]]), focused: true, showShiftMarks: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    expect(el.value.startsWith("A{あ}B")).toBe(true); // SO={ / SI=}
    el.setSelectionRange(0, 5); // A{あ}B 全体
    const setData = vi.fn();
    await input.trigger("copy", { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "AあB"); // { } は含まない
    w.unmount();
  });

  it("未入力桁で IME 合成しても先頭へ飛ばない（trim 版だと logicalOf が 0 を返す）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(dbcsField()), edits: new Map(), focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    expect(el.value).toBe(" ".repeat(12)); // 空欄でも欄長ぶんパディング
    el.setSelectionRange(5, 5); // 未入力の 5 桁目
    await input.trigger("compositionstart");
    expect(el.value).toBe("     "); // 合成開始桁より前＝5 桁ぶんの空白（先頭に飛んでいない）
    el.value += "日";
    await input.trigger("compositionend");
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("     日"); // 5 桁目に入る
    w.unmount();
  });
});

describe("DBCS 欄の上書き（全角）", () => {
  // 全角の入力経路（IME 確定・ペースト）が dbcsInsert（挿入固定）を呼んでおり、上書き既定に
  // なっていなかった。また上書きが 1 文字置換だと SO/SI で桁が増えて後続が押し出される。
  function f12(): Field[] {
    return [
      { index: 1, row: 6, col: 10, length: 16, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
  }

  it("ペーストした全角は上書きされる（後続を押し出さない）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(f12()), edits: new Map([[1, "ABCDEF"]]), focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    (input.element as HTMLInputElement).setSelectionRange(1, 1);
    await input.trigger("focus");
    (input.element as HTMLInputElement).setSelectionRange(1, 1);
    await input.trigger("paste", { clipboardData: { getData: () => "日" } } as unknown as ClipboardEvent);
    // 日 は SO+2+SI=4 桁を占めるので後続 BCDE を食う → A日F（挿入なら A日BCDEF）
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("A日F");
    w.unmount();
  });

  it("IME 確定した全角も上書きされる", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(f12()), edits: new Map([[1, "ABCDEF"]]), focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(1, 1);
    await input.trigger("compositionstart");
    el.value += "日"; // 実 IME は既存 value（prefix）へ追記する
    await input.trigger("compositionend");
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("A日F");
    w.unmount();
  });

  it("Insert モードなら全角は挿入される（後続が残る）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(f12()), edits: new Map([[1, "ABCDEF"]]), focused: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(1, 1);
    await input.trigger("keydown", { key: "Insert" }); // 挿入モードへ
    el.setSelectionRange(1, 1);
    await input.trigger("paste", { clipboardData: { getData: () => "日" } } as unknown as ClipboardEvent);
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("A日BCDEF");
    w.unmount();
  });
});

describe("DBCS 欄: 桁 → 論理カーソルの変換", () => {
  it("全角がある欄に桁指定でカーソルを合わせても右端へ飛ばない", async () => {
    // ああああああ は 6 文字だが 14 桁（SO+12+SI）。表示桁を列ビューの文字 index として
    // 渡すとビュー長（8 文字）を超えて末尾へクランプされ、キャレットが右端へ飛んでいた。
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 40, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map([[1, "ああああああ"]]), focused: true },
      attachTo: document.body
    });
    const el = w.find("input.grid-input").element as HTMLInputElement;
    await w.find("input.grid-input").trigger("focus");
    // 欄先頭から 20 桁目（全角 6 文字＝14 桁より右の未入力桁）へ合わせる
    (w.vm as unknown as { setDbcsCaretAtColumn: (i: number, r: number, c: number) => void }).setDbcsCaretAtColumn(1, 6, 10 + 20);
    await nextTick();
    // 右端（value 末尾）ではなく、20 桁目相当に置かれる
    expect(el.selectionStart).toBeLessThan(el.value.length);
    expect(el.selectionStart).toBeGreaterThan(6); // 全角 6 文字ぶん（ビュー index 7）より右
    w.unmount();
  });
});

describe("DBCS 欄: ホスト由来（セル）の値で桁指定カーソル", () => {
  it("未編集（セル由来）の欄でも、内容より右の桁を指定したら末尾へスナップしない", async () => {
    // ホストが書いた " あいうえお " を欄セルに置く（SO/あいうえお/SI）。edits は空＝未編集。
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 40, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const snapshot = makeSnap(fields);
    const row = snapshot.cells[5]!;
    row[9] = { ...cell(" "), kind: "so" };
    let c = 10;
    for (const ch of ["あ", "い", "う", "え", "お"]) {
      row[c] = { ...cell(ch), kind: "dbcs-lead" };
      row[c + 1] = { ...cell(""), kind: "dbcs-tail" };
      c += 2;
    }
    row[c] = { ...cell(" "), kind: "si" };
    const w = mount(ScreenGrid, {
      props: { snapshot, edits: new Map(), focused: true },
      attachTo: document.body
    });
    const el = w.find("input.grid-input").element as HTMLInputElement;
    await w.find("input.grid-input").trigger("focus");
    // " あいうえお " は 12 桁。欄先頭から 20 桁目（内容より右の未入力桁）を指定する
    (w.vm as unknown as { setDbcsCaretAtColumn: (i: number, r: number, c: number) => void }).setDbcsCaretAtColumn(1, 6, 10 + 20);
    await nextTick();
    // 内容末尾（ビュー index 7 付近）へスナップせず、20 桁目相当（＝より右）に置かれる
    expect(el.selectionStart).toBeGreaterThan(7);
    w.unmount();
  });
});

describe("DBCS 欄: 桁指定カーソルは往復スナップでずれない", () => {
  it("指定した桁のビュー位置にそのまま置かれる（logicalOf→caretOf の往復でずらさない）", async () => {
    // 列ビュー " あいうえお " ＋パディング。SO=桁0 / あ=1-2 / い=3-4 / う=5-6 / え=7-8 /
    // お=9-10 / SI=11 / 以降パディング。logicalOf は「最も近い論理カーソル」へのスナップなので
    // caretOf(logicalOf(v)) は v に戻らない＝往復すると指定桁からずれる。
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 40, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map([[1, "あいうえお"]]), focused: true },
      attachTo: document.body
    });
    const el = w.find("input.grid-input").element as HTMLInputElement;
    await w.find("input.grid-input").trigger("focus");
    const setCaret = (w.vm as unknown as { setDbcsCaretAtColumn: (i: number, r: number, c: number) => void })
      .setDbcsCaretAtColumn;

    // SI の桁（欄先頭から 11 桁目）→ ビュー index 6 にそのまま置く
    setCaret(1, 6, 10 + 11);
    await nextTick();
    expect(el.selectionStart).toBe(6);

    // 内容より右の未入力桁（20 桁目）→ SI(index 6) の後ろのパディング index 7 + (20-12) = 15
    setCaret(1, 6, 10 + 20);
    await nextTick();
    expect(el.selectionStart).toBe(15);

    // 全角の途中桁（あ の 2 桁目＝桁 2）は、その全角の開始 index（1）に載る
    setCaret(1, 6, 10 + 2);
    await nextTick();
    expect(el.selectionStart).toBe(1);
    w.unmount();
  });
});

describe("DBCS 欄: SI 桁を指定してもキャレットが左へ引き戻されない", () => {
  it("`}`(SI) の桁を指定 → その桁に置かれ、モデルの論理カーソルも一致する", async () => {
    // 列ビュー "{あいうえお}"（showShiftMarks）: { =桁0 / あ=1-2 / い=3-4 / う=5-6 / え=7-8 /
    // お=9-10 / } =桁11。SI(view index 6) は「お の手前(5)」と「お の直後(7)」から等距離で、
    // logicalOf（最も近い）だと左へ寄り、以降の同期でキャレットが 2 桁左へ引き戻されていた。
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 40, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map([[1, "あいうえお"]]), focused: true, showShiftMarks: true },
      attachTo: document.body
    });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    (w.vm as unknown as { setDbcsCaretAtColumn: (i: number, r: number, c: number) => void }).setDbcsCaretAtColumn(1, 6, 10 + 11);
    await nextTick();
    expect(el.selectionStart).toBe(6); // SI の位置（桁 11）にそのまま置かれる
    // モデルとキャレットが一致していること＝以降の同期で引き戻されない。
    // キー入力で syncDbcs が走ってもキャレットが左へ動かないことで確認する。
    await input.trigger("keydown", { key: "ArrowRight" });
    expect(el.selectionStart).toBeGreaterThanOrEqual(6);
    w.unmount();
  });
});

describe("矩形コピーは未送信の入力値も拾う", () => {
  // 従来は cells（ホストが描いた内容）だけを読んでいたため、入力欄に打った値が
  // Ctrl+C で取れなかった（SBCS/DBCS とも）。
  it("SBCS 欄に打った値がコピーされる", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map([[1, "ABC"]]), focused: true },
      attachTo: document.body
    });
    // 欄の桁(10..12)を含む矩形を選択してコピー
    (w.vm as unknown as { setBlockSelection: (r: unknown) => void }).setBlockSelection({ r1: 6, c1: 10, r2: 6, c2: 12 });
    await nextTick();
    const setData = vi.fn();
    document.dispatchEvent(
      Object.assign(new Event("copy", { bubbles: true, cancelable: true }), { clipboardData: { setData } })
    );
    expect(setData).toHaveBeenCalledWith("text/plain", "ABC");
    w.unmount();
  });

  it("DBCS 欄に打った全角がコピーされる（SO/SI は含まない）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 16, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(fields), edits: new Map([[1, "あい"]]), focused: true },
      attachTo: document.body
    });
    // 列ビュー " あい " → SO=桁10 / あ=11-12 / い=13-14 / SI=15。全角ぶんを選択
    (w.vm as unknown as { setBlockSelection: (r: unknown) => void }).setBlockSelection({ r1: 6, c1: 11, r2: 6, c2: 14 });
    await nextTick();
    const setData = vi.fn();
    document.dispatchEvent(
      Object.assign(new Event("copy", { bubbles: true, cancelable: true }), { clipboardData: { setData } })
    );
    expect(setData).toHaveBeenCalledWith("text/plain", "あい");
    w.unmount();
  });
});

describe("DBCS 欄の行またぎ（折返し）", () => {
  // キーは必ず「フォーカス中の <input>」に届く（実ブラウザと同じ）。折返し欄では入力の途中で
  // フォーカスが次スライスへ移るため、掴んだ最初の input に投げ続けるとカーソルが巻き戻る。
  const typeKey = async (w: ReturnType<typeof mount>, key: string) => {
    const el = document.activeElement;
    const target = w.findAll("input.grid-input").find((i) => i.element === el) ?? w.find("input.grid-input");
    await target.trigger("keydown", { key });
  };

  // 1399 のコマンド行相当: (20,7) len=153 → row20 に 74 桁（境界 74）、row21 に 79 桁。
  const cmdLine = (): Field[] => [
    { index: 1, row: 20, col: 7, length: 153, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "" }
  ];

  it("2 行目のスライスに直接フォーカスすると、そのスライスの先頭桁から入力できる", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(cmdLine()), edits: new Map(), focused: false },
      attachTo: document.body
    });
    const second = w.findAll("input.grid-input")[1]!;
    await second.trigger("focus");
    // 折返し先の行頭（21,1）を指す。1 行目の先頭へ飛ばない
    expect((w.emitted("cursor") as [number, number][]).at(-1)).toEqual([21, 1]);
    await typeKey(w, "X");
    // 2 行目の先頭桁＝論理 74 桁目。1 行目の 74 桁ぶんは空白のまま保たれる
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe(" ".repeat(74) + "X");
    expect((second.element as HTMLInputElement).value.startsWith("X")).toBe(true);
    w.unmount();
  });

  it("1 行目の末尾を越えて入力すると 2 行目のスライスへ続く", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(cmdLine()), edits: new Map([[1, "A".repeat(73)]]), focused: false },
      attachTo: document.body
    });
    const inputs = w.findAll("input.grid-input");
    const first = inputs[0]!;
    await first.trigger("focus");
    await typeKey(w, "End"); // 73 文字目の直後＝1 行目の最終桁
    await typeKey(w, "B"); // 74 桁目（1 行目の末尾）
    await typeKey(w, "C"); // 75 桁目 → 2 行目へ折返す
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("A".repeat(73) + "BC");
    // C は 2 行目のスライスへ入り、フォーカスもそちらへ移る
    expect((inputs[1]!.element as HTMLInputElement).value.startsWith("C")).toBe(true);
    expect(document.activeElement).toBe(inputs[1]!.element);
    expect((w.emitted("cursor") as [number, number][]).at(-1)).toEqual([21, 2]);
    w.unmount();
  });

  it("全角が折返し境界に割れても桁揃えせず、ACS と同じくまたがせる", async () => {
    // 半角 72 桁 → SO=桁72, 全角=桁73-74 で境界 74 が全角の途中に落ちる。
    // ACS はこのグリフを左右に割って描画する＝桁揃えのスペースは入れない（＝容量も減らない）。
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(cmdLine()), edits: new Map([[1, "A".repeat(72)]]), focused: false },
      attachTo: document.body
    });
    const inputs = w.findAll("input.grid-input");
    const first = inputs[0]!;
    await first.trigger("focus");
    await typeKey(w, "End");
    await typeKey(w, "あ");
    // 送信値へ余計なスペースを入れない（桁揃えする実装では "A"*72 + " あ" になっていた）
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("A".repeat(72) + "あ");
    // またぐ全角の実体は 1 行目の末尾が持つ（input 幅でクリップされ左半分が行末に出る）
    expect((inputs[0]!.element as HTMLInputElement).value.endsWith("あ")).toBe(true);
    // 2 行目は「またいで来た後半桁」ぶんの空白 1 桁で始まり、桁数は 79 のまま
    const row2 = (inputs[1]!.element as HTMLInputElement).value;
    expect(row2.startsWith(" ")).toBe(true);
    expect(row2.includes("あ")).toBe(false);
    expect(row2).toHaveLength(79);
    w.unmount();
  });

  it("またぐ全角があっても欄の容量は素のバイト長のまま（2 行目で入れる文字が減らない）", async () => {
    // 桁揃えする実装だと、境界に全角が掛かるだけで 1〜3 桁ぶん容量が削られていた。
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(cmdLine()), edits: new Map([[1, "A".repeat(72) + "あ"]]), focused: false },
      attachTo: document.body
    });
    const first = w.findAll("input.grid-input")[0]!;
    await first.trigger("focus");
    await typeKey(w, "End");
    // "A"×72 + あ = 72 + (SO+2+SI) = 76 桁。残り 153-76 = 77 桁ぶん半角が入る
    for (let i = 0; i < 85; i++) await typeKey(w, "Z");
    const sent = (w.emitted("edit") as [number, string][]).at(-1)![1];
    expect((sent.match(/Z/g) ?? []).length).toBe(77);
    w.unmount();
  });

  it("2 行目の全角を Backspace すると 2 行目の値だけが縮む（1 行目へ食い込まない）", async () => {
    const w = mount(ScreenGrid, {
      props: { snapshot: makeSnap(cmdLine()), edits: new Map([[1, "A".repeat(74) + "あい"]]), focused: false },
      attachTo: document.body
    });
    const second = w.findAll("input.grid-input")[1]!;
    await second.trigger("focus");
    await typeKey(w, "End");
    await typeKey(w, "Backspace");
    expect((w.emitted("edit") as [number, string][]).at(-1)![1]).toBe("A".repeat(74) + "あ");
    w.unmount();
  });
});
