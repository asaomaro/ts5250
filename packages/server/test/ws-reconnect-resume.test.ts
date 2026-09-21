/**
 * 転送断からの復帰（`20260908-session-survives-disconnect`）。
 *
 * 実機報告: 応答待ちの表示が解除されず、開き直すと「前回のセッションが閉じられた」警告が出る。
 * 原因は WebSocket が閉じた時点でホストセッションまで畳んでいたこと。ここで固定するのは
 * `ws-handler` 側の 3 つ:
 *
 *   - **転送断（`onSocketClose` / 心拍の死判定）と、利用者の `close` を区別する。**
 *     猶予に値するのは前者だけ
 *   - **`resume: true` の attach は持ち主として戻る**（猶予を解き、閉じる責任も引き継ぐ）。
 *     `resume` 無しの従来の attach は「見に来ただけ」で挙動が変わらない
 *   - **古い接続が復帰済みのセッションを殺さない。かつ孤児も残さない**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import type { OpenPrinterOptions } from "../src/session-manager.js";
import type { WsServerMessage } from "../src/ws-messages.js";
import type { AuthUser } from "../src/auth.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

/** startup だけ返す最小のプリンター transport（`ws-lifetime.test.ts` の縮小版） */
class PrinterTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  send(): void {}
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  start(): void {
    const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xc9, 0xf9, 0xf0, 0xf2];
    const ll = body.length + 2;
    this.dataFn?.(Uint8Array.from([(ll >> 8) & 0xff, ll & 0xff, ...body, 0xff, 0xef]));
  }
}

class InjectingManager extends SessionManager {
  constructor(
    private readonly makeTransport: () => Transport,
    opts?: ConstructorParameters<typeof SessionManager>[0]
  ) {
    super(opts);
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: this.makeTransport() });
  }
  override openPrinter(opts: OpenPrinterOptions) {
    return super.openPrinter({ ...opts, transport: new PrinterTransport() });
  }
}

function conn(mgr: SessionManager, user?: AuthUser) {
  const sent: WsServerMessage[] = [];
  const resolver = new ConfigResolver(
    new ServerConfigStore({
      systems: [{ id: "p", name: "p", host: "h" }],
      // プリンターは**在席（viewers）を数えない経路**なので、保持者ガードが実際に効くのはここ
      sessions: [{ id: "prt", name: "prt", system: "p", sessionType: "printer" }]
    }),
    new PersonalConfigStore()
  );
  const c = new WsConnection(
    { sessions: mgr, resolver },
    { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} },
    user
  );
  return { c, sent };
}

async function openNew(mgr: SessionManager, user?: AuthUser) {
  const { c, sent } = conn(mgr, user);
  await c.handle(JSON.stringify({ type: "open", host: "h" }));
  return { c, sent, id: (sent[0] as { sessionId: string }).sessionId };
}

/** 同じ保存済み定義のプリンターを開く（2 回目は既存エントリへ相乗りする） */
async function openPrinter(mgr: SessionManager) {
  const { c, sent } = conn(mgr);
  await c.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:prt" }));
  return { c, sent, id: (sent[0] as { sessionId: string }).sessionId };
}

describe("転送断と、利用者が閉じたことの区別", () => {
  it("転送断は猶予に入る（ホストの対話ジョブを道連れにしない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    first.c.onSocketClose();
    expect(mgr.size).toBe(1);
    expect(mgr.isHeld(first.id)).toBe(true);
    mgr.closeAll();
  });

  it("**利用者の close は猶予に入らず即座に閉じる**（意図して閉じたものを残さない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    await first.c.handle(JSON.stringify({ type: "close" }));
    expect(mgr.size).toBe(0);
  });
});

