/**
 * データ待ち行列の**常駐監視**（`20260723-dtaq-watch-notify`）。
 *
 * 要件の核心は「**ブラウザを閉じても監視は続く**」で、そのために監視は
 * WS ではなくレジストリが所有する。ここで守るのは:
 *
 * 1. 無通信で待ち、届いたら履歴に積んで購読者へ配る
 * 2. **停止と障害を区別する**（停止による `read` の reject を `error` にしない）
 * 3. 一時的な失敗は張り直し、**待っても直らない失敗は再試行しない**
 * 4. 履歴は上限で古いものが落ちるだけ（監視は続く）
 * 5. 所有者以外には見せない・止めさせない
 */
import { describe, it, expect, vi } from "vitest";
import { As400Error } from "@ts5250/base";
import { type DtaqConnection } from "@ts5250/hostserver";
import { WatchRegistry, type WatchEvent } from "../src/watch-registry.js";
import type { AuthUser } from "../src/auth.js";
import type { DtaqWatchSpec } from "../src/config-types.js";

const SPEC: DtaqWatchSpec = { library: "TESTLIB", name: "ORDERQ" };
const CONNECT = { host: "h", user: "u", password: "p" };
const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };

/**
 * 偽の DTAQ 接続。`read` は**手で解決できる**（無限待ちを再現するため）。
 * 実接続だと「エントリが来るまで返らない」をテストで表現できない。
 */
class FakeConn {
  closed = false;
  reads = 0;
  private pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined;
  read(): Promise<{ data: Uint8Array; senderInfo?: Uint8Array } | undefined> {
    this.reads += 1;
    return new Promise((resolve, reject) => {
      this.pending = { resolve: resolve as (v: unknown) => void, reject };
    });
  }
  close(): void {
    this.closed = true;
    // 実装と同じ: 待機中の要求は reject される
    this.pending?.reject(new As400Error("SESSION_CLOSED", "closed"));
    this.pending = undefined;
  }
  /** エントリが届いたことにする */
  deliver(text: string, sender?: Uint8Array): void {
    const p = this.pending;
    this.pending = undefined;
    p?.resolve({ data: new TextEncoder().encode(text), ...(sender ? { senderInfo: sender } : {}) });
  }
  /** 待機中の read を失敗させる */
  failWith(e: unknown): void {
    const p = this.pending;
    this.pending = undefined;
    p?.reject(e);
  }
  get waiting(): boolean {
    return this.pending !== undefined;
  }
}

/** `read` が呼ばれるまで待つ（マイクロタスクを回す） */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(opts: { conns?: FakeConn[]; maxWatches?: number; historyLimit?: number } = {}) {
  const conns = opts.conns ?? [new FakeConn()];
  let i = 0;
  const events: WatchEvent[] = [];
  const reg = new WatchRegistry({
    ...(opts.maxWatches !== undefined ? { maxWatches: opts.maxWatches } : {}),
    ...(opts.historyLimit !== undefined ? { historyLimit: opts.historyLimit } : {}),
    connect: async () => (conns[Math.min(i++, conns.length - 1)] as unknown as DtaqConnection),
    backoffMs: [0],
    delay: async () => undefined,
    now: () => 1000
  });
  reg.subscribe((ev) => events.push(ev));
  return { reg, conns, events, connCount: () => i };
}

