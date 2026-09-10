/**
 * **セッション寿命の組合せ表（クライアント側）を回す**（`20260908-session-lifetime-rules-fold` AC4）。
 *
 * 期待値は `session-lifetime-matrix.ts` に**先に**書いてある——畳み込みの後に書くと
 * 畳み込み後のコードに合わせた期待値になり、安全網として機能しないため。ここは
 * **表から回すだけ**で、行ごとの手書きはしない（22 行を写経すると、直すときに片方だけ
 * 直る形で必ずずれる）。
 *
 * **表が 1 つであることも機械で固定する。** サーバー側の 64 行を `clientViewOf()` で
 * 射影したキーと、こちらの 20 行の `id` を突き合わせる——片側にしか無い組合せが
 * 生まれた瞬間に落ちる。
 *
 * 土台は `session-reconnect.test.ts`（`WsClient` をモジュールごとモックし、fake timers と
 * ジッター固定で待ち時間を表どおりに進める）。違いは**軸ごとに開き方・切り方・見る場所が
 * 変わる**ことなので、そこだけをヘルパー（`openFor` / `applyDisconnect` / `expectOutcome`）に
 * 閉じ込めてある。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScreenSnapshot } from "@ts5250/tn5250";
import {
  CLIENT_CASES,
  CLIENT_ORDER_CASES,
  SERVER_CASES,
  clientViewOf,
  type ClientCase
} from "./session-lifetime-matrix.js";

/** 生成された `WsClient` を順に捕まえる（1 本目＝最初の接続、2 本目以降＝繋ぎ直し） */
interface FakeHandlers {
  onServerMessage: (m: unknown) => void;
  onClose?: () => void;
}
interface Fake {
  handlers: FakeHandlers;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
let clients: Fake[] = [];

vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    close = vi.fn();
    // 型だけの参照なので `vi.mock` の巻き上げに掛からない（値を掴むと初期化順で落ちる）
    constructor(_url: string, handlers: FakeHandlers) {
      clients.push({ handlers, send: this.send, close: this.close });
    }
    connect() {
      return Promise.resolve();
    }
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));

import { openSession, openVtSession, openPrinterSession, closeSession, sendKey } from "../src/session-controller.js";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import { vtStore } from "../src/stores/vt.js";
import { MSG_CONNECTION_LOST, MSG_SESSION_ENDED, MSG_VT_CONNECTION_LOST } from "../src/composables/opMessages.js";

/** 端末ごとに別の id を使う（後片付けの取りこぼしを次の行へ持ち越さない） */
const DSP_ID = "s1"; //  5250 / 3270
const VT_ID = "vt1";
const PRT_ID = "prt1";

/** ホストが終わったときにサーバーが添えてくる理由。**捨てられていないこと**を見るために具体値にする */
const HOST_REASON = "host closed";

/**
 * `opened` に載せる最小の画面。
 *
 * **中身は問わない**——この表が見るのは寿命の判定であって画面の内容ではない。
 * `as unknown as` で型を曲げているのは、`ScreenSnapshot` の全フィールドを埋めても
 * 見るものが増えないため（埋めると、増えたフィールドのたびにここが壊れる）。
 */
function snap(): ScreenSnapshot {
  return {
    sessionId: DSP_ID,
    rows: 24,
    cols: 80,
    cursor: { row: 1, col: 1 },
    keyboardLocked: false,
    cells: [],
    fields: []
  } as unknown as ScreenSnapshot;
}

/** `vt-opened` に載る全画面フレーム（中身は問わないので最小） */
function vtFrame() {
  return {
    rows: 3,
    cols: 20,
    cursor: { row: 0, col: 0, visible: true },
    alternate: false,
    title: "",
    styles: [],
    lines: []
  };
}

/** `printer-opened`。待ち受け中の常態から始める（`state` が動くことを見たいため） */
function printerOpened() {
  return {
    type: "printer-opened",
    sessionId: PRT_ID,
    state: "listening",
    startupCode: "I902",
    hasOutput: false,
    outputEnabled: true,
    outputWarnings: [],
    outputStatuses: [],
    reports: [],
    receivedTotal: 0
  };
}

