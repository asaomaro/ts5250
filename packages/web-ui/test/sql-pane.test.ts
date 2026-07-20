import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SqlPane from "../src/components/SqlPane.vue";
import { systemsStore } from "../src/stores/systems.js";
import { toCsv } from "../src/csv.js";

/**
 * SQL ペイン。実際の実行は実機でしか確かめられないので、
 * ここでは**送信内容・エラー表示・打ち切り表示・CSV の導線**を固定する。
 */
const originalFetch = globalThis.fetch;

const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

function mockFetch(body: unknown): void {
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: !(body as { __status?: number }).__status,
      json: async () => body
    } as Response;
  }) as typeof fetch;
}

const OK_BODY = {
  columns: [
    { name: "ID", typeName: "INTEGER", nullable: false },
    { name: "NAME", typeName: "VARCHAR", nullable: true }
  ],
  rows: [
    { ID: 1, NAME: "あ" },
    { ID: 2, NAME: null }
  ],
  rowCount: 2,
  truncated: false
};

beforeEach(() => {
  selectSystem();
  mockFetch(OK_BODY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.sessions = [];
  systemsStore.loaded = false;
  vi.restoreAllMocks();
});

async function run(sql = "SELECT 1 FROM SYSIBM.SYSDUMMY1") {
  const w = mount(SqlPane, { props: { tabId: "sql:query" } });
  await w.find("textarea").setValue(sql);
  await w.find("header button").trigger("click");
  await flushPromises();
  return w;
}

describe("実行", () => {
  it("選択中のシステムと SQL と pageSize を送る", async () => {
    const w = await run("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    // ペインを開いた時点で暖機を投げているので、実行の呼び出しを名指しで拾う
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]) === "/api/host/sql"
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.source).toEqual({ system: "own:s1" });
    expect(body.sql).toBe("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    // **上限ではなく「1 度に取得する件数」**として送る
    expect(body.pageSize).toBe(200);
    expect(body.maxRows).toBeUndefined();
    w.unmount();
  });

  it("**ペインを開いた時点で接続を暖める**（実行を押してからの待ちを短くする）", async () => {
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    await flushPromises();
    const warm = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]) === "/api/host/sql/warm"
    );
    expect(warm).toBeDefined();
    expect(JSON.parse(String((warm?.[1] as RequestInit).body))).toEqual({ source: { system: "own:s1" } });
    w.unmount();
  });

  it("暖機が失敗しても画面には何も出さない（実行時に開き直せばよい）", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("暖機に失敗"); }) as typeof fetch;
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    await flushPromises();
    expect(w.find(".error").exists()).toBe(false);
    w.unmount();
  });

  it("SQL が空なら実行ボタンが押せない", async () => {
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    await flushPromises();
    expect(w.find("header button").attributes("disabled")).toBeDefined();
    w.unmount();
  });

  it("結果を列名つきの表で出し、NULL を明示する", async () => {
    const w = await run();
    // 先頭はレコード番号の固定列
    expect(w.findAll("th").map((t) => t.text())).toEqual(["#", "ID", "NAME"]);
    expect(w.findAll("tbody tr")).toHaveLength(2);
    expect(w.find(".null").text()).toBe("NULL");
    w.unmount();
  });

  it("**レコード番号は 1 からの通し番号**で、CSV には入れない", async () => {
    const w = await run();
    expect(w.findAll("tbody .rownum").map((t) => t.text())).toEqual(["1", "2"]);
    // 番号は画面の都合なので、落とすデータには含めない
    expect(toCsv(["ID", "NAME"], OK_BODY.rows as never)).not.toContain("#");
    w.unmount();
  });

  it("0 行なら該当なしを出す", async () => {
    mockFetch({ columns: [], rows: [], rowCount: 0, truncated: false });
    const w = await run();
    expect(w.text()).toContain("該当する行はありません");
    w.unmount();
  });
});

