import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager, type OpenOptions, type OpenPrinterOptions } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import type { ServerSession } from "../src/config-types.js";
import type { AuthUser } from "../src/auth.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";
import { setAuditSink, type AuditEvent } from "../src/audit.js";

/**
 * **表示を開くときの、関連付けるプリンターセッション**（`associatedPrinterSession`。`20260921-associated-printer-session`。ACS
 * `AssociatedPrinterSession5250` のコンストラクタ）。プリンターを起こして装置名を待ち、その装置名を IBMASSOCPRT（`associatedPrinter`）として
 * 表示を開く。待ち時間切れ・指した先が使えないときは関連付けなしで開く
 */
const here = dirname(fileURLToPath(import.meta.url));
const signon = () => parseTraceJsonl(readFileSync(join(here, "..", "..", "tn5250", "test", "fixtures", "pub400-signon.jsonl"), "utf8"));

/** 起動応答（I902・装置名 PRT01）を返す輸送。`silent` なら返さない（装置名が決まらない） */
class PrinterTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  constructor(private readonly silent = false, private readonly device = "PRT01") {}
  send(): void {}
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(): void {}
  onError(): void {}
  start(): void {
    if (this.silent) return;
    // EBCDIC（CCSID 37）: A〜I=0xC1〜0xC9・J〜R=0xD1〜0xD9・S〜Z=0xE2〜0xE9（並びが不連続なので表で引く）
    const eb = (c: string): number => {
      const i = c.charCodeAt(0) - 0x41;
      return i < 9 ? 0xc1 + i : i < 18 ? 0xd1 + (i - 9) : 0xe2 + (i - 18);
    };
    const name = [...this.device].map(eb);
    const dev = [...name, ...new Array(10 - name.length).fill(0x40)];
    const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xc9, 0xf9, 0xf0, 0xf2, ...new Array(8).fill(0x40), ...dev];
    const ll = body.length + 2;
    this.dataFn?.(Uint8Array.from([(ll >> 8) & 0xff, ll & 0xff, ...body, 0xff, 0xef]));
  }
}

class Recording extends SessionManager {
  readonly displays: OpenOptions[] = [];
  readonly printersOpened: OpenPrinterOptions[] = [];
  constructor(private readonly silent = false) {
    super();
  }
  override open(opts: OpenOptions) {
    this.displays.push(opts);
    return super.open({ ...opts, transport: new ReplayTransport(signon()) });
  }
  override openPrinter(opts: OpenPrinterOptions) {
    this.printersOpened.push(opts);
    return super.openPrinter({ ...opts, transport: new PrinterTransport(this.silent, "PRTA") });
  }
}

const prt = { id: "prt", name: "prt", system: "sys", sessionType: "printer", deviceName: "SETNAME" } as ServerSession;
const disp = (over: Partial<ServerSession> = {}) =>
  ({ id: "d", name: "d", system: "sys", sessionType: "display", associatedPrinterSession: "prt", ...over }) as ServerSession;

async function openDisplay(mgr: Recording, sessions: ServerSession[]) {
  const sent: WsServerMessage[] = [];
  const resolver = new ConfigResolver(new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions }), new PersonalConfigStore());
  const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
  await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
  return { sent, conn };
}

/** 起動応答が少し遅れて来る輸送（装置名が決まるのを待つ挙動を確かめる） */
class SlowPrinterTransport extends PrinterTransport {
  override start(): void {
    setTimeout(() => super.start(), 400);
  }
}
class SlowRecording extends Recording {
  override openPrinter(opts: OpenPrinterOptions) {
    // `Recording.openPrinter` は輸送を差し替えるので、その前に遅い輸送を渡す
    this.printersOpened.push(opts);
    return SessionManager.prototype.openPrinter.call(this, { ...opts, transport: new SlowPrinterTransport(false, "PRTA") });
  }
}

