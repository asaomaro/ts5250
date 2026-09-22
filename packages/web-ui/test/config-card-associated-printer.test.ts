/**
 * **関連付けプリンター**の UI 往復（`20260921-associated-printer`）。
 *
 * 5250 の表示セッションだけが持つ（ホストへ IBMASSOCPRT として申告する。サーバーは他の種別に書くと 400）。
 * 送るかどうかは ACS と同じく Java の `trim()` で空かを見て、値は打ったまま送る（ACS は空白も大文字小文字も加工しない）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import type { PublicSession, PublicSystem } from "@ts5250/server";
import ConfigCard from "../src/components/ConfigCard.vue";
import { authStore } from "../src/stores/auth.js";
import { systemsStore } from "../src/stores/systems.js";

const OWN_SYSTEM: PublicSystem = { ref: "own:s-1", name: "自分の環境", host: "h", autoSignon: false };
const calls: { url: string; method: string; body: string }[] = [];

beforeEach(() => {
  systemsStore.systems = [OWN_SYSTEM];
  systemsStore.sessions = [];
  systemsStore.editable = true;
  systemsStore.loaded = true;
  authStore.enabled = false;
  authStore.user = undefined;
  calls.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url === "/api/systems") return Promise.resolve(new Response(JSON.stringify({ systems: [OWN_SYSTEM], editable: true })));
    if (url === "/api/sessions-config") return Promise.resolve(new Response(JSON.stringify({ sessions: [] })));
    return Promise.resolve(new Response("{}"));
  });
});
afterEach(() => vi.unstubAllGlobals());

const session = (over: Partial<PublicSession> = {}): PublicSession => ({
  ref: "own:c-1",
  name: "s",
  system: OWN_SYSTEM.ref,
  sessionType: "display",
  ...over
});

async function openEdit(current: PublicSession): Promise<VueWrapper> {
  const w = mount(ConfigCard, { props: { kind: "session" as const, session: current } });
  await w.findAll("button").find((b) => b.text() === "編集")!.trigger("click");
  await flushPromises();
  return w;
}
const assocInput = (w: VueWrapper) => w.findAll("label.row").find((l) => l.text().includes("関連付けプリンター"))?.find("input");

async function save(w: VueWrapper): Promise<Record<string, unknown>> {
  await w.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
  await flushPromises();
  const put = calls.find((c) => c.url.startsWith("/api/sessions-config/") && c.method === "PUT");
  expect(put).toBeDefined();
  w.unmount();
  return JSON.parse(put!.body) as Record<string, unknown>;
}

describe("関連付けプリンター", () => {
  it("既存の値が欄に開き、編集しなくても保存で消えない", async () => {
    const w = await openEdit(session({ associatedPrinter: "PRT01" }));
    expect((assocInput(w)!.element as HTMLInputElement).value).toBe("PRT01");
    expect((await save(w)).associatedPrinter).toBe("PRT01");
  });

  it("**打ったまま送る**（空白も小文字も加工しない。ACS と同じ）", async () => {
    const w = await openEdit(session());
    await assocInput(w)!.setValue(" prt01");
    expect((await save(w)).associatedPrinter).toBe(" prt01");
  });

  it("空・空白だけなら送らない（キーごと消す）", async () => {
    for (const v of ["", "   "]) {
      const w = await openEdit(session({ associatedPrinter: "PRT01" }));
      await assocInput(w)!.setValue(v);
      expect(await save(w), JSON.stringify(v)).not.toHaveProperty("associatedPrinter");
      calls.length = 0;
    }
  });

  it("詳細（ⓘ）に出す。書いていなければ行を出さない", async () => {
    const info = async (over: Partial<PublicSession>): Promise<string> => {
      const w = mount(ConfigCard, { props: { kind: "session" as const, session: session(over) } });
      await w.find("button.info").trigger("click");
      await flushPromises();
      const text = w.text();
      w.unmount();
      return text;
    };
    expect(await info({ associatedPrinter: "PRT01" })).toContain("関連付けプリンターPRT01");
    expect(await info({})).not.toContain("関連付けプリンター");
  });

  it("**5250 の表示だけに欄を出す**（プリンター・3270 には出さない）", async () => {
    for (const over of [{ sessionType: "printer" as const }, { terminal: "3270" as const }]) {
      const w = await openEdit(session(over));
      expect(assocInput(w), JSON.stringify(over)).toBeUndefined();
      w.unmount();
    }
  });

  it("**3270 に切り替えたら送らない**（サーバーは 400 にする）", async () => {
    const w = await openEdit(session({ associatedPrinter: "PRT01" }));
    await w.findAll("select").find((s) => s.text().includes("3270"))!.setValue("3270");
    expect(await save(w)).not.toHaveProperty("associatedPrinter");
  });
});

/**
 * **関連付けるプリンターセッション**（`20260921-associated-printer-session`）。ACS のもう 1 つの方式——同じ保存先のプリンターの設定を指し、
 * 装置名の方式とは排他。待ち時間・一緒に閉じるは、プリンターセッションを選んだときだけ出て送る（既定は送らない）
 */
