/**
 * `EmulatorPane`のウォーターマーク（画面に重ねる透かし）が、`configRef`を持たない
 * 直接接続セッション（VSCode拡張の`.ts5250`等）では`state.meta.watermark`から
 * 描かれること（`20260924-vscode-extension` D16）。
 *
 * 保存済みセッション設定経由（`configRef`あり）の既存経路は`watermark.test.ts`
 * （純関数）と`ConfigCard.vue`側で別途カバー済み——ここは**フォールバック**だけを見る。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import WatermarkOverlay from "../src/components/WatermarkOverlay.vue";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import { systemsStore } from "../src/stores/systems.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";

const SID = "s1";

function cell(): Cell {
  return {
    char: " ",
    kind: "sbcs",
    color: "green",
    reverse: false,
    underline: false,
    blink: false,
    columnSeparator: false,
    nonDisplay: false
  };
}

function field(): Field {
  return {
    index: 0,
    row: 2,
    col: 2,
    length: 5,
    protected: false,
    numeric: false,
    hidden: false,
    intensified: false,
    mdt: false,
    value: "     "
  } as Field;
}

function snap(): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell());
    cells.push(row);
  }
  return {
    sessionId: SID,
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells,
    fields: [field()]
  } as ScreenSnapshot;
}

function seed(extra: Partial<SessionState> = {}): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  systemsStore.sessions = [];
  sessionsStore.add({
    sessionId: SID,
    label: "t",
    snapshot: snap(),
    edits: new Map(),
    cursor: { row: 1, col: 1 },
    link: { state: "connected" },
    resumability: "resumable",
    readOnly: false,
    client: { send: () => {}, setHiddenIndexes: () => {} } as unknown as WsClient,
    ...extra
  });
}

function mountPane(): ReturnType<typeof mount> {
  return mount(EmulatorPane, { props: { sessionId: SID, focused: true }, attachTo: document.body });
}

describe("EmulatorPaneのウォーターマーク（direct-connectのmetaフォールバック）", () => {
  beforeEach(() => seed());

  it("meta.watermarkが無ければ出さない", async () => {
    const w = mountPane();
    await nextTick();
    expect(w.findComponent(WatermarkOverlay).exists()).toBe(false);
    w.unmount();
  });

  it("configRefを持たないセッションでも、meta.watermarkがあれば出す", async () => {
    seed({ meta: { watermark: { text: "検証機 {host}" } } });
    const w = mountPane();
    await nextTick();
    const overlay = w.findComponent(WatermarkOverlay);
    expect(overlay.exists()).toBe(true);
    expect(overlay.props("watermark").text).toContain("検証機");
    w.unmount();
  });

  it("meta.watermarkのenabled:falseは出さない（文字を残したまま切れる）", async () => {
    seed({ meta: { watermark: { text: "検証機", enabled: false } } });
    const w = mountPane();
    await nextTick();
    expect(w.findComponent(WatermarkOverlay).exists()).toBe(false);
    w.unmount();
  });

  it("configRef経由のセッション設定があれば、そちらを優先する（metaより上位）", async () => {
    seed({ configRef: "own:ses-1", meta: { watermark: { text: "meta由来（出ないはず）" } } });
    // `seed()`が`systemsStore.sessions`をリセットするため、設定はseedの後に足す
    systemsStore.sessions = [
      { ref: "own:ses-1", name: "s", system: "own:sys-1", sessionType: "display", watermark: { text: "本番" } } as never
    ];
    const w = mountPane();
    await nextTick();
    const overlay = w.findComponent(WatermarkOverlay);
    expect(overlay.exists()).toBe(true);
    expect(overlay.props("watermark").text).toBe("本番");
    w.unmount();
  });
});
