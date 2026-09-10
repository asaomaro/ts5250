/**
 * **セッション寿命の組合せ表（サーバー側）を実装に当てる**
 * （`20260908-session-lifetime-rules-fold` AC4）。
 *
 * 期待値は書かない——`packages/web-ui/test/session-lifetime-matrix.ts` の `SERVER_CASES`
 * （64 行）がそのまま入力になる。表は**畳み込みの前に現行実装を読んで**埋めてあるので、
 * ここが緑であることが「振る舞いを変えていない」の証拠になる。逆に言えば
 * **このファイルで期待値を作ってはいけない**（作ると安全網ではなくなる）。
 *
 * ## 何を組み立てているか
 *
 * 表の 1 行は「端末種別 × 役割 × 他に見ている人 × 切れ方」で、そこから状況を組み立てるのが
 * `buildSituation()`。返る `Situation` は**結論の読み取り口だけ**を公開する
 * （在るか・猶予中か・プリンターの state）ので、`expectOutcome()` は端末種別を知らずに済む。
 *
 * ## 心拍の死判定を、偽タイマー無しで起こす
 *
 * `hb.now` を差し替えて**時計だけを跳ばす**（間隔は実時間の 25ms）。偽タイマーだと
 * 3270 / VT の実 TCP 交渉が進まず、**端末種別ごとに別の起こし方**を書く羽目になる
 * ——4 種類を同じレールに乗せるためにこちらを採る。
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager, type OpenPrinterOptions } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { Tn3270Manager } from "../src/tn3270-manager.js";
import { VtManager } from "../src/vt-manager.js";
import type { WsServerMessage } from "../src/ws-messages.js";
import { startMini3270, type Mini3270 } from "../../tn3270/test/harness/mini3270.js";
import { SERVER_CASES, type ServerCase } from "../../web-ui/test/session-lifetime-matrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signon = () => parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

/** 心拍の見張り。**間隔だけ実時間**で、死判定は `now` を跳ばして起こす */
const HB_INTERVAL_MS = 25;
const HB_DEAD_MS = 1_000;

/** 差し替えた時計。`hb.now` がここを読む */
interface Clock {
  t: number;
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await settle(5);
  }
  return cond();
}

/**
 * startup だけ返す最小のプリンター transport（`ws-lifetime.test.ts` の版に `hostEnd` を足したもの）。
 */
class PrinterTransport implements Transport {
  private dataFn: ((d: Uint8Array) => void) | undefined;
  private closeFn: ((reason: string) => void) | undefined;
  send(): void {}
  /**
   * **閉じても onClose を鳴らさない**（元の版と同じ）。鳴らすと後片づけの `closeAll` が
   * 常駐プリンターの「張り直し」を起こし、**捨てたはずのエントリが接続を張り続ける**
   * （`session-manager.close` の ⚠ と同じ罠）。ホスト終了は下の `hostEnd` から明示的に起こす
   */
  close(): void {}
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  /** Telnet は交渉中と交渉後の 2 回張る。**後勝ちでよい**（後の 1 本が `handleClose` を呼ぶ） */
  onClose(fn: (reason: string) => void): void {
    this.closeFn = fn;
  }
  onError(): void {}
  start(): void {
    const body = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xc9, 0xf9, 0xf0, 0xf2];
    const ll = body.length + 2;
    this.dataFn?.(Uint8Array.from([(ll >> 8) & 0xff, ll & 0xff, ...body, 0xff, 0xef]));
  }
  /** **ホスト側が接続を終わらせた**（表の `hostEnded`）。`PrinterSession` の `closed` が飛ぶ */
  hostEnd(): void {
    this.closeFn?.("host ended");
  }
}

/** transport を差し込む Manager（`ws-reconnect-resume.test.ts` と同じ） */
class InjectingManager extends SessionManager {
  constructor(opts?: ConstructorParameters<typeof SessionManager>[0]) {
    super(opts);
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: new ReplayTransport(signon()) });
  }
  override openPrinter(opts: OpenPrinterOptions) {
    return super.openPrinter({ ...opts, transport: new PrinterTransport() });
  }
}

/**
 * 保存済み設定。プリンターを 2 本持つ——**常駐かどうかは「サービスとして利用する」で決まる**
 * （`20260801-service-lifecycle-model` design D3）。出力設定の有無からは導出しない
 */
