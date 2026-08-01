import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SpoolPane from "../src/components/SpoolPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * pull 型スプールのペイン。
 *
 * 実際の取得は実機に依存するため、ここでは**表示の切り替え・打ち切りの見せ方・
 * 失敗を黙らせないこと**を固定する。とくに PDF の失敗表示は、プリンターペインが
 * `!res.ok` で無言 return していた反省から入れているので、回帰資産として残す。
 */
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

const ROW = {
  jobName: "QPRTJOB",
  jobUser: "USER",
  jobNumber: "681803",
  fileName: "QPRTLIBL",
  fileNumber: 5,
  outputQueue: "PRT1",
  outputQueueLibrary: "QUSRSYS",
  status: "READY",
  totalPages: 2,
  userData: "UD",
  formType: "STD",
  dateOpened: "2026-07-18",
  timeOpened: "16.50.05",
  size: 512
};

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

/** URL ごとに応答を差し替える。`__status` を付けると失敗応答になる */
function mockFetch(handlers: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const body = (handlers[String(url)] ?? {}) as { __status?: number; __blob?: boolean };
    return {
      ok: !body.__status,
      status: body.__status ?? 200,
      json: async () => body,
      blob: async () => new Blob(["%PDF-"], { type: "application/pdf" })
    } as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  mockFetch({
    "/api/systems": { systems: [SYSTEM], editable: false },
    "/api/sessions-config": { sessions: [] }
  });
  selectSystem();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  systemsStore.systems = [];
  systemsStore.sessions = [];
  systemsStore.select(undefined);
  vi.restoreAllMocks();
});

async function mountPane() {
  const w = mount(SpoolPane, { props: { tabId: "spool:files" } });
  await flushPromises();
  return w;
}

describe("システム未選択のガード", () => {
  it("接続を選んでいなければ取得せずに促す", async () => {
    systemsStore.select(undefined);
    const w = await mountPane();

    await w.find("header button").trigger("click");
    await flushPromises();

    expect(w.text()).toContain("システムを選んでください");
    w.unmount();
  });
});

describe("一覧", () => {
  it("取得した行を表示する", async () => {
    mockFetch({
      "/api/host/spools": { items: [ROW], count: 1, truncated: false }
    });
    const w = await mountPane();

    await w.find("header button").trigger("click");
    await flushPromises();

    expect(w.text()).toContain("QPRTLIBL");
    expect(w.text()).toContain("QUSRSYS/PRT1");
    // 状態は数値コードではなく名前で出す
    expect(w.text()).toContain("READY");
    w.unmount();
  });

  it("打ち切られたら必ず断る（黙って切らない）", async () => {
    mockFetch({
      "/api/host/spools": { items: [ROW], count: 1, truncated: true }
    });
    const w = await mountPane();

    await w.find("header button").trigger("click");
    await flushPromises();

    expect(w.text()).toContain("先頭 1 件のみ表示しています");
    w.unmount();
  });

  it("打ち切られていなければ件数の断り書きを出さない", async () => {
    mockFetch({
      "/api/host/spools": { items: [ROW], count: 1, truncated: false }
    });
    const w = await mountPane();

    await w.find("header button").trigger("click");
    await flushPromises();

    expect(w.text()).not.toContain("のみ表示しています");
    w.unmount();
  });

  it("失敗はサーバーのメッセージをそのまま見せる", async () => {
    mockFetch({
      "/api/host/spools": { __status: 400, error: "権限がありません" }
    });
    const w = await mountPane();

    await w.find("header button").trigger("click");
    await flushPromises();

    expect(w.text()).toContain("権限がありません");
    w.unmount();
  });

  it("空欄の絞り込みは送らない（*ALL の補完を core に任せる）", async () => {
    mockFetch({ "/api/host/spools": { items: [], count: 0, truncated: false } });
    const w = await mountPane();

    await w.find("header button").trigger("click");
    await flushPromises();

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]) === "/api/host/spools"
    );
    expect(JSON.parse(String((call?.[1] as RequestInit).body)).filter).toEqual({});
    w.unmount();
  });
});

