import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import type { PublicSession, PublicSystem } from "@as400web/server";
import type { Cell, ScreenSnapshot } from "@as400web/core";
import ConfigCard from "../src/components/ConfigCard.vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import WatermarkOverlay from "../src/components/WatermarkOverlay.vue";
import {
  expandWatermarkText,
  resolveWatermark,
  WATERMARK_DEFAULTS
} from "../src/composables/watermark.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { systemsStore } from "../src/stores/systems.js";
import { initViewSettings } from "../src/stores/viewSettings.js";
import type { WsClient } from "../src/ws-client.js";

/**
 * ウォーターマーク（画面に重ねる透かし）。
 *
 * 見るところは 3 つ: **設定の畳み方**（セッション設定 → 実効値）、
 * **重ねるだけで壊さないこと**（桁・操作・コピー）、**設定画面からの往復**。
 */

const SID = "wm1";

function cell(ch: string): Cell {
  return {
    char: ch,
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}
function snapOf(lines: string[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row = [...(lines[r] ?? "")].map(cell);
    while (row.length < 80) row.push(cell(" "));
    cells.push(row.slice(0, 80));
  }
  return {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: []
  } as ScreenSnapshot;
}

const SYSTEM: PublicSystem = { ref: "own:s-1", name: "本番機", host: "pub400.com", autoSignon: false };
const sessionCfg = (watermark?: PublicSession["watermark"]): PublicSession => ({
  ref: "own:d1",
  name: "端末A",
  system: "own:s-1",
  sessionType: "display",
  ...(watermark ? { watermark } : {})
});

/** 透かし付きのセッションを 1 本開いた状態を作る */
function openPane(watermark?: PublicSession["watermark"], job?: { name: string; user?: string }): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [sessionCfg(watermark)];
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID,
    label: "端末A",
    configRef: "own:d1",
    systemRef: "own:s-1",
    meta: { host: "pub400.com", port: 992, deviceName: "WEBEMU01" },
    ...(job ? { job } : {}),
    snapshot: snapOf([" MAIN メニュー"]),
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    connected: true,
    readOnly: false,
    client: { send() {} } as unknown as WsClient
  });
}

beforeEach(() => {
  localStorage.clear();
  initViewSettings();
  systemsStore.systems = [];
  systemsStore.sessions = [];
});

describe("差し込み変数の展開", () => {
  it("既知の変数は値に置き換わる", () => {
    expect(expandWatermarkText("{system} / {user}", { system: "本番機", user: "USER" })).toBe(
      "本番機 / USER"
    );
  });

  it("**既知だが値が無い**変数は消える（サインオン前の {user} 等）", () => {
    expect(expandWatermarkText("本番 {user}", {}).trim()).toBe("本番");
  });

  it("未知の変数はそのまま残す（打ち間違いに気づけるように）", () => {
    expect(expandWatermarkText("{hosts}", { host: "h" })).toBe("{hosts}");
  });
});

describe("実効値の組み立て", () => {
  it("省略した項目は既定で埋まる", () => {
    const v = resolveWatermark({ text: "本番" })!;
    expect(v).toEqual({ text: "本番", ...WATERMARK_DEFAULTS });
  });

  it("設定なし・enabled:false・展開後が空 のいずれも表示しない", () => {
    expect(resolveWatermark(undefined)).toBeUndefined();
    expect(resolveWatermark({ text: "本番", enabled: false })).toBeUndefined();
    expect(resolveWatermark({ text: "{user}" }, {})).toBeUndefined();
  });

  it("色は指定したときだけ載る（既定は端末の前景色に追従させる）", () => {
    expect(resolveWatermark({ text: "x" })!.color).toBeUndefined();
    expect(resolveWatermark({ text: "x", color: "#112233" })!.color).toBe("#112233");
  });
});

describe("重ねる要素（WatermarkOverlay）", () => {
  it("文字を敷き、角度と濃さをスタイルに反映する", async () => {
    const w = mount(WatermarkOverlay, {
      props: { watermark: { text: "本番", opacity: 0.3, size: 20, layout: "tile", angle: -30 } }
    });
    await nextTick();
    expect(w.findAll(".wm-line").length).toBeGreaterThan(0);
    expect(w.find(".wm-line").text()).toContain("本番");
    const style = w.find(".wm-field").attributes("style")!;
    expect(style).toContain("rotate(-30deg)");
    expect(style).toContain("opacity: 0.3");
    w.unmount();
  });

  it("中央 1 つのときは 1 行だけ・区切りを付けない", async () => {
    const w = mount(WatermarkOverlay, {
      props: { watermark: { text: "検証", opacity: 0.2, size: 20, layout: "center", angle: 0 } }
    });
    await nextTick();
    expect(w.findAll(".wm-line")).toHaveLength(1);
    expect(w.find(".wm-line").text()).toBe("検証");
    w.unmount();
  });

  it("色は指定があればそれ、無ければ端末の前景色トークン", async () => {
    const base = { text: "x", opacity: 0.2, size: 20, layout: "tile" as const, angle: 0 };
    const auto = mount(WatermarkOverlay, { props: { watermark: base } });
    expect(auto.find(".wm").attributes("style")).toContain("var(--t-white)");
    auto.unmount();
    const fixed = mount(WatermarkOverlay, { props: { watermark: { ...base, color: "#ff0000" } } });
    // ブラウザ（jsdom）は色を正規化して持つので rgb() で確かめる
    expect(fixed.find(".wm").attributes("style")).toContain("rgb(255, 0, 0)");
    fixed.unmount();
  });
});

