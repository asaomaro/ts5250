import { describe, it, expect } from "vitest";
import { WebhookSink, invalidWebhookUrl, webhookSecret } from "../src/webhook-sink.js";
import type { WatchEntryView } from "../src/watch-registry.js";

/**
 * **待ち行列サービスの Webhook 転送**（`20260801-dtaq-webhook`）。
 *
 * この設計を決めているのは 1 つの事実——**監視は消費する**。読み取りは「取り出して消す」
 * 操作なので、転送の失敗は**データの喪失**である。だから「諦め方」と「諦めたものの見せ方」を
 * 機能そのものと同じ重さで固める。
 */
const entry = (seq: number, text = `ORD-${seq}`): WatchEntryView => ({
  seq,
  at: 1_700_000_000_000,
  text,
  bytes: text.length
});

const cfg = (over: Record<string, unknown> = {}) =>
  ({ url: "https://hook.example/x", maxAttempts: 3, ...over }) as never;

/** 応答を並べて返す偽の送信。呼ばれた回数と本文・ヘッダーを覚える */
function fakeFetch(statuses: (number | "throw")[]) {
  const calls: { body: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fn = async (_url: unknown, init: Record<string, unknown>) => {
    calls.push({ body: init.body as string, headers: init.headers as Record<string, string> });
    const s = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    if (s === "throw") throw new Error("ECONNREFUSED");
    return { status: s } as Response;
  };
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

/** 再試行の待ちを飛ばす（実時間を待たない） */
const nowait = { delay: async () => undefined };
/** キューが流れ切るのを待つ */
const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

describe("送れたとき", () => {
  it("2xx で成功。**本文にキュー名・連番・本文が載る**", async () => {
    const { fn, calls } = fakeFetch([200]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "MYLIB/ORDERQ");
    await settle();
    expect(s.stats).toMatchObject({ delivered: 1, failed: 0, pending: 0 });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      queue: "MYLIB/ORDERQ",
      ref: "srv:w1",
      seq: 1,
      text: "ORD-1"
    });
  });

  it("**到着順に送る**（1 監視につき直列）", async () => {
    const { fn, calls } = fakeFetch([200]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    for (const n of [1, 2, 3]) s.deliver(entry(n), "L/Q");
    await settle();
    expect(calls.map((c) => JSON.parse(c.body).seq)).toEqual([1, 2, 3]);
  });

  it("秘密があればヘッダーと署名が付く（**本文の HMAC**）", async () => {
    const { fn, calls } = fakeFetch([200]);
    const s = new WebhookSink("srv:w1", cfg({ secretHeader: "X-Token" }), "s3cret", {
      fetch: fn,
      ...nowait
    });
    s.deliver(entry(1), "L/Q");
    await settle();
    expect(calls[0]!.headers["x-token"]).toBe("s3cret");
    expect(calls[0]!.headers["x-as400-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("秘密が無ければ署名も付けない", async () => {
    const { fn, calls } = fakeFetch([200]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    await settle();
    expect(calls[0]!.headers["x-as400-signature"]).toBeUndefined();
  });
});

describe("失敗したとき", () => {
  it("**5xx は再試行する**（受け手の一時的な不調は待てば直る）", async () => {
    const { fn, calls } = fakeFetch([500, 500, 200]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    await settle();
    expect(calls).toHaveLength(3);
    expect(s.stats).toMatchObject({ delivered: 1, failed: 0 });
  });

  it("**4xx は再試行しない**（受け手が「要らない」と言っている）", async () => {
    const { fn, calls } = fakeFetch([400]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    await settle();
    expect(calls).toHaveLength(1);
    expect(s.stats.failed).toBe(1);
  });

  it("**3xx も再試行しない**（追うと送り先が設定と違うホストになる）", async () => {
    const { fn, calls } = fakeFetch([302]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    await settle();
    expect(calls).toHaveLength(1);
    expect(s.stats.failed).toBe(1);
  });

  it("届かない（例外）も再試行し、`maxAttempts` で諦める", async () => {
    const { fn, calls } = fakeFetch(["throw"]);
    const s = new WebhookSink("srv:w1", cfg({ maxAttempts: 3 }), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    await settle();
    expect(calls).toHaveLength(3);
    expect(s.stats.failed).toBe(1);
  });

  it("**諦めても次へ進む**（1 件のために後続が詰まらない）", async () => {
    // 1 件目は諦め、2 件目は通る
    const { fn } = fakeFetch([400, 200]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    s.deliver(entry(2), "L/Q");
    await settle();
    expect(s.stats).toMatchObject({ delivered: 1, failed: 1, pending: 0 });
  });

  it("**諦めた分が記録に残る**（黙って消えない・新しい順）", async () => {
    const { fn } = fakeFetch([400]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait, now: () => 111 });
    s.deliver(entry(1, "古い"), "L/Q");
    s.deliver(entry(2, "新しい"), "L/Q");
    await settle();
    expect(s.stats.undelivered.map((u) => u.preview)).toEqual(["新しい", "古い"]);
    expect(s.stats.undelivered[0]).toMatchObject({ seq: 2, at: 111 });
    expect(s.stats.undelivered[0]!.reason).toContain("400");
  });
});

describe("溜まりすぎたとき", () => {
  it("**上限を超えたら古いものから落とす**（メモリを食い潰さない）", async () => {
    // 送信が終わらない受け手（永久に pending）
    const never = (() => new Promise<never>(() => {})) as unknown as typeof globalThis.fetch;
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: never, ...nowait, queueLimit: 2 });
    for (const n of [1, 2, 3, 4]) s.deliver(entry(n), "L/Q");
    expect(s.stats.pending).toBe(2);
    expect(s.stats.failed).toBe(2);
    expect(s.stats.undelivered[0]!.reason).toContain("上限");
  });
});

describe("再送の id", () => {
  it("**再試行しても同じ**（受け手が二重処理を避けられる）", async () => {
    const { fn, calls } = fakeFetch([500, 200]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["x-as400-delivery"]).toBe(calls[1]!.headers["x-as400-delivery"]);
  });

  it("別のエントリでは違う", async () => {
    const { fn, calls } = fakeFetch([200]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    s.deliver(entry(2), "L/Q");
    await settle();
    expect(calls[0]!.headers["x-as400-delivery"]).not.toBe(calls[1]!.headers["x-as400-delivery"]);
  });
});

describe("URL の検査（保存時）", () => {
  it.each([
    ["https://ok.example/x", undefined],
    ["http://ok.example/x", undefined]
  ])("%s は通る", (url, want) => {
    expect(invalidWebhookUrl(url)).toBe(want);
  });

  it("**`file:` は弾く**（http/https だけ）", () => {
    expect(invalidWebhookUrl("file:///etc/passwd")).toContain("file:");
  });

  it("URL でないものは弾く", () => {
    expect(invalidWebhookUrl("ただの文字列")).toContain("解釈できません");
  });
});

describe("秘密の解き方", () => {
  it("暗号文を解く", () => {
    expect(webhookSecret({ url: "u", secretEnc: "e" } as never, () => "plain", () => {})).toBe("plain");
  });

  it("**復号に失敗しても止めない**（秘密なしで送る。キューが溢れるより軽い）", () => {
    const warns: string[] = [];
    const got = webhookSecret(
      { url: "u", secretEnc: "broken" } as never,
      () => {
        throw new Error("bad key");
      },
      (m) => warns.push(m)
    );
    expect(got).toBeUndefined();
    expect(warns[0]).toContain("復号");
  });

  it("環境変数が未設定なら警告して秘密なし", () => {
    const warns: string[] = [];
    const got = webhookSecret({ url: "u", secretEnv: "NOPE_UNSET" } as never, () => "", (m) => warns.push(m));
    expect(got).toBeUndefined();
    expect(warns[0]).toContain("NOPE_UNSET");
  });
});

/**
 * **数は読むたびに聞く**（`20260801-dtaq-webhook` の実機検証で踏んだ）。
 *
 * 到着時に写し取る形だと、**次のエントリが来るまで数が古いまま**になる——
 * 受け手が落ちて諦めたのに、キューが静かだと「未達 0 件」に見え続ける。
 * 失敗は「何も起きない」ときにこそ起きるので、写しではなく実体を読む。
 */
describe("統計の読み方", () => {
  it("**次の到着を待たずに未達が数に出る**", async () => {
    const { fn } = fakeFetch([400]);
    const s = new WebhookSink("srv:w1", cfg(), undefined, { fetch: fn, ...nowait });
    s.deliver(entry(1), "L/Q");
    await settle();
    // 2 件目は送っていない。それでも数は最新
    expect(s.stats.failed).toBe(1);
    expect(s.stats.pending).toBe(0);
  });
});