describe("中身の表示", () => {
  async function openRow(handlers: Record<string, unknown>) {
    mockFetch({
      "/api/host/spools": { items: [ROW], count: 1, truncated: false },
      ...handlers
    });
    const w = await mountPane();
    await w.find("header button").trigger("click");
    await flushPromises();
    await w.find("tbody tr").trigger("click");
    await flushPromises();
    return w;
  }

  /**
   * PDF ボタンを押す。**押せる状態であることを先に確かめる**——
   * disabled のボタンに trigger("click") してもハンドラは走らず、
   * テストは「何も起きなかった」まま素通りしてしまう（静かな空振り）。
   */
  async function clickFormat(
    w: Awaited<ReturnType<typeof openRow>>,
    label: "PDF" | "HTML"
  ): Promise<void> {
    // 最大化ボタンも同じ帯にあるので、文言で選ぶ
    const btn = w.findAll(".viewer-bar button").find((b) => b.text() === label)!;
    expect(btn, `${label} ボタンがある`).toBeTruthy();
    expect(btn.attributes("disabled")).toBeUndefined();
    await btn.trigger("click");
    await flushPromises();
  }
  const clickPdf = (w: Awaited<ReturnType<typeof openRow>>) => clickFormat(w, "PDF");

  it("複数ページは改ページ区切りで連結する（プリンターペインと同じ見せ方）", async () => {
    const w = await openRow({
      "/api/host/spool/content": {
        pages: [
          { rows: 1, cols: 5, lines: ["一枚目"] },
          { rows: 1, cols: 5, lines: ["二枚目"] }
        ]
      }
    });

    const text = w.find("pre").text();
    expect(text).toContain("一枚目");
    expect(text).toContain("(改ページ)");
    expect(text).toContain("二枚目");
    w.unmount();
  });

  it("取得に失敗したらメッセージを出す", async () => {
    const w = await openRow({
      "/api/host/spool/content": { __status: 400, error: "スプールが見つかりません" }
    });

    expect(w.text()).toContain("スプールが見つかりません");
    w.unmount();
  });

  it("PDF の失敗を黙らせない（プリンターペインの無言 return を繰り返さない）", async () => {
    const w = await openRow({
      "/api/host/spool/content": { pages: [{ rows: 1, cols: 5, lines: ["本文"] }] },
      "/api/host/spool/pdf": { __status: 502, error: "PDF を作れませんでした" }
    });

    await clickPdf(w);

    expect(w.text()).toContain("PDF を作れませんでした");
    w.unmount();
  });

  /**
   * HTML は PDF と**同じ経路**（`download(kind)`）を通る。ルートと拡張子だけが違う。
   * 2 本に分かれていると片方だけ直す事故が起きるので、両方が同じ手順を辿ることを固定する。
   */
  it("HTML が成功すれば .html でダウンロードする", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    let downloadName = "";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloadName = this.download;
    });

    const w = await openRow({
      "/api/host/spool/content": { pages: [{ rows: 1, cols: 5, lines: ["本文"] }] },
      "/api/host/spool/html": {}
    });

    await clickFormat(w, "HTML");

    expect(click).toHaveBeenCalled();
    expect(downloadName).toBe("QPRTLIBL-QPRTJOB-5.html");
    w.unmount();
  });

  it("HTML の失敗も黙らせない（PDF と同じ扱い）", async () => {
    const w = await openRow({
      "/api/host/spool/content": { pages: [{ rows: 1, cols: 5, lines: ["本文"] }] },
      "/api/host/spool/html": { __status: 502, error: "HTML を作れませんでした" }
    });

    await clickFormat(w, "HTML");

    expect(w.text()).toContain("HTML を作れませんでした");
    w.unmount();
  });

  it("PDF が成功すればダウンロードする", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const w = await openRow({
      "/api/host/spool/content": { pages: [{ rows: 1, cols: 5, lines: ["本文"] }] },
      "/api/host/spool/pdf": {}
    });

    await clickPdf(w);

    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
    w.unmount();
  });
});

/**
 * 応答は要求した順に返るとは限らない（毎回ホストへ新規接続するため秒単位かかる）。
 * 素朴に書くと「見出しは B なのに本文は A」という、**別のスプールの中身を
 * 別のファイル名で見せる**状態になり、しかもエラーが出ないので気づけない。
 */
describe("応答の追い越し", () => {
  const ROW2 = { ...ROW, fileName: "OTHER", fileNumber: 9 };

  /** URL ごとに解決を手で制御できる fetch */
  function deferredFetch() {
    const pending: { url: string; resolve: (body: unknown) => void }[] = [];
    globalThis.fetch = vi.fn(
      (url: RequestInfo | URL) =>
        new Promise((res) => {
          pending.push({
            url: String(url),
            resolve: (body) =>
              res({ ok: true, status: 200, json: async () => body, blob: async () => new Blob() } as Response)
          });
        })
    ) as typeof fetch;
    return pending;
  }

  it("古い中身の応答が新しい選択を上書きしない", async () => {
    mockFetch({ "/api/host/spools": { items: [ROW, ROW2], count: 2, truncated: false } });
    const w = await mountPane();
    await w.find("header button").trigger("click");
    await flushPromises();

    const pending = deferredFetch();
    const trs = w.findAll("tbody tr");
    await trs[0]!.trigger("click"); // A を選ぶ
    await trs[1]!.trigger("click"); // 続けて B を選ぶ

    // **B → A の順で解決させる**（逆順到着）
    pending[1]!.resolve({ pages: [{ rows: 1, cols: 5, lines: ["Bの本文"] }] });
    await flushPromises();
    pending[0]!.resolve({ pages: [{ rows: 1, cols: 5, lines: ["Aの本文"] }] });
    await flushPromises();

    // 見出しは B。本文も B でなければならない
    expect(w.text()).toContain("OTHER");
    expect(w.find("pre").text()).toContain("Bの本文");
    expect(w.find("pre").text()).not.toContain("Aの本文");
    w.unmount();
  });

  it("システムを切り替えたあとに旧システムの一覧が書き戻らない", async () => {
    const pending = deferredFetch();
    const w = mount(SpoolPane, { props: { tabId: "spool:files" } });
    await flushPromises();
    await w.find("header button").trigger("click");

    // 取得中に切り替える
    systemsStore.systems = [SYSTEM, { ...SYSTEM, ref: "own:s2", name: "別" }];
    systemsStore.select("own:s2");
    await flushPromises();

    // 旧システムの応答が遅れて届く
    const listCall = pending.find((p) => p.url === "/api/host/spools");
    listCall?.resolve({ items: [ROW], count: 1, truncated: false });
    await flushPromises();

    expect(w.text()).not.toContain("QPRTLIBL");
    w.unmount();
  });
});