describe("表示を開くときの関連付けるプリンター", () => {
  it("**プリンターを開いて起こし、その装置名（起動応答の名前）で関連付けて表示を開く**", async () => {
    const mgr = new Recording();
    const { sent } = await openDisplay(mgr, [prt, disp()]);
    expect(mgr.printersOpened).toHaveLength(1);
    expect(mgr.printersOpened[0]).toMatchObject({ ref: "srv:prt", deviceName: "SETNAME" });
    expect(mgr.displays[0]!.associatedPrinter).toBe("PRTA");
    expect(sent.some((m) => m.type === "opened")).toBe(true);
    expect([...mgr.listPrinters()][0]!.state).toBe("listening");
    mgr.closeAll();
  });

  it("**同じ持ち主・同じ設定のプリンターが開いていれば使い回す**（開き直さない）", async () => {
    const mgr = new Recording();
    await openDisplay(mgr, [prt, disp()]);
    await openDisplay(mgr, [prt, disp()]);
    expect(mgr.printersOpened).toHaveLength(1);
    expect(mgr.displays.map((d) => d.associatedPrinter)).toEqual(["PRTA", "PRTA"]);
    mgr.closeAll();
  });

  it("**待ち時間切れでも表示は開くが、関連付けなしで開く**（ACS: 起こすタイマーのスレッドが時間が来ると関連付けなしの表示を開く）。組は残し、理由を返す", async () => {
    const mgr = new Recording(true);
    const events: AuditEvent[] = [];
    setAuditSink((e) => events.push(e));
    const { sent } = await openDisplay(mgr, [prt, disp({ associatedPrinterTimeout: 5 })]);
    setAuditSink(() => {});
    expect(events.filter((e) => e.op === "ws_associated_printer"), "時間切れも監査に残る").toMatchObject([{ result: "error", code: "timeout" }]);
    const opened = sent.find((m) => m.type === "opened");
    expect(opened).toBeDefined();
    expect(mgr.displays[0]!.associatedPrinter, "設定の装置名では関連付けない（読み違いの修正）").toBeUndefined();
    expect(opened).toMatchObject({ associatedPrinterIssue: "timeout" });
    // 組は残る（ACS も装置名が決まればその相手を探し続ける）
    expect([...mgr.list()][0]!.associatedPrinter).toBeDefined();
    mgr.closeAll();
  }, 15000);

  it("**プリンターを開けなかったら、関連付けなしで表示を開き、理由 `failed` を返す**（組も作らない）", async () => {
    class FailingRecording extends Recording {
      override openPrinter(): Promise<never> {
        return Promise.reject(new Error("boom"));
      }
    }
    const mgr = new FailingRecording();
    const { sent } = await openDisplay(mgr, [prt, disp()]);
    expect(sent.find((m) => m.type === "opened")).toMatchObject({ associatedPrinterIssue: "failed" });
    expect(mgr.displays[0]!.associatedPrinter).toBeUndefined();
    expect([...mgr.list()][0]!.associatedPrinter, "組を作らない").toBeUndefined();
    mgr.closeAll();
  });

  it("**装置名が決まるのを待つ**（起動応答が遅れて来ても、設定の値ではなく起動応答の名前で関連付ける）", async () => {
    const mgr = new SlowRecording();
    await openDisplay(mgr, [prt, disp({ associatedPrinterTimeout: 20 })]);
    expect(mgr.displays[0]!.associatedPrinter).toBe("PRTA");
    mgr.closeAll();
  });

  it("**指した設定がプリンターでなければ、プリンターを開かず関連付けなしで開く**", async () => {
    const mgr = new Recording();
    const notPrinter = { id: "prt", name: "prt", system: "sys", sessionType: "display" } as ServerSession;
    const store = new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [notPrinter, disp()] });
    // 保存の検査をすり抜けた状態（読み込み後に置き換えた）を作る
    const sent: WsServerMessage[] = [];
    const conn = new WsConnection({ sessions: mgr, resolver: new ConfigResolver(store, new PersonalConfigStore()) }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    expect(sent.find((m) => m.type === "opened")).toMatchObject({ associatedPrinterIssue: "invalid" });
    expect(mgr.printersOpened).toHaveLength(0);
    expect(mgr.displays[0]!.associatedPrinter).toBeUndefined();
    mgr.closeAll();
  });

  it("指したプリンターの設定が無ければ、関連付けなしで開く", async () => {
    const mgr = new Recording();
    // 設定ファイルの検査をすり抜けた状態（プリンターを後から消した）を作る
    const store = new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [prt, disp()] });
    const sent: WsServerMessage[] = [];
    const conn = new WsConnection({ sessions: mgr, resolver: new ConfigResolver(store, new PersonalConfigStore()) }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    // 保存の検査（指されているプリンターは消せない）をすり抜けた状態＝手で書き換えたファイルを作る
    (store as unknown as { sessions: Map<string, unknown> }).sessions.delete("prt");
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    expect(sent.find((m) => m.type === "opened")).toMatchObject({ associatedPrinterIssue: "invalid" });
    expect(mgr.printersOpened).toHaveLength(0);
    expect(mgr.displays[0]!.associatedPrinter).toBeUndefined();
    mgr.closeAll();
  });

  it("**表示を閉じるとプリンターも止まる**（組にした）", async () => {
    const mgr = new Recording();
    const { conn } = await openDisplay(mgr, [prt, disp()]);
    const id = [...mgr.list()][0]!.id;
    await mgr.close(id);
    expect([...mgr.listPrinters()][0]!.state).toBe("stopped");
    void conn;
    mgr.closeAll();
  });

  it("**同時に開いても、プリンターへの接続は 1 本だけ**（2 本目は 1 本目の起動に相乗りする。以前は二重に張った）", async () => {
    const mgr = new SlowRecording();
    const results = await Promise.all([openDisplay(mgr, [prt, disp({ associatedPrinterTimeout: 20 })]), openDisplay(mgr, [prt, disp({ associatedPrinterTimeout: 20 })])]);
    expect(results.every((r) => r.sent.some((m) => m.type === "opened"))).toBe(true);
    expect(mgr.printersOpened, "プリンターを開いたのは 1 回").toHaveLength(1);
    expect([...mgr.listPrinters()]).toHaveLength(1);
    expect(mgr.displays.map((d) => d.associatedPrinter)).toEqual(["PRTA", "PRTA"]);
    mgr.closeAll();
  });

  it("**表示を開けなかったら、起こしたプリンターを止める**（「一緒に閉じる」なら閉じる。以前は残った）", async () => {
    for (const close of [false, true]) {
      const mgr = new Recording();
      const fail = new Error("host unreachable");
      mgr.open = (async () => {
        throw fail;
      }) as never;
      const { sent } = await openDisplay(mgr, [prt, disp(close ? { closeAssociatedPrinterWithLastSession: true } : {})]).catch((e) => ({ sent: [{ type: "error", message: String(e) }] as WsServerMessage[] }));
      void sent;
      const printers = [...mgr.listPrinters()];
      if (close) expect(printers, "一緒に閉じる").toHaveLength(0);
      else expect(printers[0]?.state, "止める").toBe("stopped");
      mgr.closeAll();
    }
  });

  it("**準備の待ち中にブラウザが切れたら、表示を作らず、起こしたプリンターも片付ける**（以前は誰も持たない表示が残った）", async () => {
    const mgr = new SlowRecording();
    const resolver = new ConfigResolver(new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [prt, disp({ associatedPrinterTimeout: 20 })] }), new PersonalConfigStore());
    const sent: WsServerMessage[] = [];
    const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    const opening = conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    await new Promise((r) => setTimeout(r, 100)); // プリンターの起動（400 ms）の途中
    conn.onSocketClose();
    await opening;
    expect([...mgr.list()], "表示は作られない").toHaveLength(0);
    expect(sent.some((m) => m.type === "opened"), "opened を送らない").toBe(false);
    expect([...mgr.listPrinters()][0]?.state, "プリンターは止まる").toBe("stopped");
    mgr.closeAll();
  });

  it("**開く待ち（ホストへの接続）の間にブラウザが切れたら、表示を閉じる**（`opened` を送っても受け取る側が居ない。以前からある窓）", async () => {
    class SlowOpen extends Recording {
      override async open(opts: OpenOptions) {
        this.displays.push(opts);
        await new Promise((r) => setTimeout(r, 200)); // 接続の待ち
        return SessionManager.prototype.open.call(this, { ...opts, transport: new ReplayTransport(signon()) });
      }
    }
    const mgr = new SlowOpen();
    const resolver = new ConfigResolver(new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [prt, disp()] }), new PersonalConfigStore());
    const sent: WsServerMessage[] = [];
    const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    const opening = conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    await new Promise((r) => setTimeout(r, 100)); // 表示の接続の途中（プリンターの準備は済んでいる）
    conn.onSocketClose();
    await opening;
    await new Promise((r) => setTimeout(r, 50));
    expect([...mgr.list()], "誰も持たない表示を残さない").toHaveLength(0);
    expect(sent.some((m) => m.type === "opened"), "opened を送らない").toBe(false);
    mgr.closeAll();
  });

  it("**1 つの接続で、閉じてから開き直せる**（`close` の後始末の印を次の `open` に引きずらない）", async () => {
    const mgr = new Recording();
    const resolver = new ConfigResolver(new ServerConfigStore({ systems: [{ id: "sys", name: "sys", host: "h" }], sessions: [prt, disp()] }), new PersonalConfigStore());
    const sent: WsServerMessage[] = [];
    const conn = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} });
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    await conn.handle(JSON.stringify({ type: "close" }));
    sent.length = 0;
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    expect(sent.some((m) => m.type === "opened"), "開き直せる").toBe(true);
    expect([...mgr.list()].length, "表示が 1 本").toBe(1);
    mgr.closeAll();
  });

  it("**「自動で待ち受け開始 ☐」のプリンターも、指せば起こす**（初回だけ起こされず装置名が決まらない穴を塞ぐ）", async () => {
    const mgr = new Recording();
    await openDisplay(mgr, [{ ...prt, autoStart: false } as ServerSession, disp()]);
    expect([...mgr.listPrinters()][0]?.state).toBe("listening");
    expect(mgr.displays[0]!.associatedPrinter).toBe("PRTA");
    mgr.closeAll();
  });

  it("関連付けの指定が無い表示は、プリンターに触らない", async () => {
    const mgr = new Recording();
    await openDisplay(mgr, [prt, disp({ associatedPrinterSession: undefined })]);
    expect(mgr.printersOpened).toHaveLength(0);
    expect(mgr.displays[0]!.associatedPrinter).toBeUndefined();
    mgr.closeAll();
  });
});