/** 1 行ぶんの状況。**閉じたあとも見たい**ので `state` は参照で持つ（store からは消える） */
interface Ctx {
  readonly sessionId: string;
  /** 最初に張った口。切れ方はここから起こす */
  readonly first: Fake;
  readonly state: SessionState;
}

/**
 * 表の軸「端末種別 × 見に来ただけか」から、その状況を組み立てる。
 *
 * **開く関数が 3 つに分かれている**のがこの軸の実体——5250 / 3270 は `openSession`、
 * VT は `openVtSession`、プリンターは `openPrinterSession` で、届く `opened` も別物。
 * 「見に来ただけ」は `open` に `sessionId` を渡した場合（`attachedOnly` が立つ）。
 */
async function openFor(c: Pick<ClientCase, "terminal" | "attachedOnly">): Promise<Ctx> {
  switch (c.terminal) {
    case "vt": {
      const p = openVtSession({ type: "open", host: "h", terminal: "vt" }, "t", { terminal: "vt" });
      clients[0]!.handlers.onServerMessage({
        type: "vt-opened",
        sessionId: VT_ID,
        frame: vtFrame(),
        encoding: "utf-8",
        ibmI: true,
        hostEchoes: true
      });
      await p;
      return ctx(VT_ID);
    }
    case "printer": {
      const p = openPrinterSession({ type: "open", host: "h", kind: "printer" }, "t");
      clients[0]!.handlers.onServerMessage(printerOpened());
      await p;
      return ctx(PRT_ID);
    }
    default: {
      // 3270 は 5250 と**同じ関数**で開く。区別は `meta.terminal` だけ（`decisions.md` D3）
      const p = openSession(
        c.attachedOnly ? { type: "open", sessionId: DSP_ID } : { type: "open", host: "h" },
        "t",
        c.terminal === "3270" ? { terminal: "3270" } : undefined
      );
      clients[0]!.handlers.onServerMessage({
        type: "opened",
        sessionId: DSP_ID,
        screen: snap(),
        ccsid: 1399,
        pcCommand: false
      });
      await p;
      return ctx(DSP_ID);
    }
  }
}

function ctx(sessionId: string): Ctx {
  return { sessionId, first: clients[0]!, state: sessionsStore.get(sessionId)! };
}

/**
 * 表の軸「切れ方」を起こす。
 *
 * **`hostEnded` だけ WebSocket を閉じない**——サーバーからメッセージが届くだけで転送は生きている。
 * ここを `onClose` と混ぜると、繋ぎ直しの門を通る／通らないの差が消えて表の意味が無くなる。
 */
function applyDisconnect(c: ClientCase, x: Ctx): void {
  switch (c.disconnect) {
    case "clientClose": {
      // 利用者が閉じた。**そのあと転送も閉じる**ので、遅れて来る `onClose` まで起こして
      // 「閉じたあとに繋ぎ直しへ入らない」ことを見る
      closeSession(x.sessionId);
      x.first.handlers.onClose?.();
      break;
    }
    case "transportLost": {
      x.first.handlers.onClose?.();
      break;
    }
    case "heartbeatDead": {
      // **`ws-client` の `ping` 見張りが自分から `close()` を呼び、`onClose` に合流する。**
      // ここは `WsClient` をモジュールごと差し替えているので見張りは動かない——
      // 「見張りの発火 → `onClose`」が本物であることは下の同値テストで別に固定してある
      // （`ws-ping-watchdog.test.ts` と同じ経路）。よってこの軸は `onClose` と同じ入口で回す
      x.first.handlers.onClose?.();
      break;
    }
    case "hostEnded": {
      hostEnded(c, x);
      break;
    }
  }
}