describe("通信失敗", () => {
  it("失敗したら前回の行を残さない（どちらが今の内容か分からなくなるため）", async () => {
    mockFetch({ "/api/host/spools": { items: [ROW], count: 1, truncated: false } });
    const w = await mountPane();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("QPRTLIBL");

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await w.find("header button").trigger("click");
    await flushPromises();

    expect(w.text()).toContain("取得に失敗しました");
    expect(w.text()).not.toContain("QPRTLIBL");
    w.unmount();
  });
});

/**
 * 登録漏れは**既知のバグ源**——以前 `list:*` を判定に足し忘れ、タブを閉じたときに
 * 「セッションの切断」処理へ流れる不具合が出た（paneLabels.ts の冒頭コメント）。
 */
describe("ペインの登録", () => {
  it("spool: はセッションを持たないタブとして識別される", async () => {
    const { isPaneTab } = await import("../src/paneLabels.js");
    expect(isPaneTab("spool:files")).toBe(true);
  });

  it("表示名が登録されている", async () => {
    const { PANE_LABELS } = await import("../src/paneLabels.js");
    expect(PANE_LABELS["spool:files"]).toBe("スプール");
  });

  it("プリンター（push 型）と紛れない名前になっている", async () => {
    const { PANE_LABELS } = await import("../src/paneLabels.js");
    expect(PANE_LABELS["spool:files"]).not.toBe("プリンター");
  });
});

describe("接続先の切り替え", () => {
  it("システムを変えたら結果を捨てる（自動では取り直さない）", async () => {
    mockFetch({
      "/api/host/spools": { items: [ROW], count: 1, truncated: false }
    });
    const w = await mountPane();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("QPRTLIBL");

    systemsStore.systems = [SYSTEM, { ...SYSTEM, ref: "own:s2", name: "別" }];
    systemsStore.select("own:s2");
    await flushPromises();

    expect(w.text()).not.toContain("QPRTLIBL");
    w.unmount();
  });
});

/**
 * **一覧と表示領域の分割・最大化。**
 *
 * SQL ペインと同じ操作にするための機能（境界を掴む・上下キー・最大化）。
 * 帳票は縦にも横にも長いので、表示だけを広げたい場面が多い。
 */
describe("一覧と表示の分割", () => {
  beforeEach(() => selectSystem());

  async function openRow() {
    mockFetch({
      "/api/host/spools": { items: [ROW], count: 1, truncated: false },
      "/api/host/spool/content": { pages: [{ rows: 1, cols: 10, lines: ["本文"] }] }
    });
    const w = await mountPane();
    await w.find("header button").trigger("click");
    await flushPromises();
    await w.find("tbody tr").trigger("click");
    await flushPromises();
    return w;
  }

  const maxButton = (w: Awaited<ReturnType<typeof openRow>>) =>
    w.findAll(".viewer-bar button").find((b) => b.text().includes("最大化") || b.text().includes("元に戻す"))!;

  it("行を選ぶまでは境界を出さない（一覧だけのときは分ける物が無い）", async () => {
    mockFetch({ "/api/host/spools": { items: [ROW], count: 1, truncated: false } });
    const w = await mountPane();
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.find(".splitter").exists()).toBe(false);
    w.unmount();
  });

  it("行を選ぶと境界が出て、一覧の高さが固定される", async () => {
    const w = await openRow();
    expect(w.find(".splitter").exists()).toBe(true);
    expect(w.find(".scroll").attributes("style")).toContain("px");
    w.unmount();
  });

  it("上下キーで一覧の高さが変わる", async () => {
    const w = await openRow();
    const before = w.find(".scroll").attributes("style");
    await w.find(".splitter").trigger("keydown", { key: "ArrowUp" });
    expect(w.find(".scroll").attributes("style")).not.toBe(before);
    w.unmount();
  });

  it("最大化すると一覧と境界が消え、戻すと出る", async () => {
    const w = await openRow();
    await maxButton(w).trigger("click");
    await flushPromises();
    expect(w.find(".splitter").exists(), "境界は隠れる").toBe(false);
    expect(w.find(".scroll").attributes("style"), "一覧は隠れる").toContain("display: none");

    await maxButton(w).trigger("click");
    await flushPromises();
    expect(w.find(".splitter").exists()).toBe(true);
    const style = w.find(".scroll").attributes("style") ?? "";
    expect(style, "一覧が戻る").not.toContain("display: none");
    expect(style, "高さも戻る").toContain("220px");
    w.unmount();
  });
});
