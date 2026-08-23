import { describe, it, expect } from "vitest";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager, type OpenPrinterOptions } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import type { WsServerMessage } from "../src/ws-messages.js";
import type { Transport } from "@ts5250/tn5250";

/**
 * **閉じている間に届いた帳票を配り直す**（`20260802-printer-report-history`）。
 *
 * サーバーは `20260801-printer-attach-by-ref` から `printer-opened.reports` に載せているが、
 * **時刻は載せていなかった**。受け手が現在時刻で押すので、夜中に出た帳票が
 * 開いた瞬間の時刻で並ぶ。ここでは電文に `receivedAt` が載ることを固定する。
 *
 * **live（`report`）と配り直し（`printer-opened.reports`）の両方**を見る——
 * 片方だけ直すと「開き直すと時刻が出るのに、いま届いたものには無い」という差になる。
 */
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

const CLOCK = 1_700_000_000_000;

class PrinterManager extends SessionManager {
  constructor(now: () => number) {
    super({ now });
  }
  override openPrinter(opts: OpenPrinterOptions) {
    return super.openPrinter({ ...opts, transport: new PrinterTransport() });
  }
}

/** サービス ✅ のプリンター定義を 1 本持つ環境（`ref` で開き直せる＝attach できる） */
function setup(now: () => number) {
  const mgr = new PrinterManager(now);
  const server = new ServerConfigStore({
    systems: [{ id: "sys", name: "sys", host: "h" }],
    sessions: [{ id: "p", name: "p", system: "sys", sessionType: "printer", printer: { service: true } }]
  });
  const resolver = new ConfigResolver(server, new PersonalConfigStore());
  const connect = (): { conn: WsConnection; sent: WsServerMessage[] } => {
    const sent: WsServerMessage[] = [];
    const conn = new WsConnection(
      { sessions: mgr, resolver },
      { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} }
    );
    return { conn, sent };
  };
  return { mgr, connect };
}

/** `deliverReport` は private。配る道はここ 1 本なので直接叩く */
function deliver(mgr: SessionManager, reportId: string): void {
  const m = mgr as unknown as { deliverReport: (e: unknown, r: unknown) => void };
  const e = mgr.listPrinters()[0]!;
  m.deliverReport(e, { id: reportId, pages: [{ rows: 1, cols: 4, lines: ["abcd"] }] });
}

const openedOf = (sent: WsServerMessage[]) =>
  sent.find((m) => m.type === "printer-opened") as
    | Extract<WsServerMessage, { type: "printer-opened" }>
    | undefined;

describe("帳票の配り直しと受信時刻", () => {
  it("live の `report` に受信時刻が載る", async () => {
    const { mgr, connect } = setup(() => CLOCK);
    const { conn, sent } = connect();
    await conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    deliver(mgr, "s1");
    const rep = sent.find((m) => m.type === "report") as Extract<WsServerMessage, { type: "report" }>;
    expect(rep.report.receivedAt).toBe(CLOCK);
    mgr.closeAll();
  });

  it("開き直すと**閉じている間のぶん**が時刻つきで届く", async () => {
    let t = CLOCK;
    const { mgr, connect } = setup(() => t);
    // 1 本目で待ち受けを始め、切る（常駐なのでエントリは残る）
    const first = connect();
    await first.conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    first.conn.dispose();
    // 閉じている間に 2 件届く
    deliver(mgr, "s1");
    t += 60_000;
    deliver(mgr, "s2");
    // 開き直す
    const second = connect();
    await second.conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    const opened = openedOf(second.sent)!;
    expect(opened.reports.map((r) => r.id)).toEqual(["s1", "s2"]);
    // **開いた時刻ではなく、届いた時刻**——2 件が同じ値で並ばない
    expect(opened.reports.map((r) => r.receivedAt)).toEqual([CLOCK, CLOCK + 60_000]);
    expect(opened.receivedTotal).toBe(2);
    mgr.closeAll();
  });

  it("**生バイトは載せない**（画面は等幅グリッドしか使わない）", async () => {
    const { mgr, connect } = setup(() => CLOCK);
    const { conn, sent } = connect();
    await conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    deliver(mgr, "s1");
    const rep = sent.find((m) => m.type === "report") as Extract<WsServerMessage, { type: "report" }>;
    expect(Object.keys(rep.report).sort()).toEqual(["id", "pages", "receivedAt"]);
    mgr.closeAll();
  });
});

/**
 * **止まった理由も配り直す。**
 *
 * `printer-state` の push は**繋いでいる間しか届かない**。常駐プリンターが誰も見ていない間に
 * 止まると、朝ブラウザを開いても **「エラー」とだけ出て理由が無い**状態になっていた
 * ——帳票の配り直し（上）と同じ形の取りこぼしで、VT の切断理由でも同じことをやっていた。
 */
describe("止まった理由の配り直し", () => {
  /** `setPrinterState` は private。状態を作る道はここ 1 本なので直接叩く */
  function fail(mgr: SessionManager, reason: string): void {
    const m = mgr as unknown as {
      setPrinterState: (e: unknown, s: string, err?: string) => void;
    };
    m.setPrinterState(mgr.listPrinters()[0]!, "error", reason);
  }

  it("**開き直すと理由が届く**（エラーとだけ出さない）", async () => {
    const { mgr, connect } = setup(() => CLOCK);
    const first = connect();
    await first.conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    first.conn.dispose();
    // 誰も見ていない間に止まる
    fail(mgr, "device is in use by another session");

    const second = connect();
    await second.conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    const opened = openedOf(second.sent)!;
    expect(opened.state).toBe("error");
    expect(opened.error, "理由が載る").toBe("device is in use by another session");
    mgr.closeAll();
  });

  it("**理由が無ければ欄ごと載せない**（空文字を送らない）", async () => {
    const { mgr, connect } = setup(() => CLOCK);
    const { conn, sent } = connect();
    await conn.handle(JSON.stringify({ type: "open", kind: "printer", session: "srv:p" }));
    const opened = openedOf(sent)!;
    expect(opened.state).toBe("listening");
    expect(opened).not.toHaveProperty("error");
    mgr.closeAll();
  });
});