/** ホスト側の終了。**端末種別ごとに届くものが違う**（届かない種別もある） */
function hostEnded(c: ClientCase, x: Ctx): void {
  if (c.terminal === "printer") {
    // プリンターは `closed` ではなく `printer-state` で知る（転送は生きたまま state だけ動く）
    x.first.handlers.onServerMessage({
      type: "printer-state",
      sessionId: x.sessionId,
      state: "error",
      error: HOST_REASON
    });
    return;
  }
  if (c.terminal === "3270") {
    // **何も届かない。** サーバーが 3270 のホスト終了を購読していないので、
    // `closed` も `close` イベントも起きない（`tn3270-manager.ts:78`）。
    // 「起こさない」ことがこの行の内容そのものなので、ここは意図的に空
    return;
  }
  x.first.handlers.onServerMessage({ type: "closed", reason: HOST_REASON, ended: true });
}

/** 外から見える状態のひとまとめ。「何も起きない」を機械で言うために使う */
function observable(x: Ctx) {
  return {
    connected: x.state.connected,
    notice: x.state.notice,
    reconnect: x.state.reconnect,
    clients: clients.length
  };
}

/** 繋ぎ直しの 1 段目まで時計を進める */
async function runFirstAttempt(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
}

/**
 * 表の `outcome` を確かめる。
 *
 * **どこを見るかが結論ごとに違う**のがクライアント側の難しさ——5250 は `sessionsStore`、
 * VT は `vtStore`、プリンターは同じ `sessionsStore` でも `state` を見る。
 * 見る場所の対応をここ 1 か所に閉じ込めておく。
 */
async function expectOutcome(c: ClientCase, x: Ctx, before: ReturnType<typeof observable>): Promise<void> {
  const s = x.state;
  switch (c.outcome) {
    case "reconnect": {
      expect(s.reconnect).toEqual({ attempt: 1, max: 5 });
      const opened = clients.length;
      await runFirstAttempt();
      expect(clients.length).toBe(opened + 1);
      expect(clients[clients.length - 1]!.send).toHaveBeenCalledWith({
        type: "open",
        sessionId: x.sessionId,
        resume: true
      });
      break;
    }
    case "connectionLost": {
      expect(s.connected).toBe(false);
      expect(s.notice).toBe(MSG_CONNECTION_LOST);
      expect(s.reconnect).toBeUndefined();
      // **`resume` を 1 通も出していない**（門で戻ったのであって、静かに走ってはいない）
      const opened = clients.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clients.length).toBe(opened);
      break;
    }
    case "silent": {
      expect(s.connected).toBe(false);
      expect(s.notice).toBeUndefined(); // 理由は次の打鍵まで出さない
      expect(s.reconnect).toBeUndefined();
      // **「黙る」の中身は「次の打鍵で終了と言う」こと。** ここを見ないと
      // `connected === false` しか確かめておらず、ホストが終わったことを覚えているか
      // （旧 `endedByHost`）が固定されない（T3 のタスク点検で空振りを指摘された）
      sendKey(x.sessionId, "Enter");
      expect(s.notice).toBe(MSG_SESSION_ENDED);
      break;
    }
    case "vtNotice": {
      const v = vtStore.get(x.sessionId)!;
      expect(v.connected).toBe(false);
      // ホスト都合なら**サーバーが添えた理由**、転送断なら VT 専用の汎用文
      expect(v.closeReason).toBe(c.disconnect === "hostEnded" ? HOST_REASON : MSG_VT_CONNECTION_LOST);
      expect(s.reconnect).toBeUndefined();
      break;
    }
    case "printerState": {
      expect(s.state).toBe("error");
      expect(s.serviceError).toBe(HOST_REASON);
      expect(s.connected).toBe(true); // **転送は生きたまま**（ここが 5250 との違い）
      break;
    }
    case "nothing": {
      expect(observable(x)).toEqual(before);
      // **「変化が無い」だけでは、テスト自身が何もしなかっただけと区別が付かない。**
      // 観測できる帰結まで言う——ホストが終わっても、この端末は**繋がったままに見える**。
      // 誰かがサーバー側に購読を足したら（＝欠落が埋まったら）ここが落ちる
      expect(s.connected).toBe(true);
      expect(sendKey(x.sessionId, "Enter")).toBeUndefined();
      expect(s.notice).toBeUndefined(); // 打っても止められない（送り先はもう無いのに）
      break;
    }
    case "notStarted": {
      expect(sessionsStore.get(x.sessionId)).toBeUndefined(); // もうセッションが無い
      expect(s.reconnect).toBeUndefined();
      const opened = clients.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clients.length).toBe(opened);
      break;
    }
  }
}

