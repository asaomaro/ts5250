import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import KeybindingsPanel from "../src/components/KeybindingsPanel.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import { keybindingsStore } from "../src/stores/keybindings.js";
import { viewSettings, initViewSettings, VIEW_ITEMS } from "../src/stores/viewSettings.js";
import type { ScreenSnapshot, Cell, Field } from "@as400web/tn5250";
import type { WsClient } from "../src/ws-client.js";

const SID = "vc1";

function cells(): Cell[][] {
  const out: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) {
      row.push({ char: " ", kind: "sbcs", color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false });
    }
    out.push(row);
  }
  return out;
}
function field(): Field {
  return { index: 1, row: 20, col: 8, length: 60, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
}
function snap(): ScreenSnapshot {
  return { sessionId: SID, rows: 24, cols: 80, cursor: { row: 20, col: 8 }, keyboardLocked: false, cells: cells(), fields: [field()] };
}
function seed(): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "t", snapshot: snap(), edits: new Map(), cursor: { row: 20, col: 8 },
    connected: true, readOnly: false, client: { send() {} } as unknown as WsClient,
  });
}

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
  keybindingsStore.reset();
  seed();
});

describe("キー設定パネル（表示設定の割当）", () => {
  it("割当先に表示設定が並び、font は含まれない", () => {
    const w = mount(KeybindingsPanel);
    const opts = w.findAll("optgroup[label*='表示設定'] option");
    expect(opts).toHaveLength(VIEW_ITEMS.length);
    const values = opts.map((o) => o.attributes("value"));
    expect(values).toContain("view:surface");
    expect(values).toContain("view:sosi");
    expect(values.some((v) => v === "view:font")).toBe(false);
    w.unmount();
  });

  it("割り当て済みの表示設定は項目名と現在値で表示する（生の view:xxx を出さない）", () => {
    keybindingsStore.set("ctrl+1", "view:surface");
    const w = mount(KeybindingsPanel);
    const text = w.text();
    expect(text).toContain("画面の質感");
    expect(text).toContain("フラット"); // 現在値
    expect(text).not.toContain("view:surface");
    w.unmount();
  });
});

describe("キー押下で表示設定が順送りされ、通知が出る", () => {
  it("割り当てたキーで設定が変わり、OIA に通知が表示される", async () => {
    keybindingsStore.set("ctrl+1", "view:surface");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    expect(viewSettings.settings.surface).toBe("flat");
    expect(w.find(".pane").attributes("data-surface")).toBe("flat");

    await w.find(".pane").trigger("keydown", { key: "1", ctrlKey: true });
    await nextTick();

    // 設定が順送りされ、画面(ペイン)にも反映される
    expect(viewSettings.settings.surface).toBe("crt");
    expect(w.find(".pane").attributes("data-surface")).toBe("crt");
    // 通知（OIA の操作員メッセージ枠）に「項目: 新しい値」が出る
    expect(w.find(".oia .notice").text()).toBe("画面の質感: CRT");

    // もう一度押すと次の値（一巡）へ、通知も更新される
    await w.find(".pane").trigger("keydown", { key: "1", ctrlKey: true });
    await nextTick();
    expect(viewSettings.settings.surface).toBe("flat");
    expect(w.find(".oia .notice").text()).toBe("画面の質感: フラット");
    w.unmount();
  });

  it("3 値以上（入力項目設定）も順送りできる", async () => {
    keybindingsStore.set("ctrl+2", "view:controls");
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    await w.find(".pane").trigger("keydown", { key: "2", ctrlKey: true });
    await nextTick();
    expect(viewSettings.settings.controls).toBe("underline");
    expect(w.find(".oia .notice").text()).toBe("入力項目設定: 下線");
    w.unmount();
  });
});

describe("CRT の滲みは画面の文字すべてに掛かる", () => {
  // scoped CSS は vitest の DOM に適用されないため、**ビルド後の CSS** を直接検査する。
  // 「.grid-span にしか掛けず入力欄が滲まない」取りこぼしの再発防止。
  it("CRT ルールが素のラン・入力欄・GUI 選択肢を対象にしている", () => {
    // vitest の cwd は packages/web-ui。import.meta.url は file: とは限らないのでパスで解決する。
    const dir = join(process.cwd(), "dist/assets");
    if (!existsSync(dir)) return; // 未ビルド時はスキップ
    const css = readdirSync(dir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    if (!css) return;
    const rule = /\.pane\[data-surface=crt\][^{]*\{[^}]*text-shadow[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain(".grid-span");
    expect(rule).toContain(".grid-input"); // 入力欄にも掛かること
    expect(rule).toContain(".gui-choice-text");
  });
});

describe("既定バインドが実際のキー操作で効く", () => {
  it("Ctrl+F1 でカナ英、Ctrl+F3 で SO/SI が切り替わり通知が出る", async () => {
    localStorage.clear();
    keybindingsStore.reload(); // 初回起動相当（既定バインドが入る）
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();

    // 表示コードは 3 値（自動→カナ→英→自動）。既定はホストの表のまま＝自動
    expect(viewSettings.settings.kana).toBe("auto");
    await w.find(".pane").trigger("keydown", { key: "F1", ctrlKey: true });
    await nextTick();
    expect(viewSettings.settings.kana).toBe("kana");
    expect(w.find(".oia .notice").text()).toBe("表示コード: カナ");
    await w.find(".pane").trigger("keydown", { key: "F1", ctrlKey: true });
    await nextTick();
    expect(viewSettings.settings.kana).toBe("latin");
    expect(w.find(".oia .notice").text()).toBe("表示コード: 英");

    expect(viewSettings.settings.sosi).toBe(false); // 初期値=非表示
    await w.find(".pane").trigger("keydown", { key: "F3", ctrlKey: true });
    await nextTick();
    expect(viewSettings.settings.sosi).toBe(true);
    expect(w.find(".oia .notice").text()).toBe("SO/SI 表示: 表示");

    // もう一度押すと戻る（トグルとして使える）
    await w.find(".pane").trigger("keydown", { key: "F3", ctrlKey: true });
    await nextTick();
    expect(viewSettings.settings.sosi).toBe(false);
    w.unmount();
  });

  it("Ctrl+F3 はホストへ AID を送らない（F3=終了が誤発火しない）", async () => {
    localStorage.clear();
    keybindingsStore.reload();
    const sent: unknown[] = [];
    // 在席の合図（`activity`）は打鍵のたびに WS へ流れるが**ホストへは行かない**ので除く
    // （`20260729-session-lifetime-timeout`）
    sessionsStore.byId.get(SID)!.client = {
      send: (m: unknown) => {
        if ((m as { type?: string }).type !== "activity") sent.push(m);
      }
    } as unknown as WsClient;
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    await w.find(".pane").trigger("keydown", { key: "F3", ctrlKey: true });
    await nextTick();
    expect(sent).toHaveLength(0);
    w.unmount();
  });
});
