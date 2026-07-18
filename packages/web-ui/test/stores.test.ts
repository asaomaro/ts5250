import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { workspaceStore } from "../src/stores/workspace.js";
import { logStore, maskOutgoing } from "../src/stores/log.js";
import { connectionsStore } from "../src/stores/connections.js";

describe("workspaceStore 分割ツリー", () => {
  beforeEach(() => workspaceStore.init());

  it("セッションをフォーカスグループのタブとして追加する", () => {
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    const g = workspaceStore.focusedGroup();
    expect(g.tabs).toEqual(["s1", "s2"]);
    expect(g.activeTab).toBe("s2");
    expect(workspaceStore.groups()).toHaveLength(1);
  });

  it("cycleTab でフォーカスグループのアクティブタブを循環する", () => {
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.addSession("s3"); // activeTab = s3
    workspaceStore.cycleTab(1); // s3 → 先頭へラップ = s1
    expect(workspaceStore.focusedGroup().activeTab).toBe("s1");
    workspaceStore.cycleTab(-1); // s1 → 末尾へラップ = s3
    expect(workspaceStore.focusedGroup().activeTab).toBe("s3");
    workspaceStore.cycleTab(-1); // s3 → s2
    expect(workspaceStore.focusedGroup().activeTab).toBe("s2");
  });

  it("cycleTab はタブが 1 つ以下なら無操作", () => {
    workspaceStore.addSession("s1");
    workspaceStore.cycleTab(1);
    expect(workspaceStore.focusedGroup().activeTab).toBe("s1");
  });

  it("dropTabInto でグループ内タブを並び替える（除外配列での挿入位置）", () => {
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.addSession("s3"); // [s1, s2, s3]
    const g = workspaceStore.focusedGroup();
    // s1 を末尾へ（除外配列 [s2,s3] の index 2）
    workspaceStore.dropTabInto(g.id, "s1", 2);
    expect(workspaceStore.focusedGroup().tabs).toEqual(["s2", "s3", "s1"]);
    expect(workspaceStore.focusedGroup().activeTab).toBe("s1"); // 並び替えたタブがアクティブ
    // s3 を先頭へ（除外配列 [s2,s1] の index 0）
    workspaceStore.dropTabInto(g.id, "s3", 0);
    expect(workspaceStore.focusedGroup().tabs).toEqual(["s3", "s2", "s1"]);
  });

  it("dropTabInto で別グループのタブを合流し、空になった元グループは片付く", () => {
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    const g0 = workspaceStore.focusedGroup();
    workspaceStore.split(g0.id, "right", "s2"); // s1 | s2 の 2 ペイン
    const [a, b] = workspaceStore.groups();
    // b の s2 を a の先頭へ合流 → b が空 → 片付けで単一グループに
    workspaceStore.dropTabInto(a!.id, "s2", 0);
    expect(workspaceStore.groups()).toHaveLength(1);
    expect(workspaceStore.groups()[0]!.tabs).toEqual(["s2", "s1"]);
    expect(workspaceStore.groups()[0]!.activeTab).toBe("s2");
  });

  it("split で分割ツリーになり新グループにフォーカスが移る", () => {
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    const g = workspaceStore.focusedGroup();
    workspaceStore.split(g.id, "right", "s2");
    expect(workspaceStore.root.type).toBe("split");
    expect(workspaceStore.groups()).toHaveLength(2);
    // s2 は新グループ、s1 は元グループ
    const groups = workspaceStore.groups();
    expect(groups.some((x) => x.tabs.includes("s1") && !x.tabs.includes("s2"))).toBe(true);
    expect(groups.some((x) => x.tabs.includes("s2") && !x.tabs.includes("s1"))).toBe(true);
  });

  it("moveTab でタブが別グループへ移り、空グループは片付く", () => {
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    const g0 = workspaceStore.focusedGroup();
    workspaceStore.split(g0.id, "right", "s2"); // s1|s2 の 2 グループ
    const [a, b] = workspaceStore.groups();
    workspaceStore.moveTab("s1", b!.id); // s1 を b に移す → a が空 → 片付け
    expect(workspaceStore.groups()).toHaveLength(1);
    expect(workspaceStore.groups()[0]!.tabs.sort()).toEqual(["s1", "s2"]);
  });

  it("closeSession で全部閉じると単一空グループに戻る", () => {
    workspaceStore.addSession("s1");
    workspaceStore.closeSession("s1");
    expect(workspaceStore.groups()).toHaveLength(1);
    expect(workspaceStore.groups()[0]!.tabs).toEqual([]);
  });

  it("narrow 時は split が合流にフォールバックする", () => {
    workspaceStore.addSession("s1");
    workspaceStore.addSession("s2");
    workspaceStore.narrow = true;
    workspaceStore.split(workspaceStore.focusedGroup().id, "right", "s2");
    expect(workspaceStore.root.type).toBe("group"); // 分割されない
    workspaceStore.narrow = false;
  });
});

