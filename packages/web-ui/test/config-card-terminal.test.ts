import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ConfigCard from "../src/components/ConfigCard.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * **「種類」と「端末の種類」は軸が違う。**
 *
 * `sessionType` はセッションが何をするか（画面／プリンター／監視）、
 * `terminal` はどの端末か（5250 / 3270）。`config-types.ts` が
 * 「軸が直交する」と書いているとおりで、持ち方は正しい。
 *
 * 壊れていたのは**見せ方**だった——`display` を一律「5250 表示」「5250 端末」と
 * 呼んでいたので、**5250 表示を選んだうえで 3270 を選ぶ**という画面になっていた。
 */
const base = {
  ref: "own:s1",
  id: "s1",
  name: "DEV13270",
  system: "own:sys",
  sessionType: "display" as const,
  deviceName: "DEV1"
};

afterEach(() => {
  systemsStore.editable = false;
});

const card = (over: Record<string, unknown> = {}) =>
  mount(ConfigCard, { props: { kind: "session", session: { ...base, ...over } } as never });

describe("一覧の札", () => {
  it("**3270 のセッションは「3270 端末」と出る**（一覧で見分けられる）", () => {
    expect(card({ terminal: "3270" }).text()).toContain("3270 端末");
  });

  it("5250 は従来どおり", () => {
    expect(card().text()).toContain("5250 端末");
    expect(card({ terminal: "5250" }).text()).toContain("5250 端末");
  });

  it("プリンターや監視は端末の種類に関係しない", () => {
    expect(card({ sessionType: "printer" }).text()).toContain("プリンター");
    expect(card({ sessionType: "msgwatch" }).text()).toContain("メッセージ待ち受け");
  });

  it("**3270 はモデルを出す**（`screenSize` を持たないので、そのままだと空欄）", () => {
    expect(card({ terminal: "3270", model3270: 5 }).text()).toContain("モデル 5");
    expect(card({ terminal: "3270" }).text()).toContain("モデル 2");
  });

  it("5250 は画面サイズを出す", () => {
    expect(card({ screenSize: "27x132" }).text()).toContain("27x132");
  });
});

describe("編集画面", () => {
  const openEdit = async (over: Record<string, unknown> = {}) => {
    systemsStore.editable = true;
    const w = card(over);
    await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
    return w;
  };

  it("**「種類」に 5250 と書かない**（5250 表示なのに 3270、を作らない）", async () => {
    const w = await openEdit();
    const kind = w.findAll("select")[1]!; // システム / 種類 / …
    expect(kind.text()).toContain("表示（画面）");
    expect(kind.text()).not.toContain("5250 表示");
    w.unmount();
  });

  it("**端末の種類は「種類」のすぐ隣**（決めるものと決まるものを離さない）", async () => {
    const w = await openEdit();
    const caps = w.findAll(".cap").map((e) => e.text());
    const kind = caps.indexOf("種類");
    expect(caps[kind + 1]).toBe("端末の種類");
    w.unmount();
  });

  it("表示以外では端末の種類を出さない", async () => {
    const w = await openEdit({ sessionType: "printer" });
    expect(w.findAll(".cap").map((e) => e.text())).not.toContain("端末の種類");
    w.unmount();
  });
});

describe("ⓘ の詳細", () => {
  /** 札（一覧）と詳細（ⓘ）で別々に書いていたので、**詳細だけ 5250 のまま**だった */
  const info = async (over: Record<string, unknown> = {}): Promise<string> => {
    const w = card(over);
    await w.find("button.info").trigger("click");
    return w.text();
  };

  it("**3270 のセッションは詳細でも「3270 端末」**", async () => {
    expect(await info({ terminal: "3270" })).toContain("3270 端末");
  });

  it("5250 は従来どおり", async () => {
    expect(await info()).toContain("5250 端末");
  });

  it("プリンターや監視は端末の種類に関係しない", async () => {
    expect(await info({ sessionType: "printer" })).toContain("プリンター");
    expect(await info({ sessionType: "dtaqwatch" })).toContain("待ち行列監視");
  });
});