describe("受信して積んで配る", () => {
  it("届いたエントリが履歴に入り、購読者へ配られる", async () => {
    const { reg, conns, events } = setup();
    const w = await reg.start({ ref: "own:c1", label: "TESTLIB/ORDERQ", spec: SPEC, connect: CONNECT });
    await settle();
    conns[0]!.deliver("ORD-1043");
    await settle();

    expect(reg.history(w.id)).toHaveLength(1);
    expect(reg.history(w.id)[0]).toMatchObject({ seq: 1, text: "ORD-1043", bytes: 8 });
    expect(events.filter((e) => e.type === "entry")).toHaveLength(1);
    expect(reg.list()[0]?.received).toBe(1);
    reg.closeAll();
  });

  it("**エントリが無い間は待ち続ける**（ポーリングしない）", async () => {
    const { reg, conns } = setup();
    await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    expect(conns[0]!.reads).toBe(1);
    expect(conns[0]!.waiting).toBe(true);
    await settle();
    expect(conns[0]!.reads).toBe(1); // 読み直していない
    reg.closeAll();
  });

  it("受信のたびに読み直す（連続して受け取れる）", async () => {
    const { reg, conns } = setup();
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    for (const t of ["a", "b", "c"]) {
      await settle();
      conns[0]!.deliver(t);
    }
    await settle();
    expect(reg.history(w.id).map((e) => e.text)).toEqual(["a", "b", "c"]);
    expect(reg.list()[0]?.received).toBe(3);
    reg.closeAll();
  });

  it("送信者情報があれば履歴に入る", async () => {
    const { reg, conns } = setup();
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    conns[0]!.deliver("x", new Uint8Array(36).fill(0x40)); // EBCDIC の空白
    await settle();
    expect(reg.history(w.id)[0]?.sender).toBeDefined();
    reg.closeAll();
  });

  it("履歴は上限で古いものが落ちるだけ（監視は続く・累計は増える）", async () => {
    const { reg, conns } = setup({ historyLimit: 2 });
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    for (const t of ["1", "2", "3", "4"]) {
      await settle();
      conns[0]!.deliver(t);
    }
    await settle();
    expect(reg.history(w.id).map((e) => e.text)).toEqual(["3", "4"]);
    expect(reg.history(w.id).map((e) => e.seq)).toEqual([3, 4]); // 連番は戻らない
    expect(reg.list()[0]?.received).toBe(4);
    expect(reg.list()[0]?.state).toBe("listening");
    reg.closeAll();
  });
});

describe("停止と障害を区別する", () => {
  it("停止しても**一覧に残る**（消すと画面から再開できない）", async () => {
    const { reg, conns, events } = setup();
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    reg.stop(w.id);
    await settle();
    // **消さない**——消すと一覧から落ちて、開始ボタンを押せなくなる
    // （`20260801-service-start-stop`）
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]?.state).toBe("stopped");
    // 接続は手放す。仕事は失われない（エントリは読むまでキューに残る）
    expect(conns[0]!.closed).toBe(true);
    // 停止による read の reject を「障害」として配っていない
    // 先頭の `listening` は**開始そのもの**（登録 → 開始の 2 段になったため。
    // `20260801-watch-register-symmetry`）。そのあとが停止
    expect(events.filter((e) => e.type === "state").map((e) => e.watch.state)).toEqual([
      "listening",
      "stopped"
    ]);
  });

  it("停止した監視を**再開できる**（保存した spec で開き直す）", async () => {
    const a = new FakeConn();
    const b = new FakeConn();
    const { reg, connCount } = setup({ conns: [a, b] });
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    reg.stop(w.id);
    await settle();
    await reg.resume(w.id);
    await settle();
    expect(connCount()).toBe(2); // 開き直した
    expect(reg.list()[0]?.state).toBe("listening");
    b.deliver("after-resume");
    await settle();
    expect(reg.history(w.id).map((e) => e.text)).toContain("after-resume");
    reg.closeAll();
  });

  it("停止中は上限を食わない（接続を持たないので枠を占めない）", async () => {
    const { reg } = setup({ conns: [new FakeConn(), new FakeConn(), new FakeConn()], maxWatches: 1 });
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    // 待ち受け中は 1 本で埋まる
    await expect(
      reg.start({ ref: "own:c2", label: "l2", spec: SPEC, connect: CONNECT })
    ).rejects.toMatchObject({ code: "SESSION_LIMIT" });
    reg.stop(w.id);
    await settle();
    // 停止したので空く
    await reg.start({ ref: "own:c2", label: "l2", spec: SPEC, connect: CONNECT });
    await settle();
    expect(reg.list()).toHaveLength(2);
    reg.closeAll();
  });

  it("一時的な失敗は張り直す（reconnecting → listening）", async () => {
    const a = new FakeConn();
    const b = new FakeConn();
    const { reg, events, connCount } = setup({ conns: [a, b] });
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    a.failWith(new As400Error("PROTOCOL_ERROR", "reset by peer"));
    await settle();
    expect(connCount()).toBe(2); // 張り直した
    expect(a.closed).toBe(true);
    const states = events.filter((e) => e.type === "state").map((e) => e.watch.state);
    expect(states).toEqual(["listening", "reconnecting", "listening"]);
    expect(reg.list()[0]?.state).toBe("listening");
    // 張り直した先で受け取れる
    b.deliver("after-reconnect");
    await settle();
    expect(reg.history(w.id).map((e) => e.text)).toEqual(["after-reconnect"]);
    reg.closeAll();
  });

  it("**待っても直らない失敗は再試行せず error にする**（権限が無い）", async () => {
    const a = new FakeConn();
    const { reg, events, connCount } = setup({ conns: [a, new FakeConn()] });
    await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    a.failWith(new As400Error("ACCESS_DENIED", "not authorized to TESTLIB/ORDERQ"));
    await settle();
    expect(connCount()).toBe(1); // 張り直していない
    expect(reg.list()[0]).toMatchObject({ state: "error", error: expect.stringContaining("not authorized") });
    expect(events.filter((e) => e.type === "state").map((e) => e.watch.state)).toEqual([
      "listening",
      "error"
    ]);
    reg.closeAll();
  });

  it("error になった監視も明示停止で `stopped` にできる", async () => {
    const a = new FakeConn();
    const { reg } = setup({ conns: [a] });
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    a.failWith(new As400Error("NOT_FOUND", "queue not found"));
    await settle();
    expect(reg.list()[0]?.state).toBe("error");
    reg.stop(w.id);
    // **一覧からは消さない**（原因を直してから再開できる）
    expect(reg.list()[0]?.state).toBe("stopped");
  });

  it("error からも再開できる（利用者が原因を直した後）", async () => {
    const a = new FakeConn();
    const b = new FakeConn();
    const { reg } = setup({ conns: [a, b] });
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    a.failWith(new As400Error("NOT_FOUND", "queue not found"));
    await settle();
    expect(reg.list()[0]?.state).toBe("error");
    await reg.resume(w.id);
    await settle();
    expect(reg.list()[0]?.state).toBe("listening");
    reg.closeAll();
  });

  /**
   * **開始に失敗しても実体は残す**（`20260801-watch-register-symmetry`）。
   *
   * 以前は接続してから登録していたので、繋がらないと**一覧に何も出ず、理由が
   * サーバーログにしか無かった**——「設定したのに動かない」が画面から追えない。
   * プリンター（`openPrinter` ＋ `startPrinter`）と同じ「登録してから開始」に揃えた。
   */
  it("開始時の接続失敗は start が投げる。**ただし実体と理由は残る**", async () => {
    const reg = new WatchRegistry({
      connect: () => Promise.reject(new As400Error("ACCESS_DENIED", "no auth")),
      delay: async () => undefined
    });
    await expect(
      reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT })
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    // **一覧に残り、理由が読める**（画面から開始し直せる）
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]).toMatchObject({ state: "error", error: expect.stringContaining("no auth") });
  });

  it("**失敗しても枠を食わない**（`error` は接続を持たないので数えない）", async () => {
    const reg = new WatchRegistry({
      maxWatches: 1,
      connect: () => Promise.reject(new As400Error("ACCESS_DENIED", "no auth")),
      delay: async () => undefined
    });
    await expect(
      reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT })
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    // 上限 1 でも、失敗した 1 本目が枠を占めていないので 2 本目を試せる
    await expect(
      reg.start({ ref: "own:c2", label: "l2", spec: SPEC, connect: CONNECT })
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(reg.list()).toHaveLength(2);
  });
});