describe("セッション寿命の組合せ（クライアント側）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // ゆらぎ（±20%）を消して、繋ぎ直しの待ちを表どおりに進められるようにする
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    clients = [];
    sessionsStore.byId.clear();
    sessionsStore.order = [];
  });
  afterEach(() => {
    // **モジュール側の待ち・飛行中の口を畳んでから次の行へ。** `sessionsStore` を消すだけでは
    // `reconnectTimers` / `pendingResumes` が残り、次の行（同じ id を使う）が前のモックへ
    // `close()` を打つ
    for (const s of [...sessionsStore.all]) closeSession(s.sessionId);
    sessionsStore.byId.clear();
    sessionsStore.order = [];
    for (const id of [DSP_ID, VT_ID, PRT_ID]) vtStore.remove(id);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([...CLIENT_CASES])("$id → $outcome", async (c) => {
    const x = await openFor(c);
    const before = observable(x);

    applyDisconnect(c, x);

    await expectOutcome(c, x, before);
  });

  /**
   * **切れ方が 2 つ続いた場合**（表の軸に収まらないので別に持つ。`CLIENT_ORDER_CASES`）。
   * ホスト終了は WS を閉じないので、門の順序が効くのは**そのあと転送も落ちたとき**だけ。
   */
  it.each([...CLIENT_ORDER_CASES])("$id → $outcome", async (c) => {
    const x = await openFor(c);
    x.first.handlers.onServerMessage({ type: "closed", reason: HOST_REASON, ended: true });
    const before = observable(x);

    x.first.handlers.onClose?.();

    await expectOutcome(c, x, before);
  });

  /**
   * **心拍の死判定が転送断と同じ入口に合流することの根拠**（上の `heartbeatDead` 行が
   * `onClose` で回せる理由）。
   *
   * `WsClient` はこのファイルではモックしているので、**本物を別に読み込んで**見張りだけを走らせる。
   * 見張りは `ping` を受け取ってから張られ、90 秒無音で自分から `close()` を呼び、
   * `close` イベントが来なければ 3 秒の保険で `onClose` へ進む（`ws-client.ts` の
   * `PING_DEAD_MS` / `CLOSE_EVENT_GRACE_MS`）。
   */
  it("心拍が途絶えたときの入口は、転送断と同じ `onClose`", async () => {
    const { WsClient: RealWsClient } = await vi.importActual<typeof import("../src/ws-client.js")>(
      "../src/ws-client.js"
    );
    /** 手で開閉・受信させられる最小の WebSocket 代役（`ws-ping-watchdog.test.ts` と同じ形） */
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      closed = 0;
      private listeners = new Map<string, ((ev: unknown) => void)[]>();
      addEventListener(type: string, fn: (ev: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(fn);
        this.listeners.set(type, list);
      }
      send(): void {}
      /** **`close` イベントは自動で飛ばさない**——半開きでは飛ばないのが再現したい状況 */
      close(): void {
        this.closed += 1;
        this.readyState = 3;
      }
      fire(type: string, ev: unknown): void {
        for (const fn of this.listeners.get(type) ?? []) fn(ev);
      }
      deliver(msg: unknown): void {
        this.fire("message", { data: JSON.stringify(msg) });
      }
    }
    const socket = new FakeSocket();
    const original = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      static OPEN = 1;
      constructor() {
        return socket as unknown as WebSocket;
      }
    };
    try {
      let closed = 0;
      const client = new RealWsClient("ws://x/ws", { onServerMessage: () => {}, onClose: () => closed++ }, "sess");
      const p = client.connect();
      socket.fire("open", {});
      await p;
      socket.deliver({ type: "ping" });

      await vi.advanceTimersByTimeAsync(90_000);
      expect(socket.closed).toBe(1); // 見張りが自分から畳んだ
      await vi.advanceTimersByTimeAsync(3_000); // `close` イベントが来なかったときの保険

      expect(closed).toBe(1); // 以後は転送断と区別が付かない
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
    }
  });

  /**
   * **打ち切った試行の結果は効かない**（R4。`isCurrentAttempt` が答える唯一の規則）。
   *
   * 上の表は「切れ方 × 端末種別」の軸しか持たないので、**試行が入れ替わる状況**は
   * そこに収まらない。`research.md` F17-(3) が穴として記録していた `opened` の経路を埋める
   * ——`screen` の経路は `session-reconnect.test.ts`「打ち切った試行から遅れて届いた画面で、
   * 接続中に戻らない」が既に押さえており（F16）、こちらは**口の差し替えそのもの**を見る。
   * `isCurrentAttempt` を `return true` にすると 2 本とも落ちる（T12 の実測）。
   *
   * 効かないと何が起きるか: 打ち切ったはずの口がセッションに差し替わり、**以後の送信が
   * 死んだ口へ落ちる**（画面は「接続中」に見えたまま）。
   */
  it("**打ち切った試行から遅れて届いた `opened` は無視する**（口を差し替えない）", async () => {
    const p = openSession({ type: "open", host: "h" }, "t");
    clients[0]!.handlers.onServerMessage({ type: "opened", sessionId: DSP_ID, screen: snap() });
    await p;
    const s = sessionsStore.get(DSP_ID)!;

    clients[0]!.handlers.onClose?.(); // 転送断 → はしごが回り出す
    await vi.advanceTimersByTimeAsync(1_000); // 1 段目が飛ぶ（clients[1]）
    expect(clients).toHaveLength(2);

    // 1 段目が黙り込んで打ち切られ、2 段目が飛ぶ（clients[2]）
    await vi.advanceTimersByTimeAsync(10_000); // RESUME_ATTEMPT_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(2_000); // 2 段目の待ち
    expect(clients).toHaveLength(3);

    // **ここで 1 段目が遅れて成功を返す**
    clients[1]!.handlers.onServerMessage({ type: "opened", sessionId: DSP_ID, screen: snap() });

    // 差し替わっていない（口も、接続状態も、はしごも）。**口は「元のまま」で見る**
    // ——モックは `WsClient` 本体ではなく別のオブジェクトを積むので、
    // `s.client` を `clients[1]` と比べても構造上つねに真になり何も見ない
    expect(s.client.send).toBe(clients[0]!.send);
    expect(s.connected).toBe(false);
    expect(s.reconnect).toEqual({ attempt: 2, max: 5 }); // 2 段目が走行中
  });
});

