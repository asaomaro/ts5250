import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mount, flushPromises } from "@vue/test-utils";
import SqlPane from "../src/components/SqlPane.vue";
import IfsPane from "../src/components/IfsPane.vue";
import HostListPane from "../src/components/HostListPane.vue";
import SpoolPane from "../src/components/SpoolPane.vue";
import DtaqPane from "../src/components/DtaqPane.vue";
import TransferPane from "../src/components/TransferPane.vue";
import { systemsStore } from "../src/stores/systems.js";

/**
 * **ペインは自分のタブのシステムにしか要求を出さない**（`20260802-tabs-own-system`）。
 *
 * 以前はアプリ系ペインが 6 か所で `systemsStore.menuSystem`（アプリ全体で 1 つの値）を
 * 読んでいた。異なるシステムのタブを並べられるようにすると、これは
 * **画面に出ているシステムと要求の宛先が食い違う**——一覧にはジョブの終了、
 * IFS には削除があるので、見た目の問題では済まない。
 *
 * ここが守るのは 2 つ:
 *
 * 1. **宛先**——アプリ全体の選択を**わざと別の値**にした状態で操作し、
 *    要求の body に載るのが**そのタブのシステム**であること。
 *    画面の見た目ではなく**送信内容**を見る。ここを見ないとこの作業の目的は守れない。
 * 2. **撤去の完了**——ソースに `systemsStore.menuSystem` が 1 つも残っていないこと。
 *    1 か所でも残ると、そこだけ全体の値を見続ける。
 */

const MINE = "own:mine";
const DECOY = "own:decoy"; // アプリ全体の選択。**ここへ飛んだら不合格**

/** 送信された `source.system` を全部集める偽 fetch */
function captureFetch(reply: (url: string) => unknown = () => ({})): string[] {
  const sent: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (init?.body) {
      try {
        const body = JSON.parse(String(init.body)) as { source?: { system?: string } };
        if (body.source && "system" in body.source) sent.push(String(body.source.system));
      } catch { /* JSON でない body は対象外 */ }
    }
    return new Response(JSON.stringify(reply(u) ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return sent;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  systemsStore.systems = [
    { ref: MINE, name: "自分", host: "h", autoSignon: false },
    { ref: DECOY, name: "囮", host: "h", autoSignon: false }
  ];
  systemsStore.sessions = [];
  systemsStore.loaded = true;
  // **わざと別のシステムを選んでおく**。ペインがここを読んでいたら宛先が囮になる
  systemsStore.select(DECOY);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  systemsStore.systems = [];
  systemsStore.select(undefined);
  vi.restoreAllMocks();
});

/** 送った宛先がすべて自分のシステムであること（1 件も無ければ「叩けていない」） */
function expectAllMine(sent: string[]): void {
  expect(sent.length, "要求が 1 件も出ていない＝検査になっていない").toBeGreaterThan(0);
  expect([...new Set(sent)]).toEqual([MINE]);
}

describe("宛先はタブのシステム（全体の選択に引きずられない）", () => {
  it("SQL", async () => {
    const sent = captureFetch(() => ({ columns: [], rows: [], rowCount: 0 }));
    const w = mount(SqlPane, { props: { tabId: `sql:query@${MINE}`, system: MINE } });
    await w.find("textarea").setValue("SELECT 1");
    await w.find("header button").trigger("click");
    await flushPromises();
    expectAllMine(sent);
    w.unmount();
  });

  it("IFS", async () => {
    const sent = captureFetch((u) =>
      u.endsWith("/limits")
        ? { readMaxBytes: 1, zipMaxBytes: 1, zipMaxFiles: 1, zipMaxDirectories: 1, deleteMaxEntries: 1, deleteMaxDirectories: 1 }
        : { entries: [], hasMore: false, canContinue: false }
    );
    const w = mount(IfsPane, { props: { tabId: `ifs:files@${MINE}`, system: MINE } });
    await flushPromises();
    expectAllMine(sent);
    w.unmount();
  });

  it("一覧（ジョブ）", async () => {
    const sent = captureFetch(() => ({ items: [] }));
    const w = mount(HostListPane, { props: { tabId: `list:jobs@${MINE}`, system: MINE } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expectAllMine(sent);
    w.unmount();
  });

  it("スプール", async () => {
    const sent = captureFetch(() => ({ items: [], count: 0, truncated: false }));
    const w = mount(SpoolPane, { props: { tabId: `spool:files@${MINE}`, system: MINE } });
    await flushPromises();
    await w.find("header button").trigger("click");
    await flushPromises();
    expectAllMine(sent);
    w.unmount();
  });

  it("データ待ち行列", async () => {
    const sent = captureFetch(() => ({ ok: true }));
    const w = mount(DtaqPane, { props: { tabId: `dtaq:entries@${MINE}`, system: MINE } });
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("TESTLIB");
    await inputs[1]!.setValue("Q");
    await flushPromises();
    await w.find("textarea").setValue("hello");
    await w.findAll("button").find((b) => b.text() === "送信")!.trigger("click");
    await flushPromises();
    expectAllMine(sent);
    w.unmount();
  });

  it("データ転送", async () => {
    const sent = captureFetch(() => ({ columns: [], rows: [], rowCount: 0 }));
    const w = mount(TransferPane, { props: { tabId: `transfer:data@${MINE}`, system: MINE } });
    // 取得（ダウンロード）側へ切り替えて、ライブラリー／ファイルを埋めてから実行する
    const [dl] = w.findAll(".seg button");
    await dl!.trigger("click");
    const inputs = w.findAll("input");
    await inputs[0]!.setValue("TESTLIB");
    await inputs[1]!.setValue("T");
    await flushPromises();
    // **`.go` で指す。** 文字で探すと方向切替の「↓ 取得」に当たって何も起きない（実際に踏んだ）
    await w.find("button.go").trigger("click");
    await flushPromises();
    expectAllMine(sent);
    w.unmount();
  });
});

describe("撤去の完了", () => {
  /** cwd はランナーの起動位置で変わる（workspace 単位 / リポジトリ直下）ので両方見る */
  function src(rel: string): string {
    return readFileSync(existsSync(rel) ? rel : `packages/web-ui/${rel}`, "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("**アプリ系ペインに `systemsStore.menuSystem` が残っていない**", () => {
    const panes = ["SqlPane", "IfsPane", "HostListPane", "SpoolPane", "DtaqPane", "TransferPane"];
    const bad = panes.filter((n) => src(`src/components/${n}.vue`).includes("systemsStore.menuSystem"));
    expect(bad, "全体の選択値を見ているペインが残っている").toEqual([]);
  });
});
