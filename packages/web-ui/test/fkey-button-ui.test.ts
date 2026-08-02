import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import ScreenGrid from "../src/components/ScreenGrid.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { viewSettings, initViewSettings } from "../src/stores/viewSettings.js";
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

const SID = "fk1";

function cell(ch: string, kind: Cell["kind"] = "sbcs"): Cell {
  return { char: ch, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false };
}
/** 行文字列 → Cell 行（全角は lead + tail の 2 セル＝実機と同じ「1 セル = 1 桁」） */
function toCells(line: string, cols = 80): Cell[] {
  const out: Cell[] = [];
  for (const ch of line) {
    if (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch)) {
      out.push(cell(ch, "dbcs-lead"));
      out.push(cell(" ", "dbcs-tail"));
    } else out.push(cell(ch));
  }
  while (out.length < cols) out.push(cell(" "));
  return out.slice(0, cols);
}
function snapOf(lines: string[], fields: Field[] = [], extra: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) cells.push(toCells(lines[r] ?? "", 80));
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields, ...extra,
  } as ScreenSnapshot;
}
function seed(snap: ScreenSnapshot, send: (m: unknown) => void = () => {}): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap, edits: new Map(), cursor: snap.cursor,
    connected: true, readOnly: false, client: { send } as unknown as WsClient,
  });
}

const LEGEND = " F3= 終了    F12= 取り消し";

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
});

describe("ボタン化の ON/OFF", () => {
  it("既定（意匠なし）ではボタンにしない", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf([LEGEND]), edits: new Map(), focused: false } });
    await nextTick();
    expect(w.findAll("button.fkey-btn")).toHaveLength(0);
    // 文字は消えない
    expect(w.text()).toContain("F3= 終了");
    w.unmount();
  });

  it("意匠を選ぶと凡例がボタンになる（ラベルまで含む）", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf([LEGEND]), edits: new Map(), focused: false, buttons: "box" } });
    await nextTick();
    const btns = w.findAll("button.fkey-btn");
    expect(btns.map((b) => b.text())).toEqual(["F3= 終了", "F12= 取り消し"]);
    w.unmount();
  });

  it("ボタン化しても桁がずれない（DBCS を含む行）", async () => {
    // 桁の真実は「行の表示文字列」。ボタンに分割しても文字の並びが変わらないことを見る。
    const snap = snapOf([LEGEND]);
    const off = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: false } });
    const on = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: false, buttons: "box" } });
    await nextTick();
    const rowText = (w: ReturnType<typeof mount>) => w.findAll(".grid-row")[0]!.text();
    expect(rowText(on)).toBe(rowText(off));
    off.unmount();
    on.unmount();
  });
});

describe("入力欄は対象外（spec D2）", () => {
  it("入力欄の値が凡例に見えてもボタンにしない", async () => {
    // (1,2) から 10 桁の入力欄に "F12=X" が入っている画面
    const field: Field = { index: 1, row: 1, col: 2, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "F12=X" };
    const w = mount(ScreenGrid, {
      props: { snapshot: snapOf(["                    "], [field]), edits: new Map(), focused: false, buttons: "box" },
    });
    await nextTick();
    expect(w.findAll("button.fkey-btn")).toHaveLength(0);
    w.unmount();
  });
});

describe("クリックで AID を送る（spec B3）", () => {
  it("押すとその機能キーがホストへ送られる", async () => {
    const sent: string[] = [];
    seed(snapOf([LEGEND]), (m) => { sent.push(JSON.stringify(m)); });
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    const btns = w.findAll("button.fkey-btn");
    expect(btns.length).toBe(2);
    await btns[1]!.trigger("click"); // F12
    await nextTick();

    expect(sent.join(" ")).toContain("F12");
    w.unmount();
  });

  it("キーボードロック中は送らない", async () => {
    const sent: string[] = [];
    seed(snapOf([LEGEND], [], { keyboardLocked: true }), (m) => { sent.push(JSON.stringify(m)); });
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const btn = w.find("button.fkey-btn");
    if (btn.exists()) await btn.trigger("click");
    await nextTick();
    expect(sent.join(" ")).not.toContain("F3");
    w.unmount();
  });

  it("ペインに data-buttons が伝わり、意匠が CSS で効く土台になる", async () => {
    seed(snapOf([LEGEND]));
    viewSettings.set("buttons", "filled");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    expect(w.find(".pane").attributes("data-buttons")).toBe("filled");
    w.unmount();
  });
});