describe("上限と所有者", () => {
  it("上限を超えると SESSION_LIMIT", async () => {
    const { reg } = setup({ conns: [new FakeConn(), new FakeConn()], maxWatches: 1 });
    await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await expect(
      reg.start({ ref: "own:c2", label: "l2", spec: SPEC, connect: CONNECT })
    ).rejects.toMatchObject({ code: "SESSION_LIMIT" });
    reg.closeAll();
  });

  it("他人の監視は見えない・止められない・履歴も読めない", async () => {
    const { reg } = setup();
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT, owner: "alice" });
    expect(reg.list(alice).map((x) => x.id)).toEqual([w.id]);
    expect(reg.list(bob)).toEqual([]);
    expect(() => reg.stop(w.id, bob)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() => reg.history(w.id, bob)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    // 所有者は触れる
    expect(reg.history(w.id, alice)).toEqual([]);
    reg.closeAll();
  });

  it("認証オフ（user 未指定）では全部見える", async () => {
    const { reg } = setup();
    await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT, owner: "alice" });
    expect(reg.list()).toHaveLength(1);
    reg.closeAll();
  });

  it("未知の id は NOT_FOUND", () => {
    const { reg } = setup();
    expect(() => reg.stop("nope")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => reg.history("nope")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

describe("待ち方", () => {
  it("**wait は常に無限**（HTTP の「無限待ち禁止」はここには効かない）", async () => {
    const conn = new FakeConn();
    const spy = vi.spyOn(conn, "read");
    const reg = new WatchRegistry({
      connect: async () => conn as unknown as DtaqConnection,
      delay: async () => undefined
    });
    await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "ORDERQ", library: "TESTLIB", wait: -1 });
    reg.closeAll();
  });

  it("キー付きキューはキーと検索条件を渡す", async () => {
    const conn = new FakeConn();
    const spy = vi.spyOn(conn, "read");
    const reg = new WatchRegistry({
      connect: async () => conn as unknown as DtaqConnection,
      delay: async () => undefined
    });
    await reg.start({
      ref: "own:c1",
      label: "l",
      spec: { library: "TESTLIB", name: "KEYQ", key: "AB", search: "GE" },
      connect: CONNECT
    });
    await settle();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ search: "GE" });
    expect(spy.mock.calls[0]?.[0]?.key).toEqual(new TextEncoder().encode("AB"));
    reg.closeAll();
  });
});