describe("resume: 持ち主として戻る", () => {
  it("猶予中のセッションへ resume で戻れて、猶予が解ける", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    first.c.onSocketClose();
    expect(mgr.isHeld(first.id)).toBe(true);

    const back = conn(mgr);
    await back.c.handle(JSON.stringify({ type: "open", sessionId: first.id, resume: true }));
    expect(back.sent[0]).toMatchObject({ type: "opened", sessionId: first.id });
    expect(mgr.isHeld(first.id)).toBe(false);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("**resume した接続が閉じる責任を引き継ぐ**（利用者が閉じれば畳む）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    first.c.onSocketClose();

    const back = conn(mgr);
    await back.c.handle(JSON.stringify({ type: "open", sessionId: first.id, resume: true }));
    await back.c.handle(JSON.stringify({ type: "close" }));
    // **見に来ただけの attach ならここで閉じない**。resume は持ち主なので閉じる
    expect(mgr.size).toBe(0);
  });

  it("resume した接続が転送断で去れば、もう一度猶予に入る（何度でも繋ぎ直せる）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    first.c.onSocketClose();

    const back = conn(mgr);
    await back.c.handle(JSON.stringify({ type: "open", sessionId: first.id, resume: true }));
    expect(mgr.isHeld(first.id)).toBe(false);
    back.c.onSocketClose();
    expect(mgr.isHeld(first.id)).toBe(true);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("resume 無しの attach は従来どおり（見に来ただけ。閉じる責任を持たない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    // **見に来た人しか WS を持っていない状態で確かめる。** 開いた側の接続を残すと
    // 「他に見ている人が居る」で先に弾かれ、「見に来ただけ」（`link.role`）の区別を素通ししてしまう
    const entry = await mgr.open({ host: "h" });
    const viewer = conn(mgr);
    await viewer.c.handle(JSON.stringify({ type: "open", sessionId: entry.id }));
    viewer.c.onSocketClose();
    expect(mgr.size).toBe(1); // 相手（MCP 等）の作業は生きている
    expect(mgr.isHeld(entry.id)).toBe(false); // 猶予にも入れない——持ち主ではないので
    mgr.closeAll();
  });

  it("**他人のセッションは resume できない**（所有者検査は既存のまま効く）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const entry = await mgr.open({ host: "h", owner: "tanaka" });
    const other = conn(mgr, { username: "suzuki", role: "user" } as AuthUser);
    await other.c.handle(JSON.stringify({ type: "open", sessionId: entry.id, resume: true }));
    expect(other.sent[0]).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });
});

describe("古い接続の後始末", () => {
  it("**交代済みの古い接続は、相手が居るあいだ手を出さない**（プリンター経路）", async () => {
    // **表示セッションでは在席（viewers）が先に守る**ので、保持者ガードそのものは
    // 素通しでも緑になる。プリンターは在席を数えないため、ここだけがガードの効き目を見られる
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const firstTab = await openPrinter(mgr);
    const secondTab = await openPrinter(mgr); // 同じ定義＝同じエントリ。持ち主が交代する
    expect(secondTab.id).toBe(firstTab.id);

    firstTab.c.onSocketClose(); // 交代済みの古い接続が去る
    expect(mgr.size).toBe(1); // まだ使っている人が居るので閉じない

    await secondTab.c.handle(JSON.stringify({ type: "close" })); // 持ち主が去る
    expect(mgr.size).toBe(0);
  });

  it("**復帰済みの表示セッションを、古い接続の後始末が閉じない**", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    // 半開き: クライアントが先に見切って繋ぎ直す（古い接続はまだ生きている）
    const back = conn(mgr);
    await back.c.handle(JSON.stringify({ type: "open", sessionId: first.id, resume: true }));
    // そのあとで古い接続が（心拍の死判定と同じ `transportLost` の経路で）去る
    first.c.onSocketClose();
    expect(mgr.size).toBe(1);
    expect(mgr.isHeld(first.id)).toBe(false); // 猶予にも入れない（使っている人が居る）
    mgr.closeAll();
  });

  it("**持ち主が去ったあとなら、残った古い接続が畳む**（誰も閉じない状態を作らない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    const back = conn(mgr);
    await back.c.handle(JSON.stringify({ type: "open", sessionId: first.id, resume: true }));
    // 新しい持ち主が先に去る（座を返す）。この時点では古い接続がまだ見ている
    await back.c.handle(JSON.stringify({ type: "close" }));
    // 続いて古い接続も去る。**印は古いが、いま持ち主が居ないので最後の 1 人**
    await first.c.handle(JSON.stringify({ type: "close" }));
    expect(mgr.size).toBe(0);
  });
});

