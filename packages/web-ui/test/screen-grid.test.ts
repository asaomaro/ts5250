import { describe, it, expect } from "vitest";
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

  it("入力フィールドを inline input として描画し、hidden は password 型", () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 8, protected: false, hidden: false, numeric: false, mdt: false, value: "TARO" },
      { index: 2, row: 7, col: 10, length: 8, protected: false, hidden: true, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const inputs = w.findAll("input.grid-input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.attributes("type")).toBe("text");
    expect(inputs[1]!.attributes("type")).toBe("password"); // hidden はマスク
    expect((inputs[0]!.element as HTMLInputElement).value.trimEnd()).toBe("TARO");
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

  it("複数行フィールド（コマンド行等）は可視行の桁数に収める（次行への回り込み防止）", () => {
    // (20,7) len=153 は 80 桁画面で row20-21 にまたがる。入力欄は可視行(80-6=74)に収める
    const fields: Field[] = [
      { index: 1, row: 20, col: 7, length: 153, protected: false, hidden: false, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: false } });
    const inp = w.find("input.grid-input");
    expect(w.findAll("input.grid-input")).toHaveLength(1);
    expect((inp.element as HTMLInputElement).value.length).toBe(74); // 153 ではなく可視 74
    expect(inp.attributes("maxlength")).toBe("74");
    expect(inp.attributes("style")).toContain("74ch");
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

  it("既入力の後ろに IME 合成すると、既入力を残し候補が入力位置に出る（先頭に出ない）", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 12, protected: false, hidden: false, numeric: false, dbcsType: "open", mdt: false, value: "あいう" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    const el = input.element as HTMLInputElement;
    await input.trigger("focus");
    el.setSelectionRange(3, 3); // 既入力「あいう」の直後にカーソル
    await input.trigger("compositionstart");
    // 既入力は残る（欄全体を空にしない）→ 候補が先頭でなく入力位置に出る
    expect(el.value).toBe("あいう");
    expect(el.selectionStart).toBe(3); // caret は既入力の末尾＝合成開始位置
    el.value = "あいうえお"; // IME が「えお」を既入力の後ろに挿入
    await input.trigger("compositionend");
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)![1]).toBe("あいうえお"); // 既入力＋確定分が二重化せず結合
  });

  it("hidden（パスワード）欄はスペース埋めで全桁●にならず、実入力分のみ・送信値も実入力", async () => {
    const fields: Field[] = [
      { index: 1, row: 6, col: 10, length: 20, protected: false, hidden: true, numeric: false, mdt: false, value: "" }
    ];
    const w = mount(ScreenGrid, { props: { snapshot: makeSnap(fields), edits: new Map(), focused: true } });
    const input = w.find("input.grid-input");
    expect(input.attributes("type")).toBe("password");
    await input.trigger("focus");
    for (const ch of ["P", "A", "S", "S"]) await input.trigger("keydown", { key: ch });
    // 表示値はパディング空白を含まず 4 文字（field 長 20 の全●表示にならない）
    expect((input.element as HTMLInputElement).value).toBe("PASS");
    // 送信値（emit）も実入力
    const emits = w.emitted("edit") as [number, string][];
    expect(emits.at(-1)).toEqual([1, "PASS"]);
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

  it("DBCS lead セルを 2ch 幅の全角スパンで描画し、桁を保つ", () => {
    const snap = makeSnap();
    const r0 = snap.cells[0]!;
    r0[0] = cell("A");
    r0[1] = { ...cell(" "), kind: "so" };
    r0[2] = { ...cell("日"), kind: "dbcs-lead" };
    r0[3] = { ...cell(""), kind: "dbcs-tail" };
    r0[4] = { ...cell(" "), kind: "si" };
    r0[5] = cell("B");
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: true } });
    const dbcs = w.find(".grid-dbcs");
    expect(dbcs.exists()).toBe(true);
    expect(dbcs.text()).toBe("日");
    // 行の可視テキストに日本語が含まれ、A と B の間に配置される
    expect(w.findAll(".grid-row")[0]!.text()).toContain("日");
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
