import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TransferPane from "../src/components/TransferPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * データ転送ペイン。実際の書き込みは実機でしか確かめられないので、ここでは
 * **状態遷移・拒否理由の見せ方・組み立てる SQL・識別子の検証**を固定する。
 *
 * とくに「完了」と「部分完了」を別表示にすることは仕様上の要求
 * （巻き戻せないため、利用者が次に取る行動が違う）。
 */
const originalFetch = globalThis.fetch;
const SYSTEM = { ref: "own:s1", name: "自分のシステム", host: "h", autoSignon: false };

function selectSystem(): void {
  systemsStore.systems = [SYSTEM];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  systemsStore.select(SYSTEM.ref);
}

function mockFetch(body: unknown, ok = true): void {
  globalThis.fetch = vi.fn(async () => ({ ok, json: async () => body }) as Response) as typeof fetch;
}

beforeEach(() => {
  selectSystem();
  mockFetch({});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  systemsStore.systems = [];
  systemsStore.select(undefined);
  vi.restoreAllMocks();
});

function mountPane() {
  return mount(TransferPane, { props: { tabId: "transfer:data" } });
}

/** CSV を読み込ませる（File.text() を経由せず、内部の解析経路を通す） */
async function loadCsv(w: ReturnType<typeof mountPane>, text: string) {
  const file = { name: "t.csv", text: async () => text } as unknown as File;
  await (w.vm as unknown as { loadFile: (f: File) => Promise<void> }).loadFile?.(file);
  await flushPromises();
}

describe("方向切替", () => {
  it("既定は取り込み。押すと取得に切り替わる", async () => {
    const w = mountPane();
    const [dl, ul] = w.findAll(".seg button");
    expect(ul!.attributes("aria-pressed")).toBe("true");
    await dl!.trigger("click");
    expect(dl!.attributes("aria-pressed")).toBe("true");
    // 取得側には絞り込み欄が出て、ドロップ領域は消える
    expect(w.text()).toContain("絞り込み");
    expect(w.find(".drop").exists()).toBe(false);
    w.unmount();
  });
});

describe("識別子の検証（サーバーと同じ規則）", () => {
  it.each([
    ["空", "", "TESTPF"],
    ["長すぎる", "ABCDEFGHIJK", "TESTPF"],
    ["記号", "MAR-O1", "TESTPF"],
    ["ファイル側", "MYLIB", "A;B"]
  ])("**%s なら実行ボタンを押せない**", async (_n, lib, file) => {
    const w = mountPane();
    const inputs = w.findAll("header input");
    await inputs[0]!.setValue(lib);
    await inputs[1]!.setValue(file);
    expect((w.find("button.go").element as HTMLButtonElement).disabled).toBe(true);
    w.unmount();
  });
});