describe("logStore", () => {
  beforeEach(() => logStore.clear());

  it("エントリを追加し 500 件でリングバッファになる", () => {
    for (let i = 0; i < 520; i++) logStore.add({ ts: i, sessionId: "s", dir: "tx", kind: "key", summary: "" });
    expect(logStore.entries.length).toBe(500);
    expect(logStore.entries[0]!.ts).toBe(20); // 先頭 20 件が押し出された
  });

  it("JSONL 出力できる", () => {
    logStore.add({ ts: 1, sessionId: "s", dir: "rx", kind: "screen", summary: "24x80" });
    expect(logStore.toJsonl()).toContain('"kind":"screen"');
  });
});

describe("maskOutgoing", () => {
  it("hidden フィールドの値を伏字化する", () => {
    const msg = { type: "key", key: "Enter", fields: [{ field: 1, value: "USER" }, { field: 2, value: "SECRET" }] };
    const masked = maskOutgoing(msg, new Set([2])) as typeof msg;
    expect(masked.fields[0]!.value).toBe("USER");
    expect(masked.fields[1]!.value).toBe("●●●●");
  });
});

describe("connectionsStore（サーバー保存・API バックド）", () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let list: unknown[] = [];

  beforeEach(() => {
    calls.length = 0;
    list = [];
    connectionsStore.connections = [];
    connectionsStore.loaded = false;
    // fetch をモック（GET=一覧 / POST/PUT/DELETE=OK を返す）
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const method = init?.method ?? "GET";
      if (url === "/api/connections" && method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ connections: list }), { status: 200 }));
      }
      if (url === "/api/connections" && method === "POST") {
        const created = { id: "c-1", ...JSON.parse(String(init?.body)), hasSecret: true };
        list = [{ id: "c-1", name: created.name, host: created.host, sessionType: "display", hasSecret: true }];
        return Promise.resolve(new Response(JSON.stringify({ connection: created }), { status: 201 }));
      }
      if (method === "DELETE") {
        list = [];
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refresh でサーバーの一覧を反映する", async () => {
    list = [{ id: "c-9", name: "srv", host: "h", sessionType: "display", hasSecret: false }];
    await connectionsStore.refresh();
    expect(connectionsStore.connections.map((c) => c.name)).toEqual(["srv"]);
    expect(connectionsStore.loaded).toBe(true);
  });

  it("create はパスワードをサーバーへ送り、hasSecret を受け取る（クライアントは平文を保持しない）", async () => {
    const created = await connectionsStore.create({
      name: "pub", host: "pub400.com", sessionType: "display", autoSignon: true, signonUser: "USER", password: "secret"
    });
    expect(created.hasSecret).toBe(true);
    // クライアント側の一覧には平文もパスワードフィールドも含まれない
    expect(JSON.stringify(connectionsStore.connections)).not.toContain("secret");
    // POST 後に一覧を再取得している
    expect(calls.some((c) => (c.init?.method ?? "GET") === "POST")).toBe(true);
    expect(calls.filter((c) => (c.init?.method ?? "GET") === "GET").length).toBeGreaterThan(0);
  });

  it("remove はサーバーに削除要求し一覧を更新する", async () => {
    await connectionsStore.create({ name: "x", host: "h", sessionType: "display" });
    await connectionsStore.remove("c-1");
    expect(connectionsStore.connections).toHaveLength(0);
  });
});