/**
 * **表が 1 つであることの機械的な固定**（`clientViewOf()` の射影で突き合わせる）。
 *
 * サーバー側にしかない軸（役割・viewer 数）を落として比べるので、**片側にしか無い組合せが
 * 生まれた瞬間に落ちる**——表を 2 つに割って片方だけ更新する、という壊れ方をここで止める。
 */
describe("サーバーの表とクライアントの表の突き合わせ", () => {
  const clientIds = new Set(CLIENT_CASES.map((c) => c.id));
  const projected = new Set(SERVER_CASES.map(clientViewOf));

  it("クライアントの行 id は重複していない（重複すると突き合わせが緩む）", () => {
    expect(clientIds.size).toBe(CLIENT_CASES.length);
  });

  it("**サーバーの全行は、射影するとクライアントの表のどれかになる**", () => {
    expect([...projected].filter((k) => !clientIds.has(k))).toEqual([]);
  });

  it("クライアントの表に、サーバー側へ対応の無い行は無い", () => {
    expect([...clientIds].filter((k) => !projected.has(k))).toEqual([]);
  });

  /**
   * **順序ケースは射影の対象外**（切れ方が 2 つ続く状況なので、サーバーの 1 行に対応しない）。
   * 対象外ということは**消えても突き合わせが落ちない**ということなので、件数をここで固定する
   * ——門1 と門2 の順序を唯一固定している 2 行が黙って消えるのを防ぐ。
   */
  it("順序ケースは 2 行（門の順序を固定する唯一の行なので、数を固定する）", () => {
    expect(CLIENT_ORDER_CASES).toHaveLength(2);
    expect(new Set(CLIENT_ORDER_CASES.map((c) => c.id)).size).toBe(2);
  });
});