describe("取り込みの状態遷移", () => {
  it("CSV を読むとプレビューになり、行数が出る", async () => {
    const w = mountPane();
    await loadCsv(w, "A,B\n1,2\n3,4");
    expect(w.text()).toContain("2 行");
    expect(w.find("table").exists()).toBe(true);
    w.unmount();
  });

  it("**壊れた CSV は解析失敗として止まる**（送信しない）", async () => {
    const w = mountPane();
    await loadCsv(w, 'A\n"x');
    expect(w.text()).toContain("CSV を読めません");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    w.unmount();
  });

  it("**拒否は行番号と列名つきで並べる**（1 行も書いていないと明示）", async () => {
    mockFetch(
      {
        rejections: [
          { kind: "value-invalid", row: 3, column: "TEST1", reason: "5 バイトの列に 8 バイトの値です" },
          {
            kind: "value-invalid",
            row: 7,
            column: "TEST2",
            reason: "CCSID 273 では書けない文字が含まれます: 日"
          }
        ],
        truncated: false
      },
      false
    );
    const w = mountPane();
    await loadCsv(w, "TEST1,TEST2\na,b");
    const inputs = w.findAll("header input");
    await inputs[0]!.setValue("MYLIB");
    await inputs[1]!.setValue("TESTPF");
    await w.find("button.go").trigger("click");
    await flushPromises();

    const box = w.find(".result.bad");
    expect(box.exists()).toBe(true);
    expect(box.text()).toContain("1 行も書いていません");
    expect(box.text()).toContain("3 行目");
    expect(box.text()).toContain("TEST1");
    expect(box.text()).toContain("5 バイトの列に 8 バイト");
    expect(box.text()).toContain("7 行目");
    expect(box.text()).toContain("日");
    w.unmount();
  });

  it("全件成功なら完了として出す", async () => {
    mockFetch({ committedRows: 2, batchSize: 100, ms: 700 });
    const w = mountPane();
    await loadCsv(w, "A\n1\n2");
    const inputs = w.findAll("header input");
    await inputs[0]!.setValue("MYLIB");
    await inputs[1]!.setValue("TESTPF");
    await w.find("button.go").trigger("click");
    await flushPromises();
    expect(w.find(".result.ok").text()).toContain("2 行を取り込みました");
    expect(w.find(".result.warn").exists()).toBe(false);
    w.unmount();
  });

  it("**部分完了は完了と別表示にし、確定範囲と不明範囲を分けて出す**", async () => {
    mockFetch({
      committedRows: 100,
      uncertainRange: { from: 101, to: 142 },
      batchSize: 100,
      ms: 2000
    });
    const w = mountPane();
    await loadCsv(w, "A\n1\n2");
    const inputs = w.findAll("header input");
    await inputs[0]!.setValue("MYLIB");
    await inputs[1]!.setValue("TESTPF");
    await w.find("button.go").trigger("click");
    await flushPromises();

    expect(w.find(".result.ok").exists()).toBe(false); // 成功と同じ見せ方にしない
    const box = w.find(".result.warn");
    expect(box.text()).toContain("取り消せません");
    expect(box.text()).toContain("1 〜 100 行目は書き込まれました");
    expect(box.text()).toContain("101 〜 142 行目");
    expect(box.text()).toContain("分かりません");
    w.unmount();
  });
});

describe("取得", () => {
  it("**SQL エディタは出さず**、表と条件から組み立てて投げる", async () => {
    mockFetch({ columns: [{ name: "ID" }], rows: [{ ID: 1 }] });
    const w = mountPane();
    await w.findAll(".seg button")[0]!.trigger("click"); // 取得へ
    expect(w.find("textarea").exists()).toBe(false);

    const inputs = w.findAll("header input");
    await inputs[0]!.setValue("testlib");
    await inputs[1]!.setValue("sqltypes");
    await inputs[2]!.setValue("ID < 100");
    await w.find("button.go").trigger("click");
    await flushPromises();

    const body = JSON.parse(
      String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)
    );
    // 識別子は大文字に正規化される
    expect(body.sql).toBe("SELECT * FROM MYLIB.SQLTYPES WHERE ID < 100");
    w.unmount();
  });

  it("条件が空なら WHERE を付けない", async () => {
    mockFetch({ columns: [], rows: [] });
    const w = mountPane();
    await w.findAll(".seg button")[0]!.trigger("click");
    const inputs = w.findAll("header input");
    await inputs[0]!.setValue("MYLIB");
    await inputs[1]!.setValue("TESTPF");
    await w.find("button.go").trigger("click");
    await flushPromises();
    const body = JSON.parse(
      String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)
    );
    expect(body.sql).toBe("SELECT * FROM MYLIB.TESTPF");
    w.unmount();
  });

  it("方向を切り替えると取り込みの状態を捨てる（取り違えを防ぐ）", async () => {
    const w = mountPane();
    await loadCsv(w, "A\n1");
    expect(w.text()).toContain("1 行");
    await w.findAll(".seg button")[0]!.trigger("click");
    await w.findAll(".seg button")[1]!.trigger("click");
    expect(w.find(".drop").text()).toContain("CSV をここに落とす");
    w.unmount();
  });
});