describe("エラー表示", () => {
  it("SQLCODE / SQLSTATE を併記する（文法誤りと権限不足を区別できるように）", async () => {
    mockFetch({
      __status: 400,
      error: "prepare failed",
      code: "SQL_ERROR",
      sqlCode: -204,
      sqlState: "42704"
    });
    const w = await run();
    expect(w.find(".error").text()).toContain("prepare failed");
    expect(w.find(".error").text()).toContain("SQLCODE=-204");
    expect(w.find(".error").text()).toContain("SQLSTATE=42704");
    w.unmount();
  });

  it("メッセージが既に SQLCODE を含むなら二重に出さない", async () => {
    // core は `prepare failed: SQLCODE=-204 SQLSTATE=42704` の形で返すことがある。
    // 実ブラウザ確認で二重表示になっているのを見つけた
    mockFetch({
      __status: 400,
      error: "prepare failed: SQLCODE=-204 SQLSTATE=42704",
      code: "SQL_ERROR",
      sqlCode: -204,
      sqlState: "42704"
    });
    const w = await run();
    const text = w.find(".error").text();
    expect(text.match(/SQLCODE/g)).toHaveLength(1);
    expect(w.find(".detail").exists()).toBe(false);
    w.unmount();
  });

  it("SQLCODE が無いエラーでも本文を出す", async () => {
    mockFetch({ __status: 400, error: "ユーザーとパスワードが登録されていません", code: "CONFIG_ERROR" });
    const w = await run();
    expect(w.find(".error").text()).toContain("ユーザーとパスワード");
    w.unmount();
  });

  it("システム未選択なら実行せず理由を出す", async () => {
    systemsStore.systems = [];
    systemsStore.select("");
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    await w.find("textarea").setValue("SELECT 1");
    await flushPromises();
    // 選択が無いのでボタンは無効。fetch は呼ばれない
    expect(w.find("header button").attributes("disabled")).toBeDefined();
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe("ページング", () => {
  it("続きがあるときは読み足しを促す", async () => {
    mockFetch({ ...OK_BODY, hasMore: true, resultSetId: "rs-1" });
    const w = await run();
    expect(w.find(".more").text()).toContain("End / PageDown");
    w.unmount();
  });

  it("続きが無ければ「これ以上ありません」と出す", async () => {
    const w = await run();
    expect(w.find(".more").text()).toContain("これ以上ありません");
    w.unmount();
  });

  it("CSV ボタンに表示中の件数を出す（何を落とすのか分かるように）", async () => {
    const w = await run();
    expect(w.find("button.link").text()).toContain("2 件");
    w.unmount();
  });
});

describe("実行ログ", () => {
  it("フッターから開閉する（5250 セッションと同じ作法）", async () => {
    const w = await run();
    expect(w.find(".sqllog").exists()).toBe(false);
    await w.find("footer.statusbar .logbtn").trigger("click");
    expect(w.find(".sqllog").exists()).toBe(true);
    await w.find("footer.statusbar .logbtn").trigger("click");
    expect(w.find(".sqllog").exists()).toBe(false);
    w.unmount();
  });

  it("実行した SQL・件数・所要時間を記録する", async () => {
    const w = await run("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    await w.find("footer.statusbar .logbtn").trigger("click");
    const row = w.find(".sqllog .row");
    expect(row.text()).toContain("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    expect(row.text()).toContain("2 件");
    expect(row.text()).toMatch(/\d+ms/);
    w.unmount();
  });

  it("失敗も残す（SQLCODE つきで）", async () => {
    mockFetch({ __status: 400, error: "prepare failed", sqlCode: -204, sqlState: "42704" });
    const w = await run("SELECT * FROM NOSUCH.T");
    await w.find("footer.statusbar .logbtn").trigger("click");
    const row = w.find(".sqllog .row");
    expect(row.classes()).toContain("err");
    expect(row.text()).toContain("失敗");
    expect(row.text()).toContain("SQLCODE=-204");
    w.unmount();
  });

  it("**サーバーへ送らない**（SQL 文は画面の中だけに留める）", async () => {
    const w = await run("SELECT SECRET FROM T WHERE PW='p'");
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    // ログを送る宛先が増えていないこと。既知の 2 つ以外を呼んでいない
    expect(urls.every((u) => u === "/api/host/sql" || u === "/api/host/sql/warm")).toBe(true);
    w.unmount();
  });

  it("**接続を張ったときはジョブ情報つきで記録する**（実機のジョブと突き合わせるため）", async () => {
    mockFetch({
      ...OK_BODY,
      connection: { job: "836995/QUSER/QZDASSINIT", host: "pub400.com", port: 9471, reused: false, ms: 4908 }
    });
    const w = await run();
    await w.find("footer.statusbar .logbtn").trigger("click");
    const conn = w.find(".sqllog .row.connect");
    expect(conn.exists()).toBe(true);
    expect(conn.text()).toContain("接続");
    expect(conn.text()).toContain("836995/QUSER/QZDASSINIT");
    expect(conn.text()).toContain("pub400.com:9471");
    expect(conn.text()).toContain("4908ms");
    w.unmount();
  });

  it("**使い回したときは接続の行を出さない**（本当に張り直した回が埋もれるため）", async () => {
    mockFetch({ ...OK_BODY, connection: { job: "836995/QUSER/QZDASSINIT", reused: true, ms: 0 } });
    const w = await run();
    await w.find("footer.statusbar .logbtn").trigger("click");
    expect(w.find(".sqllog .row.connect").exists()).toBe(false);
    expect(w.findAll(".sqllog .row")).toHaveLength(1); // 実行の 1 件だけ
    w.unmount();
  });

  it("ジョブ情報を返さないホストでも接続は記録する", async () => {
    mockFetch({ ...OK_BODY, connection: { host: "h", port: 9471, reused: false, ms: 100 } });
    const w = await run();
    await w.find("footer.statusbar .logbtn").trigger("click");
    expect(w.find(".sqllog .row.connect").text()).toContain("ジョブ情報を返さない");
    w.unmount();
  });

  it("フッターに直近の結果を出す（開かなくても分かるように）", async () => {
    const w = await run();
    expect(w.find("footer.statusbar .last").text()).toContain("完了");
    w.unmount();
  });

  it("**フッターに接続中のホスト側ジョブを出す**（ログを開かなくても分かるように）", async () => {
    mockFetch({
      ...OK_BODY,
      connection: { job: "836995/QUSER/QZDASSINIT", host: "pub400.com", port: 9471, reused: false, ms: 4908 }
    });
    const w = await run();
    const conn = w.find("footer.statusbar .conn");
    expect(conn.text()).toContain("836995/QUSER/QZDASSINIT");
    expect(conn.text()).toContain("pub400.com:9471");
    w.unmount();
  });

  it("**使い回した接続でもフッターは更新する**（「いまどこに繋がっているか」を示すため）", async () => {
    mockFetch({ ...OK_BODY, connection: { job: "836995/QUSER/QZDASSINIT", host: "h", port: 9471, reused: true, ms: 0 } });
    const w = await run();
    // ログ行は出ない（張り直していない）が、フッターのジョブは出る
    await w.find("footer.statusbar .logbtn").trigger("click");
    expect(w.find(".sqllog .row.connect").exists()).toBe(false);
    expect(w.find("footer.statusbar .conn").text()).toContain("836995/QUSER/QZDASSINIT");
    w.unmount();
  });

  it("ジョブ情報を返さないホストではフッターに job=— と出す（接続先は出す）", async () => {
    mockFetch({ ...OK_BODY, connection: { host: "h", port: 9471, reused: false, ms: 100 } });
    const w = await run();
    const conn = w.find("footer.statusbar .conn");
    expect(conn.text()).toContain("job=—");
    expect(conn.text()).toContain("h:9471");
    w.unmount();
  });

  it("接続情報が無いうちは「未接続」と出す", async () => {
    mockFetch(OK_BODY); // connection を返さない
    const w = await run();
    expect(w.find("footer.statusbar .conn").text()).toBe("未接続");
    w.unmount();
  });

  it("消去できる", async () => {
    const w = await run();
    await w.find("footer.statusbar .logbtn").trigger("click");
    expect(w.findAll(".sqllog .row")).toHaveLength(1);
    await w.find(".sqllog button.link").trigger("click");
    expect(w.findAll(".sqllog .row")).toHaveLength(0);
    expect(w.find("footer.statusbar .cnt").text()).toBe("0");
    w.unmount();
  });
});

describe("列幅", () => {
  /**
   * 幅そのものは CSS（`width: auto` + `max-width: 40ch`）が決めるので、
   * ここでは**打ち切られた値を読む手段が残っている**ことだけを固定する。
   * 見た目は実ブラウザで確認する。
   */
  it("セルの全文を title で読める（40 文字で打ち切られるため）", async () => {
    const long = "X".repeat(300);
    mockFetch({ ...OK_BODY, rows: [{ ID: 1, NAME: long }] });
    const w = await run();
    const cells = w.findAll("tbody td");
    expect(cells[2]?.attributes("title")).toBe(long);
    w.unmount();
  });

  it("NULL と LOB には外側の title を付けない（中の説明が読めなくなるため）", async () => {
    mockFetch({
      ...OK_BODY,
      rows: [{ ID: null, NAME: { kind: "lob", unavailable: "not-requested" } }]
    });
    const w = await run();
    const cells = w.findAll("tbody td");
    expect(cells[1]?.attributes("title")).toBeUndefined();
    expect(cells[2]?.attributes("title")).toBeUndefined();
    // 中の span 側の説明は残っている
    expect(w.find(".lob").attributes("title")).toContain("取得していません");
    w.unmount();
  });
});

describe("列幅のドラッグ", () => {
  /** jsdom には幅が無いので、**状態の持ち方**だけを固定する（見た目は実ブラウザで確認） */
  async function drag(w: ReturnType<typeof mount>, index: number, dx: number) {
    // test-utils の trigger は clientX を後から代入するため jsdom で落ちる。
    // ポインタ列の位置が要るので、イベントを直接組み立てて投げる
    const el = w.findAll("thead .col-grip")[index]?.element as HTMLElement;
    const at = (type: string, x: number) =>
      el.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, cancelable: true }));
    at("pointerdown", 100);
    at("pointermove", 100 + dx);
    at("pointerup", 100 + dx);
    await flushPromises();
  }

  it("広げた幅は max-width も上書きする（**打ち切りの基準ごと動かさないと文字が見えない**）", async () => {
    const w = await run();
    await drag(w, 0, 300);
    const style = w.findAll("thead th")[1]?.attributes("style") ?? "";
    expect(style).toContain("width: 300px");
    expect(style).toContain("max-width: 300px");
    w.unmount();
  });

  it("下限より狭くならない（掴めなくなるため）", async () => {
    const w = await run();
    await drag(w, 0, -1000);
    expect(w.findAll("thead th")[1]?.attributes("style")).toContain("width: 40px");
    w.unmount();
  });

  it("ダブルクリックで既定へ戻す", async () => {
    const w = await run();
    await drag(w, 0, 300);
    await w.findAll("thead .col-grip")[0]?.trigger("dblclick");
    expect(w.findAll("thead th")[1]?.attributes("style")).toBeUndefined();
    w.unmount();
  });

  it("**再実行で捨てる**（列の並びが変わると対応が狂うため）", async () => {
    const w = await run();
    await drag(w, 0, 300);
    expect(w.findAll("thead th")[1]?.attributes("style")).toContain("300px");
    await w.find("header button").trigger("click");
    await flushPromises();
    expect(w.findAll("thead th")[1]?.attributes("style")).toBeUndefined();
    w.unmount();
  });

  it("レコード番号の列には掴み手を出さない", async () => {
    const w = await run();
    expect(w.findAll("thead .col-grip")).toHaveLength(2); // データ列のぶんだけ
    expect(w.find("thead th.rownum").find(".col-grip").exists()).toBe(false);
    w.unmount();
  });
});

describe("SQL 欄と結果欄の境界", () => {
  /**
   * つまみ（textarea の resize）は「どこを掴めば動くのか分からない」と指摘を受けたので、
   * **境界の罫線そのもの**を掴めるようにした。ここではその導線だけを固定する
   * （見た目とドラッグの追従は実ブラウザで確かめる）。
   */
  it("罫線がキーボードでも動かせる", async () => {
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    const splitter = w.find(".splitter");
    expect(splitter.attributes("role")).toBe("separator");
    const before = Number(/height:\s*(\d+)px/.exec(w.find("textarea").attributes("style") ?? "")?.[1]);

    await splitter.trigger("keydown", { key: "ArrowDown" });
    const after = Number(/height:\s*(\d+)px/.exec(w.find("textarea").attributes("style") ?? "")?.[1]);
    expect(after).toBeGreaterThan(before);
    w.unmount();
  });

  it("下限より小さくならない（結果欄に押し潰されない）", async () => {
    const w = mount(SqlPane, { props: { tabId: "sql:query" } });
    const splitter = w.find(".splitter");
    for (let i = 0; i < 30; i++) await splitter.trigger("keydown", { key: "ArrowUp", shiftKey: true });
    const h = Number(/height:\s*(\d+)px/.exec(w.find("textarea").attributes("style") ?? "")?.[1]);
    expect(h).toBe(60);
    w.unmount();
  });
});

describe("CSV ダウンロード", () => {
  it("結果が無いときはボタンを出さない", async () => {
    mockFetch({ columns: [], rows: [], rowCount: 0, truncated: false });
    const w = await run();
    expect(w.find("button.link").exists()).toBe(false);
    w.unmount();
  });

  it("結果があれば Blob URL を作って a.click で落とす", async () => {
    const createURL = vi.fn(() => "blob:x");
    const revokeURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: createURL, revokeObjectURL: revokeURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const w = await run();
    await w.find("button.link").trigger("click");

    expect(createURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    // 解放しないと Blob がタブの寿命だけ残る
    expect(revokeURL).toHaveBeenCalledWith("blob:x");
    vi.unstubAllGlobals();
    w.unmount();
  });
});
