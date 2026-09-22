import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import EmulatorPane from "../src/components/EmulatorPane.vue";
import { sessionsStore } from "../src/stores/sessions.js";
import type { ScreenSnapshot, Cell, Field } from "@ts5250/tn5250";
import type { WsClient } from "../src/ws-client.js";
import { isOperatorError } from "../src/composables/opMessages.js";

/**
 * **930 の `katakanaVariant` が、実際の打鍵の挙動（大文字化・8 記号の拒否）を切り替えるか**
 * （`20260922-katakana-variant-setting`・`20260922-katakana-selector-merge`）。`EmulatorPane` の
 * `uppercaseInput`/`katakanaRestricted` computed（`state.ccsid`/`state.katakanaVariant` から導く）を、
 * 実際に文字を打って確かめる。単体の式は `field-validate.test.ts`（`katakanaRestricted`）・
 * `device-env.test.ts`（CHARSET）で固定済みなので、ここは**配線**（セッション状態 → EmulatorPane →
 * ScreenGrid）だけを見る。5026 は対象外（ACS がこの CCSID の存在を知らないため。`hostCodePages.ts`）。
 */
const COLS = 80;
const cell = (char = " ", kind: Cell["kind"] = "sbcs"): Cell =>
  ({ char, kind, color: "green", reverse: false, underline: false, blink: false, columnSeparator: false, nonDisplay: false }) as Cell;

function snapOf(): ScreenSnapshot {
  const cells: Cell[][] = Array.from({ length: 24 }, () => Array.from({ length: COLS }, () => cell()));
  const field: Field = { index: 1, row: 5, col: 20, length: 10, protected: false, hidden: false, numeric: false, mdt: false, value: "" };
  return { sessionId: "w1", rows: 24, cols: COLS, cursor: { row: 5, col: 20 }, keyboardLocked: false, cells, fields: [field] } as unknown as ScreenSnapshot;
}

let send: Mock<(m: unknown) => void>;
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  document.body.innerHTML = "";
});

function seed(ccsid: number, katakanaVariant?: "katakana" | "katakana-ex"): void {
  send = vi.fn<(m: unknown) => void>();
  const snapshot = snapOf();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: "w1", label: "t", snapshot, edits: new Map(), cursor: snapshot.cursor,
    link: { state: "connected" }, resumability: "resumable", readOnly: false,
    ccsid, ...(katakanaVariant !== undefined ? { katakanaVariant } : {}),
    client: { send } as unknown as WsClient
  });
}

async function pane(): Promise<{ w: ReturnType<typeof mount>; input: HTMLInputElement }> {
  const w = mount(EmulatorPane, { props: { sessionId: "w1", focused: true }, attachTo: document.body });
  mounted.push(w);
  await nextTick();
  const input = w.find("input.grid-input[data-slice='0']").element as HTMLInputElement;
  input.focus();
  input.setSelectionRange(0, 0);
  await nextTick();
  return { w, input };
}

async function type(input: HTMLInputElement, key: string): Promise<void> {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await nextTick();
  await nextTick();
}

const value = () => sessionsStore.byId.get("w1")!.edits.get(1);
const opmsgText = (w: ReturnType<typeof mount>) => (w.find(".opmsg").exists() ? w.find(".opmsg").text().replace(/\s/g, "") : "");

describe("930 katakanaVariant の配線", () => {
  it("**未指定は \"katakana-ex\" と同じ**: 小文字はそのまま、8 記号も入る（20260922-katakana-selector-merge D2）", async () => {
    seed(930, undefined);
    const { input } = await pane();
    await type(input, "a");
    expect(value()).toBe("a");
    await type(input, "[");
    expect(value()).toBe("a[");
  });

  it('**"katakana-ex"**: 小文字はそのまま、8 記号も入る', async () => {
    seed(930, "katakana-ex");
    const { input } = await pane();
    await type(input, "a");
    expect(value()).toBe("a");
    await type(input, "[");
    expect(value()).toBe("a[");
  });

  it('**"katakana"**: 小文字は大文字化される', async () => {
    seed(930, "katakana");
    const { input } = await pane();
    await type(input, "a");
    expect(value()).toBe("A");
  });

  it('**"katakana"**: 8 記号は拒否され、操作員エラー状態（施錠）に入る', async () => {
    seed(930, "katakana");
    const { w, input } = await pane();
    await type(input, "[");
    expect(value(), "値は変わらない").toBeUndefined();
    const msg = opmsgText(w);
    expect(msg).not.toBe("");
    expect(isOperatorError(msg), "操作員エラー状態のメッセージ").toBe(true);
  });

  it("930 以外の CCSID では katakanaVariant を渡していても無視する（大文字化しない・8 記号も入る）", async () => {
    seed(37, "katakana");
    const { input } = await pane();
    await type(input, "a");
    expect(value()).toBe("a");
    await type(input, "[");
    expect(value()).toBe("a[");
  });

  it("**5026 は対象外**: katakanaVariant を渡していても無視する（ACS はこの CCSID を知らない）", async () => {
    seed(5026, "katakana");
    const { input } = await pane();
    await type(input, "a");
    expect(value()).toBe("a");
    await type(input, "[");
    expect(value()).toBe("a[");
  });
});