describe("エミュレーター画面への適用", () => {
  it("セッション設定に透かしがあれば重ねる（変数は接続の実値で展開）", async () => {
    openPane({ text: "{system} {device} {user}" }, { name: "WEBEMU01", user: "USER" });
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    expect(w.find(".wm-line").text()).toContain("本番機 WEBEMU01 USER");
    w.unmount();
  });

  it("設定が無ければ何も重ねない", async () => {
    openPane(undefined);
    const w = mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
    await nextTick();
    expect(w.findAll(".wm")).toHaveLength(0);
    w.unmount();
  });

  it("桁と文字に触れない（透かしの有無で行のテキストが変わらない）", async () => {
    const rows = (w: ReturnType<typeof mount>): string =>
      w.findAll(".grid-row").map((r) => r.text()).join("\n");
    openPane(undefined);
    const off = mount(EmulatorPane, { props: { sessionId: SID, focused: false }, attachTo: document.body });
    await nextTick();
    const before = rows(off);
    off.unmount();

    openPane({ text: "本番" });
    const on = mount(EmulatorPane, { props: { sessionId: SID, focused: false }, attachTo: document.body });
    await nextTick();
    expect(rows(on)).toBe(before);
    on.unmount();
  });
});

describe("セッション設定画面からの往復", () => {
  const calls: { url: string; method: string; body: string }[] = [];
  function stubFetch(): void {
    calls.length = 0;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (String(url) === "/api/systems") {
        return Promise.resolve(
          new Response(JSON.stringify({ systems: [SYSTEM], editable: true }), { status: 200 })
        );
      }
      if (String(url) === "/api/sessions-config") {
        return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ session: sessionCfg() }), { status: 200 }));
    });
  }
  /** 保存で PUT した本文（セッション設定） */
  const savedBody = (): Record<string, unknown> =>
    JSON.parse(calls.find((c) => c.method === "PUT")!.body) as Record<string, unknown>;

  async function openEdit(session: PublicSession) {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session } });
    await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
    await flushPromises();
    return w;
  }
  const save = async (w: Awaited<ReturnType<typeof openEdit>>): Promise<void> => {
    await w.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    await flushPromises();
  };

  beforeEach(() => {
    systemsStore.systems = [SYSTEM];
    systemsStore.editable = true;
    stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("5250 表示にだけ欄を出す（プリンターには出さない）", async () => {
    const disp = await openEdit(sessionCfg());
    expect(disp.text()).toContain("ウォーターマーク");
    disp.unmount();
    const prt = await openEdit({ ...sessionCfg(), ref: "own:p1", sessionType: "printer" });
    expect(prt.text()).not.toContain("ウォーターマーク");
    prt.unmount();
  });

  it("システムの編集フォームには出さない（セッション設定の項目なので）", async () => {
    const w = mount(ConfigCard, { props: { kind: "system" as const, system: SYSTEM } });
    await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
    await flushPromises();
    expect(w.text()).not.toContain("ウォーターマーク");
    w.unmount();
  });

  it("保存済みの値をフォームに開き、編集していなくても送り返す（省略＝削除のため）", async () => {
    const w = await openEdit(sessionCfg({ text: "本番 {system}", opacity: 0.25, size: 30, angle: 0 }));
    await save(w);
    expect(savedBody().watermark).toEqual({
      text: "本番 {system}",
      opacity: 0.25,
      size: 30,
      layout: WATERMARK_DEFAULTS.layout,
      angle: 0
    });
    w.unmount();
  });

  it("文字を空にすると設定ごと消える", async () => {
    const w = await openEdit(sessionCfg({ text: "本番" }));
    await w.findAll("input").find((i) => (i.element as HTMLInputElement).value === "本番")!.setValue("  ");
    await save(w);
    expect(savedBody()).not.toHaveProperty("watermark");
    w.unmount();
  });

  it("表示を切っても文字は残る（enabled:false として保存）", async () => {
    const w = await openEdit(sessionCfg({ text: "本番" }));
    await w.find('input[type="checkbox"]').setValue(false);
    await save(w);
    expect(savedBody().watermark).toMatchObject({ text: "本番", enabled: false });
    w.unmount();
  });

  it("範囲外の数値は保存時に丸める（サーバーで 400 にせず、入力どおりの意図に寄せる）", async () => {
    const w = await openEdit(sessionCfg({ text: "本番" }));
    const num = w.findAll('input[type="number"]');
    await num[0]!.setValue(500); // 濃さ %
    await num[2]!.setValue(-200); // 角度
    await save(w);
    expect(savedBody().watermark).toMatchObject({ opacity: 1, angle: -90 });
    w.unmount();
  });
});