const resolver = (): ConfigResolver =>
  new ConfigResolver(
    new ServerConfigStore({
      systems: [{ id: "p", name: "p", host: "h" }],
      sessions: [
        { id: "prt", name: "prt", system: "p", sessionType: "printer" },
        { id: "prtSvc", name: "prtSvc", system: "p", sessionType: "printer", printer: { service: true } }
      ]
    }),
    new PersonalConfigStore()
  );

interface Deps {
  sessions?: SessionManager;
  tn3270?: Tn3270Manager;
  vt?: VtManager;
}

interface Conn {
  c: WsConnection;
  sent: WsServerMessage[];
}

/**
 * WS 接続を 1 本作る。`clock` を渡した接続だけが**心拍で死ぬ**——脇役まで死判定に
 * 巻き込むと、主役が去る前に状況が崩れる
 */
function conn(deps: Deps, clock?: Clock): Conn {
  const sent: WsServerMessage[] = [];
  const hb = clock
    ? { intervalMs: HB_INTERVAL_MS, deadMs: HB_DEAD_MS, now: (): number => clock.t }
    : {};
  const c = new WsConnection(
    { sessions: deps.sessions ?? new SessionManager(), resolver: resolver(), ...(deps.tn3270 ? { tn3270: deps.tn3270 } : {}), ...(deps.vt ? { vt: deps.vt } : {}) },
    { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} },
    undefined,
    hb
  );
  return { c, sent };
}

const openedId = (sent: readonly WsServerMessage[]): string => {
  const m = sent.find((x) => x.type === "opened" || x.type === "printer-opened" || x.type === "vt-opened");
  if (m === undefined || !("sessionId" in m)) throw new Error("opened が返っていない");
  return m.sessionId;
};

/**
 * 表の 1 行ぶんの状況。**結論の読み取り口だけ**を公開する——端末種別ごとの違い
 * （どのマネージャに載るか・何が「在る」か）はここで吸収し、`expectOutcome` は種別を知らない
 */
interface Situation {
  /** 主役の接続がサーバーから受け取ったもの */
  sent: WsServerMessage[];
  /** 表の「切れ方」を起こし、影響が落ち着くまで待つ */
  trigger: () => Promise<void>;
  /** そのセッションのエントリがまだ在るか */
  exists: () => boolean;
  /** 猶予に入っているか（表示セッション以外は常に偽） */
  held: () => boolean;
  /** プリンターの state（プリンター以外は undefined） */
  printerState: () => string | undefined;
  cleanup: () => Promise<void>;
}

/**
 * 主役を去らせる（`hostEnded` 以外の 3 つ）。
 * 心拍だけは**時計を跳ばして**起こし、後始末が走ったこと（`closed` が飛ぶ）まで待つ
 */
async function leave(c: ServerCase, subject: Conn, clock: Clock): Promise<void> {
  switch (c.disconnect) {
    case "clientClose":
      await subject.c.handle(JSON.stringify({ type: "close" }));
      return;
    case "transportLost":
      subject.c.onSocketClose();
      return;
    case "heartbeatDead": {
      clock.t += HB_DEAD_MS * 2;
      const done = await waitFor(() => subject.sent.some((m) => m.type === "closed"));
      expect(done, "心拍の死判定が起きていない").toBe(true);
      return;
    }
    default:
      throw new Error(`leave に ${c.disconnect} は来ない`);
  }
}