/**
 * **同じ設定の監視を二重に始めない。** 監視は消費するので、2 本掛かると
 * 1 本ぶんのエントリを取り合って両方が欠ける。
 *
 * 判定はサーバー側に置く——画面側だけで見ると、リロード直後は一覧が届いておらず
 * すり抜ける（実機 E2E で実際に 2 本になった）。
 */
describe("同じ設定は 1 本だけ", () => {
  it("同じ ref で start しても増えず、同じ監視が返る", async () => {
    const { reg } = setup({ conns: [new FakeConn(), new FakeConn()] });
    const a = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    const b = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    expect(b.id).toBe(a.id);
    expect(reg.size).toBe(1);
    reg.closeAll();
  });

  it("別の ref なら増える", async () => {
    const { reg } = setup({ conns: [new FakeConn(), new FakeConn()] });
    await reg.start({ ref: "own:c1", label: "l1", spec: SPEC, connect: CONNECT });
    await reg.start({ ref: "own:c2", label: "l2", spec: SPEC, connect: CONNECT });
    expect(reg.size).toBe(2);
    reg.closeAll();
  });

  it("**所有者が違えば別の監視**（他人の監視を掴まない）", async () => {
    const { reg } = setup({ conns: [new FakeConn(), new FakeConn()] });
    const a = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT, owner: "alice" });
    const b = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT, owner: "bob" });
    expect(b.id).not.toBe(a.id);
    expect(reg.size).toBe(2);
    reg.closeAll();
  });
});

/**
 * **購読の絞り込みはレジストリが行う。** 所有の規則（`assertOwner`）が既にここにあるので、
 * 購読側で「自分のものか」を組み立て直させない（規則が 2 か所になる）。
 */
describe("subscribe の絞り込み", () => {
  it("user を渡すと他人の監視のイベントは届かない", async () => {
    const conn = new FakeConn();
    const reg = new WatchRegistry({
      connect: async () => conn as unknown as DtaqConnection,
      delay: async () => undefined
    });
    const toBob: WatchEvent[] = [];
    reg.subscribe((ev) => toBob.push(ev), bob);
    await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT, owner: "alice" });
    await settle();
    conn.deliver("secret");
    await settle();
    expect(toBob).toEqual([]);
    reg.closeAll();
  });

  it("所有者には届く", async () => {
    const conn = new FakeConn();
    const reg = new WatchRegistry({
      connect: async () => conn as unknown as DtaqConnection,
      delay: async () => undefined
    });
    const toAlice: WatchEvent[] = [];
    reg.subscribe((ev) => toAlice.push(ev), alice);
    await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT, owner: "alice" });
    await settle();
    conn.deliver("mine");
    await settle();
    expect(toAlice.filter((e) => e.type === "entry")).toHaveLength(1);
    reg.closeAll();
  });

  it("解除すると届かなくなる（監視は続く）", async () => {
    const conn = new FakeConn();
    const reg = new WatchRegistry({
      connect: async () => conn as unknown as DtaqConnection,
      delay: async () => undefined
    });
    const seen: WatchEvent[] = [];
    const off = reg.subscribe((ev) => seen.push(ev));
    const w = await reg.start({ ref: "own:c1", label: "l", spec: SPEC, connect: CONNECT });
    await settle();
    off();
    conn.deliver("after-off");
    await settle();
    expect(seen.filter((e) => e.type === "entry")).toEqual([]);
    expect(reg.history(w.id)).toHaveLength(1); // 監視は続いている
    reg.closeAll();
  });
});