/**
 * **信頼境界**（AGENTS.md「追加時のチェックリスト」。認証オフ / admin / 一般ユーザーの 3 パターン。`20260921-associated-printer-session` の節目 10 の
 * 独立点検 C-S9）。実行時の経路——プリンターの設定を解決するときの利用者・使い回しの持ち主の一致・プリンターを開くときの持ち主——を、
 * 認証ありで通して固定する（以前は認証を通すテストが 1 本も無く、この 3 か所の認可を外しても全テストが緑だった）
 */
describe("関連付けるプリンター: 信頼境界（認証あり）", () => {
  const alice: AuthUser = { username: "alice", role: "user" };
  const bob: AuthUser = { username: "bob", role: "user" };
  const root: AuthUser = { username: "root", role: "admin" };
  const PERSONAL = (owner: string, sessions: unknown[]) =>
    new PersonalConfigStore({ systems: [{ id: "s-1", name: "sys", host: "h", owner }], sessions: sessions as never }, undefined);
  const openAs = async (user: AuthUser | undefined, mgr: Recording, resolver: ConfigResolver, session: string) => {
    const sent: WsServerMessage[] = [];
    const c = new WsConnection({ sessions: mgr, resolver }, { send: (d) => sent.push(JSON.parse(d)), close: () => {} }, user);
    await c.handle(JSON.stringify({ type: "open", session }));
    return sent;
  };

  it("**一般ユーザーは自分のプリンターを起こせ、そのプリンターは持ち主（自分）で開かれる**", async () => {
    const mgr = new Recording();
    const resolver = new ConfigResolver(
      new ServerConfigStore({ systems: [], sessions: [] }),
      PERSONAL("alice", [
        { id: "p", name: "p", system: "s-1", sessionType: "printer", owner: "alice", deviceName: "SETNAME" },
        { id: "d", name: "d", system: "s-1", sessionType: "display", owner: "alice", associatedPrinterSession: "p" }
      ])
    );
    const sent = await openAs(alice, mgr, resolver, "own:d");
    expect(sent.find((m) => m.type === "opened")).toBeDefined();
    expect(mgr.printersOpened[0]).toMatchObject({ owner: "alice", ref: "own:p" });
    expect(mgr.displays[0]!.associatedPrinter).toBe("PRTA");
    mgr.closeAll();
  });

  it("**他人のプリンターを指す手書きのファイルでも、関連付けなしで開き、他人のプリンターは開かない**（`resolve` に利用者を渡す）", async () => {
    const mgr = new Recording();
    const resolver = new ConfigResolver(
      new ServerConfigStore({ systems: [], sessions: [] }),
      PERSONAL("alice", [
        { id: "bp", name: "bp", system: "s-1", sessionType: "printer", owner: "bob" },
        { id: "d", name: "d", system: "s-1", sessionType: "display", owner: "alice", associatedPrinterSession: "bp" }
      ])
    );
    const sent = await openAs(alice, mgr, resolver, "own:d");
    expect(sent.find((m) => m.type === "opened")).toMatchObject({ associatedPrinterIssue: "invalid" });
    expect(mgr.printersOpened, "他人のプリンターを開かない").toHaveLength(0);
    mgr.closeAll();
  });

  it("**同じ設定の参照でも、持ち主が違えば使い回さない**（別の利用者のプリンターを掴まない）", async () => {
    const mgr = new Recording();
    const store = () =>
      new PersonalConfigStore(
        {
          systems: [{ id: "s-1", name: "sys", host: "h", owner: "alice" }, { id: "s-2", name: "sys", host: "h", owner: "bob" }],
          sessions: [
            { id: "p", name: "p", system: "s-1", sessionType: "printer", owner: "alice" },
            { id: "d", name: "d", system: "s-1", sessionType: "display", owner: "alice", associatedPrinterSession: "p" }
          ] as never
        },
        undefined
      );
    const resolver = new ConfigResolver(new ServerConfigStore({ systems: [], sessions: [] }), store());
    await openAs(alice, mgr, resolver, "own:d");
    // 同じ ref のプリンターを bob が持っていると装う（alice のエントリは alice の持ち物）
    const printers = [...mgr.listPrinters()];
    expect(printers).toHaveLength(1);
    expect(printers[0]!.owner).toBe("alice");
    // bob が同じ参照の表示を開いても、alice のプリンターは使い回されない（自分のものを探す＝無いので新しく開こうとする）
    const before = mgr.printersOpened.length;
    const bobResolver = new ConfigResolver(
      new ServerConfigStore({ systems: [], sessions: [] }),
      new PersonalConfigStore(
        {
          systems: [{ id: "s-2", name: "sys", host: "h", owner: "bob" }],
          sessions: [
            { id: "p", name: "p", system: "s-2", sessionType: "printer", owner: "bob" },
            { id: "d", name: "d", system: "s-2", sessionType: "display", owner: "bob", associatedPrinterSession: "p" }
          ] as never
        },
        undefined
      )
    );
    await openAs(bob, mgr, bobResolver, "own:d");
    expect(mgr.printersOpened.length, "bob は自分のプリンターを新しく開く").toBe(before + 1);
    expect([...mgr.listPrinters()].map((p) => p.owner).sort()).toEqual(["alice", "bob"]);
    mgr.closeAll();
  });

  it("**サーバー設定のプリンターは、admin と認証オフでは直接開くときと同じ設定（出力）で開く**", async () => {
    const out = { autoPdfDir: "/var/spool/pdf" };
    for (const user of [root, undefined]) {
      const mgr = new Recording();
      const resolver = new ConfigResolver(
        new ServerConfigStore({
          systems: [{ id: "sys", name: "sys", host: "h" }],
          sessions: [
            { id: "prt", name: "prt", system: "sys", sessionType: "printer", printer: out } as ServerSession,
            disp()
          ]
        }),
        new PersonalConfigStore()
      );
      await openAs(user, mgr, resolver, "srv:d");
      expect(mgr.printersOpened[0], user ? "admin" : "認証オフ").toMatchObject({ output: expect.objectContaining({ autoPdfDir: "/var/spool/pdf" }) });
      mgr.closeAll();
    }
  });

  it("**一般ユーザーは、サーバー設定のプリンターを指す表示を開けない**（サーバー設定は admin 専用。プリンターの出力設定も使えない）", async () => {
    const mgr = new Recording();
    const resolver = new ConfigResolver(
      new ServerConfigStore({
        systems: [{ id: "sys", name: "sys", host: "h" }],
        sessions: [{ id: "prt", name: "prt", system: "sys", sessionType: "printer", printer: { autoPdfDir: "/var/spool/pdf" } } as ServerSession, disp()]
      }),
      new PersonalConfigStore()
    );
    const sent = await openAs(alice, mgr, resolver, "srv:d");
    expect(sent.find((m) => m.type === "error")).toMatchObject({ code: "FORBIDDEN" });
    expect(mgr.printersOpened, "プリンターも開かない").toHaveLength(0);
    mgr.closeAll();
  });
});

