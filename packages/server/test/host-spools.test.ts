import { describe, it, expect, vi, afterEach } from "vitest";
import * as hostConnect from "../src/host-connect.js";

// モックを積み残すとテストの実行順が意味を持ってしまう
afterEach(() => vi.restoreAllMocks());
import { buildApp } from "../src/app.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { AuditBuffer } from "../src/audit.js";
import { MAX_SPOOLS, DEFAULT_SPOOLS, DEFAULT_SPOOL_CCSID } from "../src/host-spools.js";

/**
 * pull 型スプールの API。
 *
 * 実際の取得は実機でしか確かめられないため、ここでは
 * **入力の検証・打ち切りの契約・設定の引き回し**を固定する。
 */
function app(systems?: Parameters<typeof ServerConfigStore>[0]) {
  const server = new ServerConfigStore(
    systems ?? {
      systems: [{ id: "noauth", name: "noauth", host: "example.invalid" }],
      sessions: [{ id: "noauth-d", name: "noauth-d", system: "noauth", sessionType: "display" }]
    }
  );
  return buildApp({
    sessions: new SessionManager(),
    resolver: new ConfigResolver(server, new PersonalConfigStore()),
    audit: new AuditBuffer(),
    version: "test"
  });
}

async function post(a: ReturnType<typeof buildApp>, path: string, body: unknown) {
  return a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("スプール一覧 API の入力検証", () => {
  it("どちらも指定しなければ 400", async () => {
    expect((await post(app(), "/api/host/spools", { source: {} })).status).toBe(400);
  });

  it("知らない項目は拒否する（strict）", async () => {
    const res = await post(app(), "/api/host/spools", {
      source: { system: "srv:noauth" },
      unexpected: 1
    });
    expect(res.status).toBe(400);
  });

  it("知らない絞り込み項目も拒否する（strict）", async () => {
    const res = await post(app(), "/api/host/spools", {
      source: { system: "srv:noauth" },
      filter: { nosuch: "x" }
    });
    expect(res.status).toBe(400);
  });

  it("絞り込みの 6 項目は受け付ける", async () => {
    const res = await post(app(), "/api/host/spools", {
      source: { system: "srv:noauth" },
      filter: {
        user: "USER",
        outputQueue: "PRT1",
        outputQueueLibrary: "QUSRSYS",
        status: "*READY",
        formType: "STD",
        userData: "X"
      }
    });
    // 資格情報が無いので接続前に落ちる＝スキーマは通っている
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG_ERROR");
  });

  it(`max は上限 ${MAX_SPOOLS} を超えると 400`, async () => {
    const res = await post(app(), "/api/host/spools", {
      source: { system: "srv:noauth" },
      max: MAX_SPOOLS + 1
    });
    expect(res.status).toBe(400);
  });

  it("max は 0 以下も 400", async () => {
    const res = await post(app(), "/api/host/spools", { source: { system: "srv:noauth" }, max: 0 });
    expect(res.status).toBe(400);
  });
});

describe("スプール本文・PDF API の入力検証", () => {
  const id = {
    jobName: "QPRTJOB",
    jobUser: "USER",
    jobNumber: "681803",
    fileName: "QPRTLIBL",
    fileNumber: 5
  };

  for (const path of ["/api/host/spool/content", "/api/host/spool/pdf"]) {
    it(`${path}: id が無ければ 400`, async () => {
      expect((await post(app(), path, { source: { system: "srv:noauth" } })).status).toBe(400);
    });

    it(`${path}: id の項目が欠けていれば 400`, async () => {
      const { fileNumber: _drop, ...partial } = id;
      expect((await post(app(), path, { source: { system: "srv:noauth" }, id: partial })).status).toBe(
        400
      );
    });

    it(`${path}: fileNumber は数値でなければ 400`, async () => {
      const res = await post(app(), path, {
        source: { system: "srv:noauth" },
        id: { ...id, fileNumber: "5" }
      });
      expect(res.status).toBe(400);
    });

    it(`${path}: 揃っていればスキーマを通る（資格情報が無いので 400 CONFIG_ERROR）`, async () => {
      const res = await post(app(), path, { source: { system: "srv:noauth" }, id });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("CONFIG_ERROR");
    });
  }
});

/**
 * spec 方針2 の要（R2 の転記漏れ対策）。
 * `spoolCcsid` はスキーマ → ルート whitelist → 公開形 → resolver と 4 箇所を通るので、
 * **端から端まで**届くことを確かめる。途中の 1 箇所が抜けても他は通ってしまう。
 */
describe("spoolCcsid の引き回し", () => {
  const store = () =>
    new ServerConfigStore({
      systems: [
        { id: "jp", name: "jp", host: "example.invalid", ccsid: 5035, spoolCcsid: 939 },
        { id: "plain", name: "plain", host: "example.invalid" }
      ],
      sessions: [{ id: "jp-d", name: "jp-d", system: "jp", sessionType: "display", ccsid: 1399 }]
    });

  it("システムの spoolCcsid が ConnectOptions に届く", () => {
    const r = new ConfigResolver(store(), new PersonalConfigStore());
    const { connect } = r.resolve({ system: "srv:jp" }, undefined, () => {});
    expect(connect.spoolCcsid).toBe(939);
  });

  it("5250 の ccsid とは別物として残る（互いに上書きしない）", () => {
    const r = new ConfigResolver(store(), new PersonalConfigStore());
    const { connect } = r.resolve({ system: "srv:jp" }, undefined, () => {});
    expect(connect.ccsid).toBe(5035);
    expect(connect.spoolCcsid).toBe(939);
  });

  it("セッションの ccsid 上書きは spoolCcsid に波及しない", () => {
    const r = new ConfigResolver(store(), new PersonalConfigStore());
    const { connect } = r.resolve({ session: "srv:jp-d" }, undefined, () => {});
    expect(connect.ccsid).toBe(1399); // セッションが上書き
    expect(connect.spoolCcsid).toBe(939); // システムのまま
  });

  it("未設定なら undefined（既定は取得側が決める）", () => {
    const r = new ConfigResolver(store(), new PersonalConfigStore());
    const { connect } = r.resolve({ system: "srv:plain" }, undefined, () => {});
    expect(connect.spoolCcsid).toBeUndefined();
  });

  it("公開形（API 応答）にも載る", () => {
    const systems = store().listSystems(undefined);
    expect(systems.find((s) => s.name === "jp")?.spoolCcsid).toBe(939);
  });

  it("既定値は 5250 側（37）と別（273）", () => {
    expect(DEFAULT_SPOOL_CCSID).toBe(273);
  });
});

/**
 * 打ち切り判定は **`max + 1` 件要求して超過を見る**。
 *
 * ホストの「総件数」を信じる実装が実機で破綻した経緯があるので（test-result.md F1）、
 * 境界をここで固定する。`listSpooledFiles` はモックし、`listSpools` の判定だけを見る。
 */
describe("打ち切り判定（max + 1 方式）", () => {
  const entry = (n: number) => ({ fileName: `F${n}`, fileNumber: n }) as never;

  async function listWith(available: number, max: number) {
    // **モック先は `@ts5250/hostserver`**。`host-spools.ts` がそこから import しているので、
    // `@ts5250/tn5250` に spy を張っても被験側は別のモジュールを見ることになり、
    // 「モックしたつもりで実物が動く」になる（core が再輸出をやめたため）。
    const hostserver = await import("@ts5250/hostserver");
    const spy = vi.spyOn(hostserver, "listSpooledFiles").mockImplementation(
      // 要求された max（＝呼び出し側の max+1）までしか返さないホストを模す
      async (_c, _f, opts) =>
        Array.from({ length: Math.min(available, opts?.max ?? available) }, (_, i) => entry(i))
    );
    vi.spyOn(hostConnect, "openCommand").mockResolvedValue({ close: () => {} } as never);
    const { listSpools } = await import("../src/host-spools.js");
    const res = await listSpools({} as never, {}, max);
    spy.mockRestore();
    return res;
  }

  it("ちょうど max 件なら打ち切りではない（オフバイワン）", async () => {
    const r = await listWith(10, 10);
    expect(r.items).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it("max より 1 件多ければ打ち切り、返すのは max 件まで", async () => {
    const r = await listWith(11, 10);
    expect(r.items).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("max に満たなければ打ち切りではない", async () => {
    const r = await listWith(3, 10);
    expect(r.items).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it("0 件でも打ち切りにしない", async () => {
    const r = await listWith(0, 10);
    expect(r.items).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});

describe("既定値", () => {
  it("一覧の既定件数は他の一覧より控えめ（1 件が重いため）", () => {
    expect(DEFAULT_SPOOLS).toBe(100);
    expect(DEFAULT_SPOOLS).toBeLessThan(MAX_SPOOLS);
  });
});