/** ---- 5250 表示セッション（32 行） ---- */
async function buildDisplay(c: ServerCase): Promise<Situation> {
  const clock: Clock = { t: 0 };
  const mgr = new InjectingManager();
  const deps: Deps = { sessions: mgr };
  let id: string;
  let subject: Conn;

  if (c.role === "viewer") {
    // **WS を持たない相手（MCP / HLLAPI）が開いたセッションを、あとから見に来る。**
    // 開いた側の接続を残すと「他に見ている人が居る」で先に弾かれ、
    // 「見に来ただけ」の区別を素通ししてしまう（`ws-reconnect-resume.test.ts` の同じ注記）
    id = (await mgr.open({ host: "h" })).id;
    subject = conn(deps, clock);
    await subject.c.handle(JSON.stringify({ type: "open", sessionId: id }));
  } else {
    subject = conn(deps, clock);
    await subject.c.handle(JSON.stringify({ type: "open", host: "h" }));
    id = openedId(subject.sent);
    if (c.role !== "owner") {
      // **座だけを譲る**（後任を WS 接続で立てない）。プリンターの行と同じ作り方。
      //
      // 接続で立てると、**表示セッションでは後任も「見ている人」に数えられる**
      // （`subscribeSession` が `addViewer` を呼ぶ。`ws-handler.ts:879`）ので、
      // `otherViewer: false` の行なのに在席 1 の状況になり、**在席の判定（ゲート1）が
      // 先に効いて保持者ガードを素通しする**——T2 のタスク点検が変異試験で実証した
      // （`abandoned` を常に `true` にする変異を当てても、5250 の `handedPresent` 3 行は
      // 緑のまま通った）。座の状態そのものを作れば、ガードの効き目がこの行で見える
      const heirToken = mgr.claim(id);
      expect(mgr.hasHolder(id), "後任が座を取れていない").toBe(true);
      if (c.role === "handedOverAbsent") {
        // **後任が先に去る**（座だけが空く。主役はまだ見ている）
        expect(mgr.releaseHolder(id, heirToken), "座を返せていない").toBe(true);
        expect(mgr.hasHolder(id), "座が空いていない").toBe(false);
      }
      expect(mgr.size, "組み立ての途中でセッションが畳まれた").toBe(1);
    }
  }

  if (c.otherViewer === true) {
    // 「他に見ている人」＝ resume 無しの attach。**後任（resume）とは別の軸**
    const viewer = conn(deps);
    await viewer.c.handle(JSON.stringify({ type: "open", sessionId: id }));
  }

  const exists = (): boolean => {
    try {
      mgr.get(id);
      return true;
    } catch {
      return false;
    }
  };

  return {
    sent: subject.sent,
    trigger: async () => {
      if (c.disconnect !== "hostEnded") return leave(c, subject, clock);
      // ホスト側の終了。**`dispose` を通らない別経路**なので、transport を終端させて
      // セッションの `closed` を発火させる（`SessionManager.open` の購読がエントリを消す）
      mgr.get(id).session.disconnect();
      await waitFor(() => !exists());
    },
    exists,
    held: () => mgr.isHeld(id),
    printerState: () => undefined,
    cleanup: async () => {
      mgr.closeAll();
    }
  };
}

/** ---- プリンター（24 行） ---- */
async function buildPrinter(c: ServerCase): Promise<Situation> {
  const clock: Clock = { t: 0 };
  const mgr = new InjectingManager({
    // **張り直しの待ちは進めない。** ここで見たいのは「張り直しに入った」ことであって
    // 張り直しが成功することではない。進めると同じ transport で繋ぎ直して `listening` に
    // 戻り、行の意味（`printerRetry`）が消える
    delay: () => new Promise<void>(() => undefined)
  });
  const deps: Deps = { sessions: mgr };
  const ref = c.resident === true ? "srv:prtSvc" : "srv:prt";
  const open = async (clk?: Clock): Promise<Conn> => {
    const k = conn(deps, clk);
    await k.c.handle(JSON.stringify({ type: "open", kind: "printer", session: ref }));
    return k;
  };

  const subject = await open(clock);
  const id = openedId(subject.sent);
  expect(mgr.isResident(id), "常駐の軸が設定どおりに効いていない").toBe(c.resident === true);

  if (c.role === "handedOverPresent") {
    // 同じ定義を二度開く＝**既存エントリに相乗りして座を引き取る**（`openPrinter` の ref 一致）。
    // プリンターは在席を数えないので、**保持者ガードの効き目が見えるのはこの経路だけ**
    const heir = await open();
    expect(openedId(heir.sent), "同じ定義なのに別エントリになった").toBe(id);
  } else if (c.role === "handedOverAbsent") {
    // **座だけを空ける。** 後任を WS で立てて去らせると、非常駐プリンターは
    // その離脱で**エントリごと畳まれてしまう**（在席を数えないので `dispose` が閉じる側に回る）
    // ——`hostEnded` の行が「エントリは残る」を要求しているので、それでは組み立てられない。
    // 表の役割が言っているのは座の状態そのものなので、`claim` → `releaseHolder` で作る
    const token = mgr.claim(id);
    expect(mgr.releaseHolder(id, token)).toBe(true);
    expect(mgr.hasHolder(id)).toBe(false);
  }

  const entry = () => mgr.listPrinters().find((e) => e.id === id);

  return {
    sent: subject.sent,
    trigger: async () => {
      if (c.disconnect !== "hostEnded") return leave(c, subject, clock);
      const tr = entry()?.openOpts.transport;
      expect(tr, "差し込んだ transport が見つからない").toBeInstanceOf(PrinterTransport);
      (tr as PrinterTransport).hostEnd();
      await waitFor(() => entry()?.state !== "listening");
    },
    exists: () => entry() !== undefined,
    held: () => mgr.isHeld(id),
    printerState: () => entry()?.state,
    cleanup: async () => {
      // **張り直しを降ろしてから捨てる**（`close` が `reconnecting` を落とす）
      await mgr.close(id).catch(() => undefined);
      mgr.closeAll();
    }
  };
}