/**
 * **関連付けの準備を監査に残す**（`20260921-assoc-printer-audit`。節目 10 の独立点検 C-N5）。サーバーが利用者に代わってプリンターを起こす副作用は、
 * 直接開く `ws_open_printer` と同じく証跡に残す。記録は種別・結果・時間だけ（設定名・装置名は載せない。spec D14）
 */
describe("関連付けの監査（ws_associated_printer）", () => {
  const events: AuditEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    setAuditSink((e) => events.push(e));
  });
  afterEach(() => {
    setAuditSink(() => {}); // 後続テストへ漏らさない
  });
  const assoc = () => events.filter((e) => e.op === "ws_associated_printer");

  it("**成功は ok を 1 件**。載せるのは op・sessionId（起こしたプリンター）・result・durationMs だけ（設定名・装置名を入れない）", async () => {
    const mgr = new Recording();
    await openDisplay(mgr, [prt, disp()]);
    expect(assoc()).toHaveLength(1);
    expect(assoc()[0]).toMatchObject({ op: "ws_associated_printer", result: "ok" });
    expect(Object.keys(assoc()[0]!).sort(), "値を載せない").toEqual(["durationMs", "op", "result", "sessionId"]);
    // どのプリンターが起きたかを追える（A-S8）。装置名（PRTA）や設定名（prt）そのものではなく、実行時に振る ID
    const started = [...mgr.listPrinters()][0]!;
    expect(assoc()[0]!.sessionId).toBe(started.id);
    expect(assoc()[0]!.sessionId).not.toBe("PRTA");
    mgr.closeAll();
  });

  it("**時間は実際にかかった分を載せる**（装置名が決まるまで待った分。常に 0 ではない）", async () => {
    const mgr = new SlowRecording();
    await openDisplay(mgr, [prt, disp()]);
    expect(assoc()).toHaveLength(1);
    // 起動応答は 400ms 遅れる（`SlowPrinterTransport`）。タイマーの誤差を見込んで 300ms を下限にする
    expect(assoc()[0]!.durationMs ?? 0).toBeGreaterThanOrEqual(300);
    mgr.closeAll();
  });

  it("**使い回しでも 1 件**（開き直さなくても、この表示のための関連付けとして残す）", async () => {
    const mgr = new Recording();
    await openDisplay(mgr, [prt, disp()]);
    await openDisplay(mgr, [prt, disp()]);
    expect(assoc()).toHaveLength(2);
    mgr.closeAll();
  });

  it("**指した設定が使えないときは error と code `invalid`**", async () => {
    const mgr = new Recording();
    const notPrinter = { id: "prt", name: "prt", system: "sys", sessionType: "display" } as ServerSession;
    await openDisplay(mgr, [notPrinter, disp()]);
    expect(assoc()).toMatchObject([{ result: "error", code: "invalid" }]);
    mgr.closeAll();
  });

  it("**プリンターを開けないときは error と code `failed`**", async () => {
    class FailingRecording extends Recording {
      override openPrinter(): Promise<never> {
        return Promise.reject(new Error("boom"));
      }
    }
    const mgr = new FailingRecording();
    await openDisplay(mgr, [prt, disp()]);
    expect(assoc()).toMatchObject([{ result: "error", code: "failed" }]);
    mgr.closeAll();
  });

  it("**関連付けを指さない表示では記録しない**", async () => {
    const mgr = new Recording();
    await openDisplay(mgr, [prt, disp({ associatedPrinterSession: undefined })]);
    expect(assoc()).toHaveLength(0);
    mgr.closeAll();
  });
});
