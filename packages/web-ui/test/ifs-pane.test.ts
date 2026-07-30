import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import IfsPane from "../src/components/IfsPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * IFS パネル。**吸収後の状態が画面にどう出るか**を見る。
 *
 * とくに「辿れない場所」と「復号できないテキスト」は、
 * 素直に書くとエラー画面になってしまう。そうなっていないことを固定する。
 */
const realFetch = globalThis.fetch;
const realSelected = systemsStore.selected;

beforeEach(() => {
  systemsStore.selected = "srv:s";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  systemsStore.selected = realSelected;
});

const entry = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  isDirectory: false,
  isSymlink: false,
  size: 1024,
  modifiedAt: 1_700_000_000_000,
  restartId: 1,
  ...over
});

/** URL ごとに応答を返す偽 fetch */
function mockFetch(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const key = String(url).replace("/api/host/ifs/", "");
    const body = routes[key] ?? { entries: [], hasMore: false, canContinue: false };
    return new Response(JSON.stringify(body), {
      status: status[key] ?? 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

async function paneWith(routes: Record<string, unknown>, status?: Record<string, number>) {
  mockFetch(routes, status);
  const wrapper = mount(IfsPane, { props: { tabId: "ifs:files" } });
  await flushPromises();
  return wrapper;
}

describe("一覧の表示", () => {
  it("ファイルとフォルダを並べる", async () => {
    const w = await paneWith({
      list: {
        entries: [entry("a.txt"), entry("sub", { isDirectory: true })],
        hasMore: false,
        canContinue: false
      }
    });
    expect(w.text()).toContain("a.txt");
    expect(w.text()).toContain("sub");
  });

  it("空のフォルダはそう伝える", async () => {
    const w = await paneWith({ list: { entries: [], hasMore: false, canContinue: false } });
    expect(w.text()).toContain("空のフォルダ");
  });

  /**
   * **「空 = 終わり」ではない。** `.` と `..` が件数上限を消費すると
   * 実データ 0 件で続きがある状態になる。ここで「空のフォルダ」と出すと嘘になる。
   */
  it("空でも続きがあるなら「空のフォルダ」と言わない", async () => {
    const w = await paneWith({
      list: { entries: [], hasMore: true, canContinue: true, nextRestartId: 2 }
    });
    expect(w.text()).not.toContain("空のフォルダ");
    expect(w.text()).toContain("続きを読み込む");
  });

  /** 辿れない場所では「先頭 N 件まで」と伝える（黙って打ち切らない） */
  it("辿れない場所では取得できた件数を伝える", async () => {
    const w = await paneWith({
      list: { entries: [entry("a")], hasMore: true, canContinue: false }
    });
    expect(w.text()).toContain("先頭 1 件までしか取得できません");
    expect(w.text()).not.toContain("続きを読み込む");
  });

  it("一覧に失敗したら理由を出す", async () => {
    const w = await paneWith({ list: { error: "no such directory" } }, { list: 404 });
    expect(w.text()).toContain("no such directory");
  });
});

describe("ファイル名の描画", () => {
  /** 実機の /home に端末エスケープを含む名前が実在した。そのまま流さない */
  it("制御文字を可視の記号に置き換える", async () => {
    const w = await paneWith({
      list: {
        entries: [entry("OZIAN[D[Cau.txt")],
        hasMore: false,
        canContinue: false
      }
    });
    expect(w.text()).not.toContain("");
    expect(w.text()).toContain("␣");
  });

  it("極端に長い名前は省略する", async () => {
    const w = await paneWith({
      list: { entries: [entry("x".repeat(300))], hasMore: false, canContinue: false }
    });
    expect(w.text()).toContain("…");
    expect(w.text()).not.toContain("x".repeat(200));
  });
});

describe("プレビュー", () => {
  it("テキストを選ぶと中身を出す", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.txt")], hasMore: false, canContinue: false },
      read: { content: "hello world", bytes: 11, encoding: "utf8" }
    });
    await w.findAll("li")[0]?.trigger("click");
    await flushPromises();
    // textarea の値は w.text() に出ないので要素の value を見る
    expect((w.find("textarea.editor").element as HTMLTextAreaElement).value).toBe("hello world");
  });

  /**
   * **復号できないのはエラーではない。**
   * 「失敗しました」ではなく、次にどうすればよいかを示す。
   */
  it("復号できないテキストは、失敗ではなく案内として出す", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.txt")], hasMore: false, canContinue: false },
      read: {
        content: null,
        bytes: 3,
        encoding: null,
        code: "UNSUPPORTED_ENCODING",
        tagCcsid: 850
      }
    });
    await w.findAll("li")[0]?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("選び直すか、ダウンロードして開いてください");
    expect(w.find(".error").exists()).toBe(false);
    // 読めなくても手掛かり（タグ）と選び直す手段を出す
    expect(w.text()).toContain("850");
    expect(w.find(".encoding select").exists()).toBe(true);
  });

  /**
   * 表示できているテキストの下に「プレビューできません」を出さない。
   * v-else の連鎖を「編集中」の note に繋ぐと、未編集のテキストで最後の v-else が真になる
   * （実機の画面で見つけた。main にもあった不具合）
   */
  it("テキストを表示しているときに「プレビューできません」を出さない", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.txt")], hasMore: false, canContinue: false },
      read: { content: "本文", bytes: 6, encoding: "utf8", ccsid: 1208, detectedBy: "content" }
    });
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    expect(w.find("textarea.editor").exists()).toBe(true);
    expect(w.text()).not.toContain("この形式はプレビューできません");
  });

  it("プレビューできない種別ではその案内を出す", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.bin")], hasMore: false, canContinue: false }
    });
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("この形式はプレビューできません");
  });

  /**
   * 選び直しは「当たるまで試す」操作。1 回外しただけで本文も選択 UI も消えると次の 1 手が打てない
   * （review M1）。
   */
  it("選んだ文字コードで読めなくても、直前の表示と選択 UI を消さない", async () => {
    let reads = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("a.txt")], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      reads++;
      const ok = { content: "本文", bytes: 6, encoding: "utf8", ccsid: 1208, detectedBy: "content" };
      const ng = { error: "x", code: "DECODE_FAILED" };
      return new Response(JSON.stringify(reads === 1 ? ok : ng), {
        status: reads === 1 ? 200 : 400,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();

    const select = w.find(".encoding select");
    (select.element as HTMLSelectElement).value = "37";
    await select.trigger("change");
    await flushPromises();

    // 失敗の案内は出す。ただし本文も選択 UI も残す
    expect(w.text()).toContain("別の文字コードを選んでください");
    expect(w.find("textarea.editor").exists()).toBe(true);
    expect(w.find(".encoding select").exists()).toBe(true);
    expect(w.find(".encoding").text()).toContain("1208");
  });

  /** 削除・上書きと同じく、失われるものがあるなら確認する（review S1） */
  it("編集中に文字コードを変えるときは確認し、取り消したら読み直さない", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.txt")], hasMore: false, canContinue: false },
      read: { content: "本文", bytes: 6, encoding: "utf8", ccsid: 1208, detectedBy: "content" }
    });
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    await w.find("textarea.editor").setValue("編集した");
    await flushPromises();

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const select = w.find(".encoding select");
    (select.element as HTMLSelectElement).value = "37";
    await select.trigger("change");
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalled();
    // 読み直していない＝編集内容が残っている。選択の見た目も戻す
    expect((w.find("textarea.editor").element as HTMLTextAreaElement).value).toBe("編集した");
    expect((select.element as HTMLSelectElement).value).toBe("1208");
    confirmSpy.mockRestore();
  });

  it("採用した文字コードと根拠を出す", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.txt")], hasMore: false, canContinue: false },
      read: {
        content: "日本語",
        bytes: 9,
        encoding: "utf8",
        ccsid: 1208,
        detectedBy: "content",
        newline: "lf",
        bom: false,
        tagCcsid: 850
      }
    });
    await w.findAll("li")[0]?.trigger("click");
    await flushPromises();
    // 「中身から判定した」ことと「タグは別物」が両方見えること（research F4 の状況）
    expect(w.find(".encoding").text()).toContain("1208");
    expect(w.find(".encoding").text()).toContain("内容から判定");
    expect(w.find(".encoding").text()).toContain("850");
  });

  it("文字コードを選び直すと、その CCSID で読み直す", async () => {
    const sent: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "read") sent.push(JSON.parse(String(init?.body)));
      const body =
        route === "list"
          ? { entries: [entry("a.txt")], hasMore: false, canContinue: false }
          : sent.length > 1
            ? { content: "ABC", bytes: 3, encoding: "utf8", ccsid: 273, detectedBy: "manual" }
            : { content: null, bytes: 3, encoding: null, code: "UNSUPPORTED_ENCODING" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();

    const select = w.find(".encoding select");
    (select.element as HTMLSelectElement).value = "273";
    await select.trigger("change");
    await flushPromises();

    expect(sent[1]).toMatchObject({ path: "/a.txt", ccsid: 273 });
    expect(w.find("textarea.editor").exists()).toBe(true);
    expect(w.find(".encoding").text()).toContain("手動");
  });
});