/** 保護欄「USER」と非保護欄を持つ画面（`ws-tn3270.test.ts` から） */
const SCREEN_3270 = Uint8Array.from([
  0xf5, 0xc2,
  0x11, 0x40, 0x40, 0x1d, 0x60, 0xe4, 0xe2, 0xc5, 0xd9,
  0x11, 0x40, 0x4a, 0x1d, 0x00,
  0x11, 0x40, 0x5a, 0x1d, 0x60,
  0x11, 0x40, 0x4b, 0x13
]);

/** `mini3270` は渡した番号をそのまま待ち受ける（0 で自動割り当てにはならない） */
let next3270Port = 3470;

/** ---- 3270（4 行）---- */
async function build3270(c: ServerCase): Promise<Situation> {
  const clock: Clock = { t: 0 };
  const port = next3270Port++;
  const tn3270 = new Tn3270Manager();
  const mini: Mini3270 = await startMini3270({ records: [SCREEN_3270], port });
  const subject = conn({ tn3270 }, clock);
  await subject.c.handle(JSON.stringify({ type: "open", terminal: "3270", host: "127.0.0.1", port }));
  expect(await waitFor(() => subject.sent.some((m) => m.type === "opened"))).toBe(true);
  const id = openedId(subject.sent);

  // **ホスト側が本当に終わったこと**をテスト側で見張る。サーバーは 3270 の終了を購読して
  // いない（`tn3270-manager.ts`）ので、これが無いと「まだ届いていないだけ」を
  // 「何も起きない」と読んでしまう
  let hostClosed = false;
  tn3270.get(id).session.on("close", () => {
    hostClosed = true;
  });

  return {
    sent: subject.sent,
    trigger: async () => {
      if (c.disconnect !== "hostEnded") return leave(c, subject, clock);
      await mini.close();
      expect(await waitFor(() => hostClosed), "ホスト側が終わっていない").toBe(true);
      await settle(50); // 何かが飛ぶなら届いているはずの間
    },
    exists: () => tn3270.size > 0,
    held: () => false,
    printerState: () => undefined,
    cleanup: async () => {
      tn3270.closeAll();
      await mini.close();
    }
  };
}

interface MiniTelnet {
  port: number;
  /**
   * ホスト側から接続を切る（表の `hostEnded`）。
   *
   * ⚠ **受け付けを待ってから切る。** `VtSession.open()` は TCP が繋がった時点で返り、
   * サーバー側の `connection` はそのあとに配られることがある——待たずに切ると
   * **まだ空の集合を回して何も起きず**、「ホストが終わっても消えない」に見える（実測で踏んだ）
   */
  killHost: () => Promise<void>;
  close: () => Promise<void>;
}

/** ECHO / SGA を握る最小の telnet サーバー（`ws-vt.test.ts` の縮小版） */
async function startMiniTelnet(): Promise<MiniTelnet> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("data", () => undefined);
    s.on("error", () => undefined);
    s.write(Buffer.from([255, 251, 1, 255, 251, 3])); // IAC WILL ECHO / IAC WILL SGA
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const destroy = (): void => {
    for (const s of sockets) s.destroy();
  };
  return {
    port,
    killHost: async () => {
      expect(await waitFor(() => sockets.size > 0), "ホスト側がまだ受け付けていない").toBe(true);
      destroy();
    },
    close: () =>
      new Promise<void>((done) => {
        destroy();
        server.close(() => done());
      })
  };
}

/** ---- VT（4 行）---- */
async function buildVt(c: ServerCase): Promise<Situation> {
  const clock: Clock = { t: 0 };
  const vt = new VtManager();
  const mini = await startMiniTelnet();
  const subject = conn({ vt }, clock);
  await subject.c.handle(
    JSON.stringify({ type: "open", terminal: "vt", host: "127.0.0.1", port: mini.port })
  );
  expect(await waitFor(() => subject.sent.some((m) => m.type === "vt-opened"))).toBe(true);

  return {
    sent: subject.sent,
    trigger: async () => {
      if (c.disconnect !== "hostEnded") return leave(c, subject, clock);
      // ホストが切る → `VtSession` の close → **vt-manager がエントリを消し**
      // `closeSubscribers` が `closed{ended:true}` を送る
      await mini.killHost();
      await waitFor(() => vt.size === 0);
    },
    exists: () => vt.size > 0,
    held: () => false,
    printerState: () => undefined,
    cleanup: async () => {
      vt.closeAll();
      await mini.close();
    }
  };
}

