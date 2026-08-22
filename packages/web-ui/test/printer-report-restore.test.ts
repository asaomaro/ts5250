import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openPrinterSession } from "../src/session-controller.js";
import { sessionsStore } from "../src/stores/sessions.js";
import { workspaceStore } from "../src/stores/workspace.js";

/**
 * **閉じている間に届いた帳票を捨てない**（`20260802-printer-report-history`）。
 *
 * サーバーは `20260801-printer-attach-by-ref` から `printer-opened.reports` に
 * バッファ済みの帳票を載せて送っていた。ところが受け手が `reports: []` と書いて
 * **その場で捨てていた**——常駐が夜のうちに受け取った帳票が、朝ブラウザを開くと 1 件も無い。
 *
 * サーバー側は 4 タスクぶん入っているのに web-ui を触るタスクが 1 つも無く、
 * **最後の 1 ホップだけが計画から漏れていた**。ここで繋がったことを固定する。
 */
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, ((ev: unknown) => void)[]>();
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  deliver(msg: unknown): void {
    this.fire("message", { data: JSON.stringify(msg) });
  }
}

let socket: FakeSocket;
const originalWs = globalThis.WebSocket;

const CLOCK = 1_700_000_000_000;
const page = (text: string) => ({ rows: 1, cols: text.length, lines: [text] });

/** サーバーが送る `printer-opened`。`reports` の中身だけ差し替えて使う */
function printerOpened(reports: { id: string; pages: unknown[]; receivedAt?: number }[], receivedTotal?: number) {
  return {
    type: "printer-opened",
    sessionId: "prt-1",
    state: "listening",
    startupCode: "I902",
    hasOutput: false,
    outputEnabled: true,
    outputWarnings: [],
    outputStatuses: [],
    reports,
    receivedTotal: receivedTotal ?? reports.length
  };
}

/** 開いて `printer-opened` を届ける。返るのはセッション ID */
async function open(msg: unknown): Promise<string> {
  const p = openPrinterSession({ type: "open", kind: "printer", session: "srv:p" }, "帳票", undefined, "srv:sys", "srv:p");
  socket.fire("open", {});
  await Promise.resolve();
  socket.deliver(msg);
  return p;
}

beforeEach(() => {
  socket = new FakeSocket();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1;
    constructor() {
      return socket as unknown as WebSocket;
    }
  };
  sessionsStore.all.slice().forEach((s) => sessionsStore.remove(s.sessionId));
  workspaceStore.init();
});
afterEach(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWs;
  vi.restoreAllMocks();
});

