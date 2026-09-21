import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../src/session-manager.js";
import { ReplayTransport, parseTraceJsonl, type Transport } from "@ts5250/tn5250";

/**
 * **表示と関連付けたプリンターセッションの連動**（`20260921-associated-printer-session`。ACS `AssociatedPrinterSession5250`）。
 * 表示が切れたらほかに使う表示が無ければプリンターを止め、繋ぎ直せたら起こし、閉じたら止める（指定があれば閉じる）。常駐は触らない
 */
const here = dirname(fileURLToPath(import.meta.url));
const signon = () => parseTraceJsonl(readFileSync(join(here, "..", "..", "tn5250", "test", "fixtures", "pub400-signon.jsonl"), "utf8"));

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
type Emitting = { emit(event: string, ...args: unknown[]): void };

async function setup(opts: { resident?: boolean } = {}) {
  const mgr = new SessionManager();
  const printer = await mgr.openPrinter({ transport: new PrinterTransport(), ...(opts.resident ? { service: true } : {}) });
  const open = async (link = true, closeWithLast = false) => {
    const d = await mgr.open({ transport: new ReplayTransport(signon()) });
    if (link) mgr.linkAssociatedPrinter(d.id, printer.id, closeWithLast);
    return d;
  };
  const emit = (d: { session: unknown }, ev: string, ...a: unknown[]) => (d.session as Emitting).emit(ev, ...a);
  return { mgr, printer, open, emit };
}
/** 繋ぎ直し中を装う（`reconnecting` の公開は `state` から導かれる） */
const setReconnecting = (d: { session: unknown }, on: boolean) => {
  (d.session as unknown as { state: string }).state = on ? "reconnecting" : "ready";
};

describe("関連付けたプリンターの連動", () => {
  it("**表示が切れたら（ほかに使う表示が無ければ）プリンターを止め、繋ぎ直せたら起こす**", async () => {
    const { mgr, printer, open, emit } = await setup();
    const d = await open();
    expect(printer.state).toBe("listening");
    setReconnecting(d, true);
    emit(d, "reconnecting", { attempt: 1, reason: "x" });
    expect(printer.state).toBe("stopped");
    setReconnecting(d, false);
    emit(d, "reconnected", { code: "I902", device: "D", system: "S" });
    await new Promise((r) => setTimeout(r, 20));
    expect(printer.state).toBe("listening");
    mgr.closeAll();
  });

  it("**ほかの表示が同じプリンターを使っていれば、切れても止めない**", async () => {
    const { mgr, printer, open, emit } = await setup();
    const a = await open();
    await open();
    setReconnecting(a, true);
    emit(a, "reconnecting", { attempt: 1, reason: "x" });
    expect(printer.state).toBe("listening");
    mgr.closeAll();
  });

  it("ほかの表示も繋ぎ直し中なら、最後に切れた側が止める", async () => {
    const { mgr, printer, open, emit } = await setup();
    const a = await open();
    const b = await open();
    setReconnecting(a, true);
    emit(a, "reconnecting", { attempt: 1, reason: "x" });
    expect(printer.state).toBe("listening");
    setReconnecting(b, true);
    emit(b, "reconnecting", { attempt: 1, reason: "x" });
    expect(printer.state).toBe("stopped");
    mgr.closeAll();
  });

  it("**表示を閉じたらプリンターを止める**（プリンターは残る）", async () => {
    const { mgr, printer, open } = await setup();
    const d = await open();
    await mgr.close(d.id);
    expect(printer.state).toBe("stopped");
    expect(mgr.getPrinter(printer.id).id).toBe(printer.id);
    mgr.closeAll();
  });

  it("**「最後の表示と一緒に閉じる」ならプリンターも閉じる**", async () => {
    const { mgr, printer, open } = await setup();
    const d = await open(true, true);
    await mgr.close(d.id);
    expect(() => mgr.getPrinter(printer.id)).toThrow(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    mgr.closeAll();
  });

  it("ほかの表示が使っていれば、閉じても止めも閉じもしない", async () => {
    const { mgr, printer, open } = await setup();
    const a = await open(true, true);
    await open(true, true);
    await mgr.close(a.id);
    expect(printer.state).toBe("listening");
    expect(mgr.getPrinter(printer.id).id).toBe(printer.id);
    mgr.closeAll();
  });

  it("**常駐のプリンターは、切れても閉じても止めない・閉じない**", async () => {
    const { mgr, printer, open, emit } = await setup({ resident: true });
    const d = await open(true, true);
    setReconnecting(d, true);
    emit(d, "reconnecting", { attempt: 1, reason: "x" });
    expect(printer.state).toBe("listening");
    await mgr.close(d.id);
    expect(printer.state).toBe("listening");
    expect(mgr.getPrinter(printer.id).id).toBe(printer.id);
    mgr.closeAll();
  });

  it("**ホストが表示を終わらせた（closed）ときも止める**（`close` を通らない経路）", async () => {
    const { mgr, printer, open, emit } = await setup();
    const d = await open();
    emit(d, "closed", "host ended");
    expect(printer.state).toBe("stopped");
    mgr.closeAll();
  });

  it("関連付けていない表示は、プリンターに触らない", async () => {
    const { mgr, printer, open } = await setup();
    const d = await open(false);
    await mgr.close(d.id);
    expect(printer.state).toBe("listening");
    mgr.closeAll();
  });

  it("**閉じた後の遅れたイベントには反応しない**（止めたプリンターを後から起こさない）", async () => {
    const { mgr, printer, open, emit } = await setup();
    const d = await open();
    await mgr.close(d.id);
    expect(printer.state).toBe("stopped");
    emit(d, "reconnected", { code: "I902", device: "D", system: "S" });
    await new Promise((r) => setTimeout(r, 20));
    expect(printer.state).toBe("stopped");
    mgr.closeAll();
  });

  it("**閉じるときに組を外す**——外さないと、同じ表示の遅れた `reconnected` が止めたプリンターを起こす。外した後は何も触らない", async () => {
    const { mgr, printer, open } = await setup();
    const d = await open();
    expect(d.associatedPrinter).toBeDefined();
    await mgr.close(d.id);
    expect(d.associatedPrinter).toBeUndefined();
    expect(printer.state).toBe("stopped");
    mgr.closeAll();
  });

  it("**使い回すプリンターがまだ起動中なら、装置名が決まるのを待つ**（待たないと送った名前のままで関連付ける）", async () => {
    const mgr = new SessionManager();
    // 起動応答がまだ来ていないプリンター（接続は張れているが起動応答待ち）を装う
    const entry = await mgr.openPrinter({ transport: new PrinterTransport(), ref: "srv:p" });
    const cur = entry.session as unknown as { startupCodeValue: string; startDeviceValue?: string };
    const real = cur.startupCodeValue;
    cur.startupCodeValue = "";
    setTimeout(() => (cur.startupCodeValue = real), 400); // 400 ms 後に起動応答が来る
    const t0 = Date.now();
    const r = await mgr.prepareAssociatedPrinter("srv:p", undefined, async () => entry, 5000);
    expect("error" in r).toBe(false);
    expect(Date.now() - t0, "起動応答が来るまで待った").toBeGreaterThanOrEqual(350);
    mgr.closeAll();
  });

  it("存在しない表示は SESSION_NOT_FOUND", async () => {
    const { mgr, printer } = await setup();
    expect(() => mgr.linkAssociatedPrinter("nope", printer.id, false)).toThrow(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    mgr.closeAll();
  });
});