describe("拡張5250 の選択肢との共存（spec FR-7/FR-8）", () => {
  const guiSnap = (): ScreenSnapshot =>
    snapOf([LEGEND, "", "  choices"], [], {
      gui: {
        selectionFields: [{
          id: 1, row: 3, col: 3, kind: "pushbutton", fieldType: 0x11, multiple: false,
          choices: [
            { index: 1, text: "OK", selected: true, available: true },
            { index: 2, text: "NG", selected: false, available: false },
          ],
        }],
        windows: [], scrollBars: [], gridLines: [],
      },
    } as Partial<ScreenSnapshot>);

  it("宣言された選択肢は意匠に関わらず描画され、選択済み・利用不可の区別が残る", async () => {
    for (const buttons of ["none", "underline", "filled", "box"] as const) {
      const w = mount(ScreenGrid, { props: { snapshot: guiSnap(), edits: new Map(), focused: false, buttons } });
      await nextTick();
      const choices = w.findAll(".gui-choice");
      expect(choices, `buttons=${buttons}`).toHaveLength(2);
      expect(choices[0]!.classes(), `buttons=${buttons}`).toContain("selected");
      expect(choices[1]!.classes(), `buttons=${buttons}`).toContain("unavailable");
      w.unmount();
    }
  });

  it("宣言のある行では凡例をボタン化しない（二重に出さない）", async () => {
    // 凡例と同じ行(1 行目)に宣言がある画面
    const snap = snapOf([LEGEND], [], {
      gui: {
        selectionFields: [{ id: 1, row: 1, col: 2, kind: "pushbutton", fieldType: 0x11, multiple: false, choices: [] }],
        windows: [], scrollBars: [], gridLines: [],
      },
    } as Partial<ScreenSnapshot>);
    const w = mount(ScreenGrid, { props: { snapshot: snap, edits: new Map(), focused: false, buttons: "box" } });
    await nextTick();
    expect(w.findAll("button.fkey-btn")).toHaveLength(0);
    w.unmount();
  });
});

describe("ボタン意匠の CSS（ビルド後）", () => {
  // scoped CSS は vitest の DOM に適用されないため、ビルド成果物の規則を検査する
  // （CRT の滲みで「一部の要素に掛け忘れる」取りこぼしを実際に踏んだため、同じ方式で固定する）。
  it("4 意匠が .fkey-btn と .gui-choice の両方を対象にしている", async () => {
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "dist/assets");
    if (!existsSync(dir)) return; // 未ビルド時はスキップ
    const css = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    if (!css) return;
    for (const style of ["underline", "filled", "box", "pill", "ghost", "raised", "link"]) {
      const rules = css.match(new RegExp(`\\.pane\\[data-buttons=${style}\\][^{]*\\{[^}]*\\}`, "g")) ?? [];
      const joined = rules.join("");
      expect(joined, `${style} が .fkey-btn を対象にしていない`).toContain(".fkey-btn");
      expect(joined, `${style} が .gui-choice を対象にしていない`).toContain(".gui-choice");
    }
  });
});

describe("キー設定との連動", () => {
  it("ボタン設定は順送りの対象に入る（VIEW_ITEMS 由来）", () => {
    const first = viewSettings.settings.buttons;
    expect(first).toBe("none");
    expect(viewSettings.cycle("buttons")).toEqual({ label: "ボタン設定", valueLabel: "下線" });
    expect(viewSettings.settings.buttons).toBe("underline");
  });
});

describe("フォーカスを奪わない（spec B3）", () => {
  it("マウス操作ではフォーカスを奪わない（mousedown を止める）", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf([LEGEND]), edits: new Map(), focused: false, buttons: "box" } });
    await nextTick();
    const btn = w.find("button.fkey-btn");
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    w.unmount();
  });
});

describe("矩形選択を妨げない（ユーザー要求）", () => {
  it("ボタンの上で mousedown しても、グリッドのドラッグ選択が始まる", async () => {
    seed(snapOf([LEGEND]));
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    // ボタンの mousedown は .stop していないので、グリッドの mousedown まで伝わる必要がある
    const grid = w.find(".grid");
    let reachedGrid = false;
    grid.element.addEventListener("mousedown", () => { reachedGrid = true; }, true);
    const btn = w.find("button.fkey-btn");
    btn.element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(reachedGrid).toBe(true);
    w.unmount();
  });

  it("ボタンにフォーカスがあっても Shift+矢印の矩形選択が働く", async () => {
    seed(snapOf([LEGEND]));
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    const btn = w.find("button.fkey-btn");
    (btn.element as HTMLButtonElement).focus();
    await w.find(".pane").trigger("keydown", { key: "ArrowRight", shiftKey: true });
    await nextTick();
    // 選択の矩形が描かれる（キーボード選択が成立している）
    expect(w.find(".rect-sel").exists()).toBe(true);
    w.unmount();
  });

  it("マウスでボタンを押してもフォーカス（＝カーソル位置）を奪わない", async () => {
    seed(snapOf([LEGEND]));
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    const btn = w.find("button.fkey-btn");
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // 既定動作（フォーカス移動）を止めている
    w.unmount();
  });
});