describe("関連付けるプリンターセッション", () => {
  const PRT = { ref: "own:p-1", name: "私のプリンター", system: OWN_SYSTEM.ref, sessionType: "printer" } as PublicSession;
  const OTHER_SRV = { ref: "srv:p-9", name: "共有プリンター", system: "srv:sys", sessionType: "printer" } as PublicSession;
  beforeEach(() => {
    systemsStore.sessions = [PRT, OTHER_SRV];
  });
  const sessionSelect = (w: VueWrapper) => w.findAll("label.row").find((l) => l.text().includes("関連付けるプリンターセッション"))?.find("select");

  it("**同じ保存先のプリンターだけを選択肢に出す**（自分の設定に共有のプリンターは出さない）", async () => {
    const w = await openEdit(session());
    const opts = sessionSelect(w)!.findAll("option").map((o) => o.text());
    expect(opts).toContain("私のプリンター");
    expect(opts).not.toContain("共有プリンター");
    w.unmount();
  });

  it("選ぶと保存の body に参照が入り、**装置名は送らない**（方式は 1 つ）。待ち時間・一緒に閉じるは既定なら送らない", async () => {
    const w = await openEdit(session({ associatedPrinter: "OLDPRT" } as Partial<PublicSession>));
    await assocInput(w)!.setValue(""); // 装置名を書いている間は選べない（排他）ので、先に消す
    await sessionSelect(w)!.setValue("own:p-1");
    const body = await save(w);
    expect(body.associatedPrinterSession).toBe("own:p-1");
    expect(body).not.toHaveProperty("associatedPrinter");
    expect(body).not.toHaveProperty("associatedPrinterTimeout");
    expect(body).not.toHaveProperty("closeAssociatedPrinterWithLastSession");
  });

  it("待ち時間（既定以外）と一緒に閉じるを送る。0 は「待ち続ける」で送る", async () => {
    const w = await openEdit(session({ associatedPrinterSession: "own:p-1", associatedPrinterTimeout: 0, closeAssociatedPrinterWithLastSession: true } as Partial<PublicSession>));
    const body = await save(w);
    expect(body).toMatchObject({ associatedPrinterSession: "own:p-1", associatedPrinterTimeout: 0, closeAssociatedPrinterWithLastSession: true });
  });

  it("**待ち時間の欄を空・数字でない・負にして保存すると、既定（5 秒）に直す**（ACS と同じ。空欄が「待ち続ける（0）」に化けない）。0 は明示したときだけ", async () => {
    for (const v of ["", "abc", "-3"]) {
      const w = await openEdit(session({ associatedPrinterSession: "own:p-1", associatedPrinterTimeout: 30 } as Partial<PublicSession>));
      const timeout = w.findAll("label.row").find((l) => l.text().includes("待ち時間"))!.find("input");
      await timeout.setValue(v);
      const body = await save(w);
      expect(body, JSON.stringify(v)).not.toHaveProperty("associatedPrinterTimeout"); // 既定（5）は送らない
      calls.length = 0;
    }
    const w0 = await openEdit(session({ associatedPrinterSession: "own:p-1" } as Partial<PublicSession>));
    await w0.findAll("label.row").find((l) => l.text().includes("待ち時間"))!.find("input").setValue("0");
    expect((await save(w0)).associatedPrinterTimeout).toBe(0);
  });

  it("既存の値が開き、編集しなくても保存で消えない", async () => {
    const w = await openEdit(session({ associatedPrinterSession: "own:p-1", associatedPrinterTimeout: 30 } as Partial<PublicSession>));
    expect((sessionSelect(w)!.element as HTMLSelectElement).value).toBe("own:p-1");
    expect((await save(w)).associatedPrinterTimeout).toBe(30);
  });

  it("**プリンターセッションを選んでいる間は装置名の欄を使えず、装置名を書いている間は選べない**（排他）", async () => {
    const w = await openEdit(session({ associatedPrinterSession: "own:p-1" } as Partial<PublicSession>));
    expect(assocInput(w)!.attributes("disabled")).toBeDefined();
    w.unmount();
    const w2 = await openEdit(session({ associatedPrinter: "PRT01" }));
    expect(sessionSelect(w2)!.attributes("disabled")).toBeDefined();
    w2.unmount();
  });

  it("「指定しない」に戻すと 3 項目とも送らない", async () => {
    const w = await openEdit(session({ associatedPrinterSession: "own:p-1", associatedPrinterTimeout: 30, closeAssociatedPrinterWithLastSession: true } as Partial<PublicSession>));
    await sessionSelect(w)!.setValue("");
    const body = await save(w);
    for (const k of ["associatedPrinterSession", "associatedPrinterTimeout", "closeAssociatedPrinterWithLastSession"]) expect(body).not.toHaveProperty(k);
  });

  it("5250 の表示以外（プリンター・3270）には欄を出さない・送らない", async () => {
    for (const over of [{ sessionType: "printer" as const }, { terminal: "3270" as const }]) {
      const w = await openEdit(session(over));
      expect(sessionSelect(w), JSON.stringify(over)).toBeUndefined();
      w.unmount();
    }
    const w = await openEdit(session({ associatedPrinterSession: "own:p-1" } as Partial<PublicSession>));
    await w.findAll("select").find((s) => s.text().includes("3270"))!.setValue("3270");
    expect(await save(w)).not.toHaveProperty("associatedPrinterSession");
  });

  it("詳細（ⓘ）に**設定の名前**で出す", async () => {
    const w = mount(ConfigCard, { props: { kind: "session" as const, session: session({ associatedPrinterSession: "own:p-1" } as Partial<PublicSession>) } });
    await w.find("button.info").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("関連付けるプリンターセッション私のプリンター");
    w.unmount();
  });
});
