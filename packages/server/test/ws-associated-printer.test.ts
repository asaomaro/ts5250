import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager, type OpenOptions, type OpenPrinterOptions } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import type { ServerSession } from "../src/config-types.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";

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

  it("**待ち時間切れでも表示は開く**（プリンターの設定の装置名で関連付ける。ACS は設定の値のまま）", async () => {
    const mgr = new Recording(true);
    const { sent } = await openDisplay(mgr, [prt, disp({ associatedPrinterTimeout: 5 })]);
    expect(sent.some((m) => m.type === "opened")).toBe(true);
    expect(mgr.displays[0]!.associatedPrinter).toBe("SETNAME");
    mgr.closeAll();
  }, 15000);

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
    expect(sent.some((m) => m.type === "opened")).toBe(true);
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
    store.removeSession("prt", undefined);
    await conn.handle(JSON.stringify({ type: "open", session: "srv:d" }));
    expect(sent.some((m) => m.type === "opened")).toBe(true);
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

  it("関連付けの指定が無い表示は、プリンターに触らない", async () => {
    const mgr = new Recording();
    await openDisplay(mgr, [prt, disp({ associatedPrinterSession: undefined })]);
    expect(mgr.printersOpened).toHaveLength(0);
    expect(mgr.displays[0]!.associatedPrinter).toBeUndefined();
    mgr.closeAll();
  });
});