describe("上位フォルダへ", () => {
  it("ルートでは出さない（押せない行を残さない）", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.txt")], hasMore: false, canContinue: false }
    });
    expect(w.find(".entries li.up").exists()).toBe(false);
  });

  it("フォルダを開くと先頭に出て、押すと 1 つ上へ戻る", async () => {
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as { path: string };
      if (route === "list") asked.push(body.path);
      return new Response(
        JSON.stringify({
          entries: body.path === "/" ? [entry("dir", { isDirectory: true })] : [entry("a.txt")],
          hasMore: false,
          canContinue: false
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    // フォルダへ入る
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    const up = w.find(".entries li.up");
    expect(up.exists()).toBe(true);
    // 先頭行であること（一覧の中身より前）
    expect(w.findAll(".entries li")[0]?.classes()).toContain("up");

    expect(asked).toContain("/dir");

    await up.trigger("click");
    await flushPromises();
    expect(w.find(".crumbs").text()).toBe("/");
    expect(w.find(".entries li.up").exists()).toBe(false);
  });

  it("キーボード（Enter）でも戻れる", async () => {
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as { path: string };
      return new Response(
        JSON.stringify({
          entries:
            route === "list" && body.path === "/"
              ? [entry("dir", { isDirectory: true })]
              : [entry("a.txt")],
          hasMore: false,
          canContinue: false
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    await w.find(".entries li.up").trigger("keydown.enter");
    await flushPromises();
    expect(w.find(".crumbs").text()).toBe("/");
  });
});

describe("エラーの文言", () => {
  /** 「辿れない」と「大きすぎる」は別の話。利用者がすべきことが違う */
  it("一括ダウンロードで辿れないときは、個別取得を案内する", async () => {
    const w = await paneWith(
      {
        list: { entries: [entry("a")], hasMore: false, canContinue: false },
        zip: { error: "x", code: "INCOMPLETE_LISTING", path: "/QSYS.LIB" }
      },
      { zip: 409 }
    );
    await w.findAll("button").find((b) => b.text().includes("まとめて"))?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("個別に取得してください");
    expect(w.text()).toContain("/QSYS.LIB");
  });

  it("大きすぎるときは絞るよう案内する", async () => {
    const w = await paneWith(
      {
        list: { entries: [entry("a")], hasMore: false, canContinue: false },
        zip: { error: "x", code: "TOO_LARGE", files: 501, bytes: 9_000_000, partial: true }
      },
      { zip: 413 }
    );
    await w.findAll("button").find((b) => b.text().includes("まとめて"))?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("501 ファイル以上");
    expect(w.text()).toContain("対象を絞る");
  });

  it("フォルダ数の超過は別の文言にする", async () => {
    const w = await paneWith(
      {
        list: { entries: [entry("a")], hasMore: false, canContinue: false },
        zip: { error: "x", code: "TOO_MANY_DIRECTORIES", directories: 5001 }
      },
      { zip: 413 }
    );
    await w.findAll("button").find((b) => b.text().includes("まとめて"))?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("フォルダの数が多すぎます");
  });
});

/**
 * **今回初めて書いた操作系**。review で「まるごとテストの外」と指摘された箇所。
 * 変異が軒並み素通りしていたので、ここで固定する。
 */
describe("操作系", () => {
  /** クリックしたフォルダを開く。ここが壊れるとフォルダをプレビューしにいく */
  it("フォルダをクリックすると開く（プレビューしない）", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      calls.push(`${route} ${JSON.parse(String(init?.body)).path}`);
      return new Response(
        JSON.stringify({ entries: [entry("sub", { isDirectory: true })], hasMore: false, canContinue: false }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    // 一覧を取りに行き、read は呼ばない
    expect(calls).toContain("list /sub");
    expect(calls.some((c) => c.startsWith("read"))).toBe(false);
  });

  /** 選んだファイルを落とす。ここが壊れると別のファイルが降る */
  it("ダウンロードは選択中のファイルを対象にする", async () => {
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as { path: string };
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("a.txt"), entry("b.txt")], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      asked.push(`${route} ${body.path}`);
      if (route === "read") {
        return new Response(JSON.stringify({ content: "x", bytes: 1, encoding: "utf8" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;
    URL.createObjectURL = vi.fn(() => "blob:x") as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    // 2 件目を選ぶ
    await w.findAll(".entries li")[1]?.trigger("click");
    await flushPromises();
    await w.findAll(".actions button").find((b) => b.text().includes("ダウンロード"))?.trigger("click");
    await flushPromises();
    expect(asked).toContain("download /b.txt");
    expect(asked).not.toContain("download /a.txt");
  });

  /** プレビューに失敗しても操作は残す（「大きすぎるのでダウンロードを」の直後に手段が消えない） */
  it("プレビューが失敗してもダウンロード手段を残す", async () => {
    const w = await paneWith(
      {
        list: { entries: [entry("big.txt")], hasMore: false, canContinue: false },
        read: { error: "ファイルが大きすぎます", code: "TOO_LARGE" }
      },
      { read: 413 }
    );
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("大きすぎます");
    expect(w.findAll(".actions button").some((b) => b.text().includes("ダウンロード"))).toBe(true);
  });
});

/**
 * **システムを切り替えたら見えているものを捨てる。**
 * 捨てないと、ヘッダーは新しいシステムなのに一覧は前のシステムのまま、
 * 次の削除や上書きが**別システムのファイルに飛ぶ**。
 */
describe("システムの切り替え", () => {
  it("切り替えたら一覧と選択を捨てる", async () => {
    const w = await paneWith({
      list: { entries: [entry("only-on-s.txt")], hasMore: false, canContinue: false }
    });
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("only-on-s.txt");

    systemsStore.selected = "srv:other";
    await flushPromises();
    expect(w.text()).not.toContain("only-on-s.txt");
  });
});

describe("アップロード", () => {
  /**
   * 1 件の失敗を全体の成功で消さない（利用者が「一部置けていない」に気づけるように）。
   *
   * 送信は 1 要求にまとめる（`upload`）ので、**部分的な失敗はサーバーの `failed` で返る**——
   * HTTP がエラーになるわけではない。ここを「200 なら全部成功」と読むと、
   * 置けていないファイルを黙って成功と表示してしまう
   */
  it("一部が失敗したら、成功と失敗の両方を伝える", async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(JSON.stringify({ entries: [], hasMore: false, canContinue: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({
          directories: 0,
          files: 1,
          bytes: 3,
          failed: [{ path: "ng.txt", error: "権限がありません", code: "ACCESS_DENIED" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const input = w.find('input[type="file"]').element as HTMLInputElement;
    const files = [
      new File([new Uint8Array([1])], "ng.txt"),
      new File([new Uint8Array([2])], "ok.txt")
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await w.find('input[type="file"]').trigger("change");
    await flushPromises();

    expect(w.text()).toContain("1 件失敗");
    expect(w.text()).toContain("ng.txt");
    expect(w.text()).toContain("1 件置きました");
  });

  /**
   * 一覧が最後まで読めていないと、未取得ページに同名があっても気づけない。
   * **黙って上書きしない**——確認できないことを伝える。
   */
  it("一覧が不完全なら、上書きの可能性を伝えて確認する", async () => {
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("a")], hasMore: true, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ bytes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const confirm = vi.spyOn(window, "confirm").mockImplementation((m?: string) => {
      asked.push(String(m));
      return false; // キャンセルする
    });

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const input = w.find('input[type="file"]').element as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array([1])], "new.txt")],
      configurable: true
    });
    await w.find('input[type="file"]').trigger("change");
    await flushPromises();

    expect(asked[0]).toContain("上書きする可能性");
    // キャンセルしたので書き込まない
    expect(w.text()).not.toContain("置きました");
    confirm.mockRestore();
  });
});

/**
 * フォルダのアップロード。
 *
 * **階層は相対パスで表す**（`webkitRelativePath` の形）。中間フォルダを作り忘れると
 * 深いファイルが `NOT_FOUND` で落ちるので、**送る本文の中に directory 項目が
 * 揃っているか**を見る（画面の文言だけでは、木が半分しか上がらなくても緑になる）。
 */
describe("フォルダのアップロード", () => {
  /** upload の本文を捕まえる偽 fetch */
  function captureUpload() {
    const sent: {
      base: string;
      dirs: string[];
      files: string[];
    }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(JSON.stringify({ entries: [], hasMore: false, canContinue: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        base: string;
        entries: { kind: string; path: string }[];
      };
      sent.push({
        base: body.base,
        dirs: body.entries.filter((e) => e.kind === "directory").map((e) => e.path).sort(),
        files: body.entries.filter((e) => e.kind === "file").map((e) => e.path)
      });
      return new Response(
        JSON.stringify({ directories: sent[0]?.dirs.length ?? 0, files: 1, bytes: 1, failed: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    return sent;
  }

  const picked = (path: string) => ({
    path,
    file: new File([new Uint8Array([1])], path.split("/").pop() ?? path)
  });
  type Pane = {
    uploadPicked(p: { path: string; file: File }[], dirs: string[]): Promise<void>;
  };

  it("中間フォルダも作る（深いファイルが親無しで落ちないように）", async () => {
    const sent = captureUpload();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();

    await (w.vm as unknown as Pane).uploadPicked(
      [picked("TOP/a.txt"), picked("TOP/sub/deep/b.txt")],
      []
    );
    await flushPromises();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.dirs).toEqual(["TOP", "TOP/sub", "TOP/sub/deep"]);
    expect(sent[0]?.files).toEqual(["TOP/a.txt", "TOP/sub/deep/b.txt"]);
    confirm.mockRestore();
  });

  /** 木の中の同名を 1 件ずつ聞くと、深いフォルダで確認が終わらない */
  it("確認は木ごとに 1 回だけ", async () => {
    captureUpload();
    const asked: string[] = [];
    const confirm = vi.spyOn(window, "confirm").mockImplementation((m?: string) => {
      asked.push(String(m));
      return true;
    });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();

    await (w.vm as unknown as Pane).uploadPicked(
      [picked("TOP/a.txt"), picked("TOP/b.txt"), picked("TOP/c.txt")],
      []
    );
    await flushPromises();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("TOP");
    confirm.mockRestore();
  });

  it("キャンセルしたら 1 件も送らない", async () => {
    const sent = captureUpload();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();

    await (w.vm as unknown as Pane).uploadPicked([picked("TOP/a.txt")], []);
    await flushPromises();

    expect(sent).toHaveLength(0);
    confirm.mockRestore();
  });

  /** 中身が無くてもフォルダは作る（ドロップで辿ったときだけ分かる） */
  it("空のフォルダも作る", async () => {
    const sent = captureUpload();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();

    await (w.vm as unknown as Pane).uploadPicked([picked("TOP/a.txt")], ["TOP", "TOP/empty"]);
    await flushPromises();

    expect(sent[0]?.dirs).toEqual(["TOP", "TOP/empty"]);
    confirm.mockRestore();
  });
});

/**
 * ドロップされたフォルダの走査。
 *
 * **`readEntries` は一度に最大 100 件しか返さない**（仕様）。空が返るまで繰り返さないと、
 * 100 件を超えるフォルダが静かに途中までしか上がらない——**画面上は成功に見える**ので、
 * ここを見ていないと気づけない。
 */
describe("フォルダのドロップ", () => {
  /** `webkitGetAsEntry` が返す木を模す。`readEntries` は 100 件ずつ返す */
  function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
    return {
      name,
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let at = 0;
        return {
          readEntries: (cb: (e: FileSystemEntry[]) => void) => {
            const batch = children.slice(at, at + 100);
            at += batch.length;
            cb(batch);
          }
        };
      }
    } as unknown as FileSystemEntry;
  }
  function fileEntry(name: string): FileSystemEntry {
    return {
      name,
      isFile: true,
      isDirectory: false,
      file: (cb: (f: File) => void) => cb(new File([new Uint8Array([1])], name))
    } as unknown as FileSystemEntry;
  }

  it("100 件を超えるフォルダを取りこぼさない", async () => {
    const sent: { files: string[] } = { files: [] };
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(JSON.stringify({ entries: [], hasMore: false, canContinue: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body)) as { entries: { kind: string; path: string }[] };
      sent.files = body.entries.filter((e) => e.kind === "file").map((e) => e.path);
      return new Response(JSON.stringify({ directories: 1, files: sent.files.length, bytes: 1, failed: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();

    const children = Array.from({ length: 150 }, (_, i) => fileEntry(`f${i}.txt`));
    const root = dirEntry("BIG", children);
    await w.find(".ifs").trigger("drop", {
      dataTransfer: {
        types: ["Files"],
        items: [{ kind: "file", webkitGetAsEntry: () => root }],
        files: []
      }
    });
    await flushPromises();

    expect(sent.files).toHaveLength(150);
    expect(sent.files[0]).toBe("BIG/f0.txt");
    expect(sent.files[149]).toBe("BIG/f149.txt");
    confirm.mockRestore();
  });
});

/**
 * **符号化そのものを検証する。**
 *
 * 画面の文言だけを見るテストでは、base64 をやめても `encoding` を間違えても素通りした
 * （review RM4）。`<input>` 経由だと jsdom が `FileList` の挙動を再現しないので、
 * `uploadFiles` を直接叩いて**要求本文**を確かめる。
 */
describe("アップロードの符号化", () => {
  async function upload(bytes: Uint8Array, name = "b.bin") {
    // Uint8Array をそのまま BlobPart に渡せないので Blob に包む
    const part = new Blob([new Uint8Array(bytes)]);
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(JSON.stringify({ entries: [], hasMore: false, canContinue: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ directories: 0, files: 1, bytes: bytes.length, failed: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await (w.vm as unknown as { uploadFiles(f: File[]): Promise<void> }).uploadFiles([
      new File([part], name)
    ]);
    await flushPromises();
    return sent;
  }

  /** 送った本文から、最初のファイル項目を取り出す */
  const fileEntry = (body: Record<string, unknown> | undefined) =>
    (body?.["entries"] as { kind: string; path: string; content?: string }[] | undefined)?.find(
      (e) => e.kind === "file"
    );

  it("バイト列を base64 にして base64 として送る", async () => {
    // 0x00 / 0x7f / 0x80 / 0xff — utf8 として送ると壊れる並び
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
    const sent = await upload(bytes);
    // 置き先は base（絶対）＋ 項目の相対パス。**base に置き場が入る**
    expect(sent[0]).toMatchObject({ base: "/" });
    expect(fileEntry(sent[0])).toEqual({
      kind: "file",
      path: "b.bin",
      content: Buffer.from(bytes).toString("base64")
    });
  });

  it("全 256 バイト値が欠けずに載る", async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const sent = await upload(bytes);
    const back = new Uint8Array(Buffer.from(String(fileEntry(sent[0])?.content), "base64"));
    expect(back).toEqual(bytes);
  });
});

/**
 * ツリー。**今回新しく足した機能の中心なのにテストが 1 件も無かった**（review N1、変異 0/7 捕捉）。
 */
describe("ツリー", () => {
  /** パスごとに応答を返す偽 fetch */
  function treeFetch(tree: Record<string, string[]>) {
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as { path: string };
      if (route !== "list") {
        return new Response(JSON.stringify({ content: "x", bytes: 1, encoding: "utf8" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      asked.push(body.path);
      const names = tree[body.path] ?? [];
      return new Response(
        JSON.stringify({
          entries: names.map((n) =>
            n.endsWith("/") ? entry(n.slice(0, -1), { isDirectory: true }) : entry(n)
          ),
          hasMore: false,
          canContinue: false
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    return asked;
  }

  it("フォルダだけを並べ、ファイルは出さない", async () => {
    treeFetch({ "/": ["home/", "a.txt"] });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const rows = w.findAll(".tree-row").map((r) => r.text());
    expect(rows.some((r) => r.includes("home"))).toBe(true);
    expect(rows.some((r) => r.includes("a.txt"))).toBe(false);
  });

  it("展開すると子が増え、深さが付く", async () => {
    treeFetch({ "/": ["home/"], "/home": ["sub/"] });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const before = w.findAll(".tree-row").length;

    // ルートのキャレットは無効なので、名前で行を選ぶ
    // （`attributes("disabled")` は空文字を返すため、真偽で選ぶと取り違える）
    await w
      .findAll(".tree-row")
      .find((r) => r.text().includes("home"))
      ?.find(".caret")
      .trigger("click");
    await flushPromises();

    const rows = w.findAll(".tree-row");
    expect(rows.length).toBeGreaterThan(before);
    // 子はインデントが深い
    const pads = rows.map((r) => r.attributes("style") ?? "");
    expect(new Set(pads).size).toBeGreaterThan(1);
  });

  /** パスをキーにしているので、別階層の同名フォルダが混ざらない */
  it("同名フォルダが階層違いで共存する", async () => {
    treeFetch({ "/": ["home/", "tmp/"], "/home": ["sub/"], "/tmp": ["sub/"] });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    for (const name of ["home", "tmp"]) {
      const caret = w
        .findAll(".tree-row")
        .find((r) => r.text().includes(name))
        ?.find(".caret");
      await caret?.trigger("click");
      await flushPromises();
    }
    const subs = w.findAll(".tree-row").filter((r) => r.text().includes("sub"));
    expect(subs.length).toBe(2);
  });

  it("名前を押すと一覧がそこへ移る", async () => {
    const asked = treeFetch({ "/": ["home/"], "/home": ["x.txt"] });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w
      .findAll(".tree-row")
      .find((r) => r.text().includes("home"))
      ?.find(".tree-name")
      .trigger("click");
    await flushPromises();
    expect(asked).toContain("/home");
    expect(w.text()).toContain("x.txt");
  });

  /** 既に開いているフォルダを名前で押しても畳まない（畳むと移動手段が無くなる） */
  it("開いているフォルダへ名前で移動しても畳まない", async () => {
    treeFetch({ "/": ["home/"], "/home": ["x.txt"] });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const row = () => w.findAll(".tree-row").find((r) => r.text().includes("home"));
    await row()?.find(".caret").trigger("click");
    await flushPromises();
    expect(row()?.text()).toContain("▾");
    await row()?.find(".tree-name").trigger("click");
    await flushPromises();
    expect(row()?.text()).toContain("▾");
  });

  /** 一覧を降りると、ツリーが現在地を示し、祖先が開く（RS1） */
  it("一覧を降りるとツリーに現在地が出る", async () => {
    treeFetch({ "/": ["home/"], "/home": ["USER/"], "/home/USER": ["x.txt"] });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li").find((li) => li.text().includes("home"))?.trigger("click");
    await flushPromises();
    // 2 階層目は先頭が「上位フォルダへ」なので、**名前で選ぶ**
    await w.findAll(".entries li").find((li) => li.text().includes("USER"))?.trigger("click");
    await flushPromises();
    const sel = w.findAll(".tree-row.sel");
    expect(sel.length).toBe(1);
    expect(sel[0]?.attributes("data-path")).toBe("/home/USER");
    // 祖先が開いている
    expect(w.findAll(".tree-row").map((r) => r.attributes("data-path"))).toContain("/home");
  });

  /** ルートは畳めないので、開閉不可・aria-expanded を付けない（RS3） */
  it("ルート行は開閉不可で aria-expanded を持たない", async () => {
    treeFetch({ "/": ["home/"] });
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const caret = w.find('.tree-row[data-path="/"] .caret');
    expect(caret.attributes("disabled")).toBeDefined();
    expect(caret.attributes("aria-expanded")).toBeUndefined();
  });
});

/**
 * **アップロード中にシステムを切り替えても、残りが別システムへ飛ばない。**
 *
 * watch は「見えているものを捨てる」だけで進行中の操作を止めない。
 * ループが 1 件ごとに `source()` / `currentPath` を評価していると、
 * 残りが**新システムのルート**に書かれる（review RM2）。
 * 守ろうとした事故を、その watch 自身が起こせる形になっていた。
 */
describe("アップロード中のシステム切り替え", () => {
  it("開始時のシステムとパスに固定される", async () => {
    const sent: { system: unknown; base: unknown; paths: string[] }[] = [];
    let firstWrite: (() => void) | undefined;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as {
        source: { system?: string };
        base: string;
        entries: { kind: string; path: string }[];
      };
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("sub", { isDirectory: true })], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      sent.push({
        system: body.source.system,
        base: body.base,
        paths: body.entries.filter((e) => e.kind === "file").map((e) => e.path)
      });
      // 応答を保留して、その隙にシステムを切り替える
      await new Promise<void>((r) => {
        firstWrite = r;
      });
      return new Response(JSON.stringify({ directories: 0, files: 2, bytes: 2, failed: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    // /sub へ移動してからアップロードを始める
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();

    const vm = w.vm as unknown as { uploadFiles(f: File[]): Promise<void> };
    const running = vm.uploadFiles([
      new File([new Uint8Array([1])], "one.txt"),
      new File([new Uint8Array([2])], "two.txt")
    ]);
    await flushPromises();

    // 送信の途中でシステムを切り替える
    systemsStore.selected = "srv:other";
    await flushPromises();
    firstWrite?.();
    await running;
    await flushPromises();

    // **開始時**のシステムとフォルダに送られる（切り替えても行き先は変わらない）
    expect(sent).toHaveLength(1);
    expect(sent[0]?.system).toBe("srv:s");
    expect(sent[0]?.base).toBe("/sub");
    expect(sent[0]?.paths).toEqual(["one.txt", "two.txt"]);
  });
});

/**
 * **操作中は操作を止める。** S2 → RM3 で 2 度直した不変条件だが、
 * 「`disabled` computed が実際にボタンを不活性にする」ことを見るテストが無かった（review QM1）。
 * 別経路が生えて `disabled` が抜けても緑のままだった。
 */
describe("操作中の禁止", () => {
  /** 応答を保留して `busy` を立てたまま観測する */
  function pendingList() {
    let release: (() => void) | undefined;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return new Response(JSON.stringify({ entries: [], hasMore: false, canContinue: false }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    return () => release?.();
  }

  it("通信中はヘッダーとツリーのボタンが disabled になる", async () => {
    const release = pendingList();
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    // 初回 list を保留したまま（busy = true）
    await flushPromises();

    const headerButtons = w.findAll("header button");
    expect(headerButtons.length).toBeGreaterThan(0);
    expect(headerButtons.every((b) => b.attributes("disabled") !== undefined)).toBe(true);

    // 解放すると戻る
    release();
    await flushPromises();
    expect(w.findAll("header button").every((b) => b.attributes("disabled") !== undefined)).toBe(
      false
    );
  });
});

describe("アップロードの後始末（別システムへ飛ばさない）", () => {
  /** 切替後は、新システムの画面に結果を出さない・新システムへ list を飛ばさない（review QS1） */
  it("アップロード中に切り替えたら、新システムに触れない", async () => {
    const listed: string[] = [];
    let firstWrite: (() => void) | undefined;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as { source: { system?: string }; path: string };
      if (route === "list") {
        listed.push(`${body.source.system} ${body.path}`);
        return new Response(JSON.stringify({ entries: [], hasMore: false, canContinue: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (!firstWrite) {
        await new Promise<void>((r) => {
          firstWrite = r;
        });
      }
      return new Response(JSON.stringify({ bytes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    listed.length = 0; // 初回 list を除く

    const vm = w.vm as unknown as { uploadFiles(f: File[]): Promise<void> };
    const running = vm.uploadFiles([new File([new Blob([new Uint8Array([1])])], "one.txt")]);
    await flushPromises();

    systemsStore.selected = "srv:other";
    await flushPromises();
    firstWrite?.();
    await running;
    await flushPromises();

    // 新システム（srv:other）に対する list が飛んでいない
    expect(listed.every((l) => !l.startsWith("srv:other"))).toBe(true);
    // 「置きました」を新しい画面に出さない
    expect(w.text()).not.toContain("置きました");
    expect(w.text()).toContain("切り替えた");
  });
});

describe("上書き確認", () => {
  /** 読み込み済みで同名がある——最も普通の上書き経路（review QS2 / spec 226 の中心） */
  it("読み込み済みで同名があれば上書きを確認する", async () => {
    let wrote = false;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("dup.txt")], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      wrote = true;
      return new Response(JSON.stringify({ bytes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); // キャンセル

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const vm = w.vm as unknown as { uploadFiles(f: File[]): Promise<void> };
    await vm.uploadFiles([new File([new Blob([new Uint8Array([1])])], "dup.txt")]);
    await flushPromises();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("上書き"));
    expect(wrote).toBe(false); // キャンセルしたので書かない
    confirm.mockRestore();
  });

  /** 二重起動を止める（ドロップ連打で 2 つのループが並走しない） */
  it("アップロード中の再起動を無視する", async () => {
    let release: (() => void) | undefined;
    let writes = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(JSON.stringify({ entries: [], hasMore: false, canContinue: false }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      writes++;
      await new Promise<void>((r) => {
        release = r;
      });
      return new Response(JSON.stringify({ bytes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    const vm = w.vm as unknown as { uploadFiles(f: File[]): Promise<void> };
    const first = vm.uploadFiles([new File([new Blob([new Uint8Array([1])])], "a.txt")]);
    await flushPromises();
    // 進行中にもう一度呼ぶ
    await vm.uploadFiles([new File([new Blob([new Uint8Array([2])])], "b.txt")]);
    release?.();
    await first;
    await flushPromises();
    // 2 回目は無視される（書き込みは 1 回だけ）
    expect(writes).toBe(1);
  });
});

/**
 * テキストの編集・保存。spec の受け入れ基準の一部（当初 backlog 予定だったが実装した）。
 *
 * **復号できたテキストに限る。** 復号できないファイルを編集させると、
 * 文字列として持てない中身を書き戻して元ファイルを壊す。
 * 保存は**読んだときの文字コード・行末・BOM のまま**返す（UTF-8 に化けさせない）。
 */
describe("編集・保存", () => {
  /** テキストを開いて編集し、保存が書き込みまで届くことを本文で確かめる */
  it("編集した内容が UTF-8 で書き戻される", async () => {
    const sent: { path: string; content: string; encoding: string }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("note.txt")], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (route === "read") {
        return new Response(JSON.stringify({ content: "元の中身", bytes: 12, encoding: "utf8" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      sent.push(body as { path: string; content: string; encoding: string });
      return new Response(JSON.stringify({ bytes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();

    await w.find("textarea.editor").setValue("書き換えた中身");
    await flushPromises();
    await w.findAll(".actions button").find((b) => b.text() === "保存")?.trigger("click");
    await flushPromises();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      path: "/note.txt",
      content: "書き換えた中身",
      encoding: "utf8"
    });
  });

  /** EBCDIC で読んだファイルは、EBCDIC のまま書き戻す（UTF-8 に化けさせない） */
  it("読んだときの文字コード・行末・BOM を保存要求に載せる", async () => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("src.rpgle")], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (route === "read") {
        return new Response(
          JSON.stringify({
            content: "行1\n行2\n",
            bytes: 10,
            encoding: "utf8",
            ccsid: 1399,
            detectedBy: "tag",
            newline: "nel",
            bom: false,
            tagCcsid: 1399
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ bytes: 12, substituted: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    await w.find("textarea.editor").setValue("行1\n書き換え\n");
    await flushPromises();
    await w.findAll(".actions button").find((b) => b.text() === "保存")?.trigger("click");
    await flushPromises();

    expect(sent[0]).toMatchObject({ ccsid: 1399, newline: "nel", bom: false });
    // 置換が起きたことを黙らせない
    expect(w.text()).toContain("2 文字");
  });

  /** 読めても書けない文字コード（Shift_JIS 系）は編集させない */
  it("読み取り専用の文字コードでは編集させない", async () => {
    const w = await paneWith({
      list: { entries: [entry("sjis.txt")], hasMore: false, canContinue: false },
      read: { content: "あいう", bytes: 6, encoding: "utf8", ccsid: 943, detectedBy: "manual" }
    });
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    expect(w.text()).toContain("読み取り専用");
    expect(w.find("textarea.editor").attributes("readonly")).toBeDefined();
  });

  /** 変更していないなら保存しない（無駄な書き込みをしない） */
  it("編集していなければ書き込まない", async () => {
    let wrote = false;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("a.txt")], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (route === "read") {
        return new Response(JSON.stringify({ content: "x", bytes: 1, encoding: "utf8" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      wrote = true;
      return new Response(JSON.stringify({ bytes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    await (w.vm as unknown as { saveText(): Promise<void> }).saveText();
    expect(wrote).toBe(false);
  });

  /**
   * 復号できないファイルは編集の土台が無い。textarea も保存ボタンも出さず、
   * `saveText` を直接叩いても書き込まない（`editable` の二重防御）。
   */
  it("復号できないファイルは編集させない", async () => {
    let wrote = false;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "list") {
        return new Response(
          JSON.stringify({ entries: [entry("ebcdic.txt")], hasMore: false, canContinue: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (route === "read") {
        return new Response(
          JSON.stringify({ content: null, bytes: 3, encoding: null, code: "UNSUPPORTED_ENCODING" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      wrote = true;
      return new Response(JSON.stringify({ bytes: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    // 編集 UI を出さない
    expect(w.find("textarea.editor").exists()).toBe(false);
    expect(w.findAll(".actions button").some((b) => b.text() === "保存")).toBe(false);
  });

  /** 編集して初めて保存ボタンが出る */
  it("編集するまで保存ボタンを出さない", async () => {
    const w = await paneWith({
      list: { entries: [entry("a.txt")], hasMore: false, canContinue: false },
      read: { content: "hello", bytes: 5, encoding: "utf8" }
    });
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    expect(w.findAll(".actions button").some((b) => b.text() === "保存")).toBe(false);

    await w.find("textarea.editor").setValue("changed");
    await flushPromises();
    expect(w.findAll(".actions button").some((b) => b.text() === "保存")).toBe(true);
  });
});

/**
 * 削除と名前の変更。**フォルダは「…」で開かずに選ぶ**——
 * クリック＝開く（移動）は毎日使う操作なので変えない。
 */
describe("削除・名前の変更", () => {
  const listWith = (entries: unknown[]) => ({ entries, hasMore: false, canContinue: false });

  it("フォルダ行の「…」で開かずに選べる（移動しない）", async () => {
    const asked: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      const body = JSON.parse(String(init?.body)) as { path: string };
      if (route === "list") asked.push(body.path);
      return new Response(JSON.stringify(listWith([entry("sub", { isDirectory: true })])), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.find(".entries li .pick").trigger("click");
    await flushPromises();

    expect(asked).toEqual(["/"]); // 移動していない
    expect(w.find(".crumbs").text()).toBe("/");
    expect(w.text()).toContain("フォルダを選択中");
    // フォルダには「ダウンロード」を出さない（一括は上のボタン）
    const actions = w.findAll(".actions button").map((b) => b.text());
    expect(actions).toContain("名前の変更");
    expect(actions).toContain("削除");
    expect(actions).not.toContain("ダウンロード");
  });

  it("フォルダの削除は、先に件数を数えてから確認する", async () => {
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      posted.push(route);
      const body =
        route === "list"
          ? listWith([entry("sub", { isDirectory: true })])
          : route === "delete-plan"
            ? { files: 3, directories: 2, entries: 5 }
            : { files: 3, directories: 2 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.find(".entries li .pick").trigger("click");
    await flushPromises();
    await w.findAll(".actions button").find((b) => b.text() === "削除")?.trigger("click");
    await flushPromises();

    // 数えてから消す
    expect(posted.filter((r) => r === "delete-plan" || r === "delete")).toEqual([
      "delete-plan",
      "delete"
    ]);
    // 確認の文言に件数が出る
    expect(confirmSpy.mock.calls[0]?.[0]).toContain("ファイル 3 件");
    expect(w.text()).toContain("削除しました");
    confirmSpy.mockRestore();
  });

  it("上限を超えるフォルダは数えた時点で断る（削除要求を出さない）", async () => {
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      posted.push(route);
      const body =
        route === "list"
          ? listWith([entry("sub", { isDirectory: true })])
          : { blocked: "too-many", code: "TOO_MANY", entries: 1001, max: 1000 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.find(".entries li .pick").trigger("click");
    await flushPromises();
    await w.findAll(".actions button").find((b) => b.text() === "削除")?.trigger("click");
    await flushPromises();

    expect(posted).not.toContain("delete");
    expect(w.find(".error").text()).toContain("多すぎます");
  });

  it("名前の変更は新しい名前を送り、一覧を取り直す", async () => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const route = String(url).replace("/api/host/ifs/", "");
      if (route === "rename") sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify(route === "list" ? listWith([entry("a.txt")]) : { path: "/b.txt" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("b.txt");

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    await w.findAll(".actions button").find((b) => b.text() === "名前の変更")?.trigger("click");
    await flushPromises();

    expect(sent[0]).toMatchObject({ path: "/a.txt", newName: "b.txt" });
    expect(w.text()).toContain("に変更しました");
    promptSpy.mockRestore();
  });

  it("パス区切りを含む名前は往復させずに断る", async () => {
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const route = String(url).replace("/api/host/ifs/", "");
      posted.push(route);
      return new Response(JSON.stringify(listWith([entry("a.txt")])), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("../b.txt");

    const w = mount(IfsPane, { props: { tabId: "ifs:files" } });
    await flushPromises();
    await w.findAll(".entries li")[0]?.trigger("click");
    await flushPromises();
    await w.findAll(".actions button").find((b) => b.text() === "名前の変更")?.trigger("click");
    await flushPromises();

    expect(posted).not.toContain("rename");
    expect(w.find(".error").text()).toContain("パス区切り");
    promptSpy.mockRestore();
  });
});