describe("`closed` の意味を取り違えさせない（review ラウンド1）", () => {
  /**
   * `closed` は 2 つの出所から飛ぶ。**ホストが本当に終わった側だけ `ended` を立てる。**
   *
   * サーバーは心拍の死判定でも（＝猶予を張ったうえで）`dispose` の末尾から `closed` を送る。
   * 区別しないと、片方向だけ詰まった回線のタブが「ホストが終わった」と読んで
   * **二度と繋ぎ直さず、しかも嘘の理由を出す**。
   */
  it("ホスト側が終わったときは `ended: true` を立てる", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    // セッションが**繋ぎ直さずに**終わった（`closed`）。ブラウザから開いたセッションはホストに切られると
    // 繋ぎ直す（`20260921-auto-reconnect`）ので、ここで見ているのは「最終的に終わったとき」の `ended`——
    // 繋ぎ直しを諦めた（起動応答で拒否）・自分から切った場合と同じ `closed` の経路
    mgr.get(first.id).session.disconnect();
    await new Promise((r) => setTimeout(r, 20));
    expect(first.sent.find((m) => m.type === "closed")).toMatchObject({ ended: true });
  });

  it("**この接続の後始末で送る `closed` には `ended` を付けない**（セッションは生きうる）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    first.c.onSocketClose(); // 転送断＝猶予に入る
    const closed = first.sent.find((m) => m.type === "closed") as { ended?: boolean } | undefined;
    expect(closed).toBeTruthy();
    expect(closed?.ended).toBeUndefined();
    expect(mgr.isHeld(first.id)).toBe(true); // 実際、セッションは保持されている
    mgr.closeAll();
  });
});

describe("猶予の対象は 5250 表示セッションだけ（AC8）", () => {
  it("**非常駐プリンターは転送断でも即閉じる**（猶予に入れない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const printer = await openPrinter(mgr);
    expect(mgr.size).toBe(1);
    printer.c.onSocketClose();
    expect(mgr.size).toBe(0);
  });

  it("`sessionId` の無い `resume: true` は新規 open として扱う（黙って無視する）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const { c, sent } = conn(mgr);
    await c.handle(JSON.stringify({ type: "open", host: "h", resume: true }));
    expect(sent[0]).toMatchObject({ type: "opened" });
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("他に見ている人が残っていれば、転送断でも猶予に入らない（従来の判断が先に効く）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    const first = await openNew(mgr);
    const viewer = conn(mgr);
    await viewer.c.handle(JSON.stringify({ type: "open", sessionId: first.id }));
    first.c.onSocketClose();
    expect(mgr.size).toBe(1);
    expect(mgr.isHeld(first.id)).toBe(false);
    mgr.closeAll();
  });
});

/**
 * **同じ WS 接続を使い回したときの役割**（`20260908-session-lifetime-rules-fold` D9）。
 *
 * `close` メッセージは `dispose` するだけで WS を閉じない（`ws-handler.ts` の `case "close"`）。
 * つまり 1 本の接続が「見に来ただけ」→ 後始末 →「自分で開く」と役割を変えられる。
 *
 * **畳み込み前は役割がリセットされなかった**——`dispose` が `sessionId` と `holderToken` は
 * 戻すのに `attached` を戻さず、一度 viewer になった接続は以後永久に viewer 扱いだった。
 * その状態で自分のセッションを開くと、閉じる責任を持つ者が居なくなり**孤児になる**。
 * `link`（id ＋ 役割）を 1 欄に畳んだことで、id と一緒に役割も戻るようになった。
 */
describe("同じ接続を使い回したときの役割", () => {
  it("**viewer として繋いだあと後始末しても、次に自分で開けば持ち主になる**（孤児を残さない）", async () => {
    const mgr = new InjectingManager(() => new ReplayTransport(signon()));
    // WS を持たない相手（MCP / HLLAPI）が開いたセッション
    const shared = (await mgr.open({ host: "h" })).id;
    const { c } = conn(mgr);

    await c.handle(JSON.stringify({ type: "open", sessionId: shared })); // 見に来ただけ
    await c.handle(JSON.stringify({ type: "close" })); // 後始末。WS は開いたまま
    expect(mgr.size, "見に来ただけの接続が相手のセッションを閉じた").toBe(1);

    await c.handle(JSON.stringify({ type: "open", host: "h" })); // 今度は自分で開く＝持ち主
    expect(mgr.size).toBe(2);
    await c.handle(JSON.stringify({ type: "close" }));
    // **役割が viewer のまま残っていると、ここで閉じられず孤児になる**
    expect(mgr.size, "自分で開いたセッションを閉じられていない（役割が戻っていない）").toBe(1);
    mgr.closeAll();
  });
});