describe("ボタンとして普通に扱える（ユーザー要求）", () => {
  it("タブ順に入る（tabindex を落とさない）", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf([LEGEND]), edits: new Map(), focused: false, buttons: "box" } });
    await nextTick();
    expect(w.find("button.fkey-btn").attributes("tabindex")).toBeUndefined();
    w.unmount();
  });

  it("Tab でボタンへ移動できる（入力欄が無い画面でも）", async () => {
    seed(snapOf([LEGEND])); // 入力欄なし・ボタンだけの画面
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    await w.find(".pane").trigger("keydown", { key: "Tab" });
    await nextTick();
    const btns = w.findAll("button.fkey-btn");
    expect(document.activeElement).toBe(btns[0]!.element);

    // 続けて Tab で次のボタンへ
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    await nextTick();
    expect(document.activeElement).toBe(btns[1]!.element);
    w.unmount();
  });

  it("フォーカス中のボタンは Space で押せる", async () => {
    const sent: string[] = [];
    seed(snapOf([LEGEND]), (m) => { sent.push(JSON.stringify(m)); });
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    const btns = w.findAll("button.fkey-btn");
    (btns[1]!.element as HTMLButtonElement).focus(); // F12
    await w.find(".pane").trigger("keydown", { key: " " });
    await nextTick();

    expect(sent.join(" ")).toContain("F12");
    w.unmount();
  });

  it("Enter はボタンに奪われず 5250 の AID のまま", async () => {
    const sent: string[] = [];
    seed(snapOf([LEGEND]), (m) => { sent.push(JSON.stringify(m)); });
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    (w.findAll("button.fkey-btn")[0]!.element as HTMLButtonElement).focus(); // F3 にフォーカス
    await w.find(".pane").trigger("keydown", { key: "Enter" });
    await nextTick();

    const s = sent.join(" ");
    expect(s).toContain("Enter");
    expect(s).not.toContain("F3");
    w.unmount();
  });
});

describe("桁を動かさないための CSS 契約", () => {
  // 桁ズレは**実ブラウザのレイアウト**でしか測れず、vitest の DOM では検出できない。
  // 実測（4 意匠すべてで差 0.00px）は test 工程で確認済みなので、ここでは
  // 「桁を動かす原因になる指定が入り込んでいないこと」をビルド後 CSS で固定する。
  it(".fkey-btn は padding/border/margin を持たず font を継ぐ", async () => {
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "dist/assets");
    if (!existsSync(dir)) return; // 未ビルド時はスキップ
    const css = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    if (!css) return;
    // 素の .fkey-btn ルール（:focus-visible や [data-buttons] 配下ではないもの）
    const base = /(?:^|})(\.fkey-btn\[data-v-[a-z0-9]+\])\{([^}]*)\}/.exec(css);
    expect(base, ".fkey-btn の基本ルールが見つからない").not.toBeNull();
    const body = base![2]!;
    expect(body).toMatch(/(^|;)padding:0(;|$)/);
    expect(body).toMatch(/(^|;)border:0(;|$)/);
    expect(body).toMatch(/(^|;)margin:0(;|$)/);
    expect(body).toMatch(/font:inherit/);
    // 意匠側も、桁を動かす指定（padding/border/margin/width）を足していないこと。
    // **入力項目のデザインも同じ制約**（どちらも画面グリッド上に描かれるため）。
    const rules = [
      ...(css.match(/\.pane\[data-buttons=[a-zA-Z]+\][^{]*\.fkey-btn[^{]*\{[^}]*\}/g) ?? []),
      ...(css.match(/\.pane\[data-controls=[a-zA-Z]+\][^{]*\.grid-input[^{]*\{[^}]*\}/g) ?? []),
    ];
    expect(rules.length, "意匠の CSS 規則が見つからない").toBeGreaterThan(8);
    for (const rule of rules) {
      expect(rule, `桁を動かす指定を含む: ${rule}`).not.toMatch(/[;{](padding|margin|width|border-width):/);
    }
  });
});

describe("Tab の移動先にボタンも入る（ユーザー要求）", () => {
  // 入力欄の外（保護セル）にカーソルがあるときの Tab は、**カーソル位置から見て次**の
  // 停止点へ移す。有効化したボタンもその候補に入らないと、画面にあるのに辿り着けない。
  it("カーソル位置から見て次のボタンへ移動する（入力欄より手前でも）", async () => {
    // 1 行目に凡例、20 行目に入力欄。カーソルは 1 行目の先頭（凡例より前）。
    const field: Field = { index: 1, row: 20, col: 2, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
    const snap = snapOf([LEGEND, ...Array(18).fill(""), "  cmd"], [field]);
    snap.cursor = { row: 1, col: 1 };
    seed(snap);
    viewSettings.set("buttons", "box");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    // free モードにする（保護セルへカーソルを置く）
    (w.find(".pane").element as HTMLElement).focus();
    await w.find(".pane").trigger("keydown", { key: "Tab" });
    await nextTick();

    const btns = w.findAll("button.fkey-btn");
    expect(btns.length).toBe(2);
    // 入力欄(20 行目)ではなく、カーソル(1,1)の次にある 1 行目のボタンへ入る
    expect(document.activeElement).toBe(btns[0]!.element);
    w.unmount();
  });

  it("ボタンには画面位置が付いている（移動先の計算に使う）", async () => {
    const w = mount(ScreenGrid, { props: { snapshot: snapOf([LEGEND]), edits: new Map(), focused: false, buttons: "box" } });
    await nextTick();
    const btn = w.find("button.fkey-btn");
    expect(btn.attributes("data-row")).toBe("1");
    expect(Number(btn.attributes("data-col"))).toBeGreaterThan(0);
    w.unmount();
  });
});