function buildSituation(c: ServerCase): Promise<Situation> {
  switch (c.terminal) {
    case "5250":
      return buildDisplay(c);
    case "printer":
      return buildPrinter(c);
    case "3270":
      return build3270(c);
    case "vt":
      return buildVt(c);
  }
}

/**
 * 表の結論を実際の状態に当てる。**行ごとの分岐を書かない**——`outcome` の語だけで決まる
 * （どう組み立てたかは `Situation` が隠している）
 */
function expectOutcome(c: ServerCase, s: Situation, sentBefore: number): void {
  const ended = (): boolean => s.sent.some((m) => m.type === "closed" && m.ended === true);
  switch (c.outcome) {
    case "close":
      expect(s.exists(), "閉じるはずが残っている").toBe(false);
      return;
    case "hold":
      expect(s.exists(), "猶予のはずが消えている").toBe(true);
      expect(s.held(), "猶予に入っていない").toBe(true);
      return;
    case "keep":
      expect(s.exists(), "残るはずが消えている").toBe(true);
      expect(s.held(), "猶予に入れてはいけない").toBe(false);
      // **「残っている」だけでは足りない。** エントリを残したまま待ち受けだけ降ろす
      // 変異（`dispose` から `stopPrinter` を呼ぶ）が 65 件すべて素通りした
      // ——プリンターの行では「何も起きない」＝状態も変わらないことまで見る
      if (c.terminal === "printer") {
        expect(s.printerState(), "待ち受けが降りている（keep は何も起きないこと）").toBe("listening");
      }
      return;
    case "entryRemoved":
      expect(s.exists(), "エントリが残っている").toBe(false);
      // `dispose` 由来の `closed` と区別する。**ホストが終わった側だけ `ended` が立つ**
      expect(ended(), "closed{ended:true} が届いていない").toBe(true);
      return;
    case "printerError":
      expect(s.exists(), "printers からは消さないはず").toBe(true);
      expect(s.printerState()).toBe("error");
      return;
    case "printerRetry":
      expect(s.exists(), "printers からは消さないはず").toBe(true);
      expect(s.printerState()).toBe("reconnecting");
      return;
    case "nothing":
      expect(s.exists(), "エントリが消えている").toBe(true);
      // **`closed` が来ないことだけでは足りない**——`error` など別種の通知が増えても通る。
      // 心拍（`ping`）だけは切れ方と無関係に流れ続けるので除き、**それ以外が 1 通も無い**ことを見る
      expect(
        s.sent.slice(sentBefore).map((m) => m.type).filter((t) => t !== "ping"),
        "何も届かないはずが、終了に関する通知が送られている"
      ).toEqual([]);
      return;
  }
}

/** 実際に回した行。**飛ばした行が無いこと**を最後に見る（`it.each` の空振り対策） */
const covered = new Set<string>();

for (const terminal of ["5250", "printer", "3270", "vt"] as const) {
  const rows = SERVER_CASES.filter((c) => c.terminal === terminal);
  describe(`${terminal}（${rows.length} 行）`, () => {
    it.each([...rows])("$id → $outcome", async (c: ServerCase) => {
      covered.add(c.id);
      const s = await buildSituation(c);
      try {
        // 「何も届かない」を言うために、切れ方を起こす**前**の送信数を控える
        const sentBefore = s.sent.length;
        await s.trigger();
        expectOutcome(c, s, sentBefore);
      } finally {
        await s.cleanup();
      }
    }, 30_000);
  });
}

describe("表を丸ごと回したか", () => {
  it("64 行すべてが実際に検証された（飛ばした行・空振りが無い）", () => {
    expect(SERVER_CASES.length).toBe(64);
    expect([...covered].length).toBe(SERVER_CASES.length);
    // id が重複していると Set が縮んで「回した」に見えるので、表の側も見る
    expect(new Set(SERVER_CASES.map((c) => c.id)).size).toBe(SERVER_CASES.length);
  });
});