describe("開き直したときの帳票", () => {
  it("バッファ済みの帳票が一覧に入る（**捨てない**）", async () => {
    const id = await open(
      printerOpened([
        { id: "s1", pages: [page("ONE")], receivedAt: CLOCK },
        { id: "s2", pages: [page("TWO")], receivedAt: CLOCK + 60_000 }
      ])
    );
    expect(sessionsStore.get(id)?.reports?.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  it("**受信時刻はサーバー由来**（開いた時刻で塗り潰さない）", async () => {
    const id = await open(
      printerOpened([
        { id: "s1", pages: [page("ONE")], receivedAt: CLOCK },
        { id: "s2", pages: [page("TWO")], receivedAt: CLOCK + 60_000 }
      ])
    );
    expect(sessionsStore.get(id)?.reports?.map((r) => r.receivedAt)).toEqual([CLOCK, CLOCK + 60_000]);
  });

  it("先頭が選ばれる（開いた直後に空のビューアを出さない）", async () => {
    const id = await open(printerOpened([{ id: "s1", pages: [page("ONE")] }, { id: "s2", pages: [page("TWO")] }]));
    expect(sessionsStore.get(id)?.selectedReportId).toBe("s1");
  });

  it("**未読は 0 のまま**（既存分でタブのバッジを光らせない）", async () => {
    const id = await open(printerOpened([{ id: "s1", pages: [] }, { id: "s2", pages: [] }, { id: "s3", pages: [] }]));
    expect(sessionsStore.get(id)?.unread ?? 0).toBe(0);
  });

  it("累計は**落ちた分を含む**サーバー値を持つ", async () => {
    const id = await open(printerOpened([{ id: "s10", pages: [] }], 62));
    const s = sessionsStore.get(id)!;
    expect(s.receivedTotal).toBe(62);
    expect(s.reports?.length).toBe(1);
  });

  it("帳票が無ければ従来どおり空（選択も無し）", async () => {
    const id = await open(printerOpened([]));
    const s = sessionsStore.get(id)!;
    expect(s.reports).toEqual([]);
    expect(s.selectedReportId).toBeUndefined();
  });
});

describe("live で届く帳票", () => {
  it("サーバーの受信時刻をそのまま使う", async () => {
    const id = await open(printerOpened([]));
    socket.deliver({ type: "report", sessionId: id, report: { id: "s1", pages: [page("NEW")], receivedAt: CLOCK } });
    expect(sessionsStore.get(id)?.reports?.[0]?.receivedAt).toBe(CLOCK);
  });

  it("累計もサーバー値から増える（落ちた分を数え直さない）", async () => {
    const id = await open(printerOpened([{ id: "s10", pages: [] }], 62));
    socket.deliver({ type: "report", sessionId: id, report: { id: "s11", pages: [], receivedAt: CLOCK } });
    expect(sessionsStore.get(id)?.receivedTotal).toBe(63);
  });

  it("未読は増える（**こちらは本当に新着**）", async () => {
    const id = await open(printerOpened([{ id: "s1", pages: [] }]));
    socket.deliver({ type: "report", sessionId: id, report: { id: "s2", pages: [], receivedAt: CLOCK } });
    expect(sessionsStore.get(id)?.unread).toBe(1);
  });
});

/**
 * **版がずれたサーバー**（Electron 同梱版など）。`receivedAt` も `receivedTotal` も
 * 任意にしてあるので、無くても壊れない。
 */
describe("受信時刻を送らないサーバー", () => {
  it("live は従来どおりクライアントが押す（届いたばかりなので正しい）", async () => {
    const id = await open(printerOpened([]));
    socket.deliver({ type: "report", sessionId: id, report: { id: "s1", pages: [] } });
    expect(sessionsStore.get(id)?.reports?.[0]?.receivedAt).toBeGreaterThan(0);
  });

  it("**配り直しでは押さない**（分からないものを現在時刻で埋めない）", async () => {
    const id = await open(printerOpened([{ id: "s1", pages: [] }]));
    expect(sessionsStore.get(id)?.reports?.[0]?.receivedAt).toBeUndefined();
  });
});

/**
 * **止まった理由も捨てない。**
 *
 * `printer-state` の push は繋いでいる間しか届かない。誰も見ていない間に止まった常駐は、
 * 開き直しの `printer-opened` でしか理由を受け取れない——帳票（上）と同じ最後の 1 ホップ。
 * 受け手が捨てると **「エラー」とだけ出て理由が無い**。
 */
describe("開き直したときの停止理由", () => {
  const openedWithError = (error?: string) => ({
    type: "printer-opened",
    sessionId: "prt-1",
    state: "error",
    ...(error !== undefined ? { error } : {}),
    hasOutput: false,
    outputEnabled: true,
    outputWarnings: [],
    outputStatuses: [],
    reports: [],
    receivedTotal: 0
  });

  it("**理由がストアに入る**（捨てない）", async () => {
    const id = await open(openedWithError("device is in use by another session"));
    expect(sessionsStore.get(id)?.state).toBe("error");
    expect(sessionsStore.get(id)?.serviceError).toBe("device is in use by another session");
  });

  it("理由が無ければ立てない（空文字にしない）", async () => {
    const id = await open(openedWithError());
    expect(sessionsStore.get(id)?.state).toBe("error");
    expect(sessionsStore.get(id)?.serviceError).toBeUndefined();
  });

  it("**待ち受け中なら理由は無い**（前の失敗を引きずらない）", async () => {
    const id = await open(printerOpened([]));
    expect(sessionsStore.get(id)?.state).toBe("listening");
    expect(sessionsStore.get(id)?.serviceError).toBeUndefined();
  });
});
