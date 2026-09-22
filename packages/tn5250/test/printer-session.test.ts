import { describe, it, expect } from "vitest";
import { PrinterSession, type SpoolReport } from "../src/session/printer-session.js";
import type { Transport } from "../src/transport/types.js";

/** IAC EOR 付きで records をまとめて供給できる最小 Transport（telnet 交渉なしで直接レコードを流す） */
class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  private closeFn: ((r: string) => void) | undefined;
  constructor(private readonly onStart: (t: FakeTransport) => void) {}
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.closeFn?.("closed by client");
  }
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(fn: (r: string) => void): void {
    this.closeFn = fn;
  }
  onError(): void {}
  start(): void {
    this.onStart(this);
  }
  /** 生のバイト列をそのまま流す（telnet の交渉など） */
  dataIn(bytes: number[]): void {
    this.dataFn?.(Uint8Array.from(bytes));
  }
  /** レコードを IAC EOR 付き（IAC は二重化）で供給する */
  feed(rec: number[]): void {
    const out: number[] = [];
    for (const b of rec) {
      out.push(b);
      if (b === 0xff) out.push(0xff);
    }
    out.push(0xff, 0xef); // IAC EOR
    this.dataFn?.(Uint8Array.from(out));
  }
}

// 起動応答レコード: (6+rec[6])+5 の 4 バイト EBCDIC に code。rec[6]=0x04 → o=10, code at 15
function startupRecord(codeEbcdic: number[]): number[] {
  const header = [0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00]; // [2..9]
  const pad = [0x00, 0x00, 0x00, 0x00, 0x00]; // [10..14]
  const body = [...header, ...pad, ...codeEbcdic]; // 開始は [2]
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
}
// **実機の日本語機で採ったレコードの形**（`20260921-printer-acs-declaration` research F4。`scripts/diag-printer-declare.mjs`）。
// ヘッダは `LL LL 12 A0 01 01 0A <フラグ1> 00 <opcode> 00×6` で、本体は 16 バイト目から
function rec(flags: number, opcode: number, payload: number[] = []): number[] {
  const body = [0x12, 0xa0, 0x01, 0x01, 0x0a, flags, 0x00, opcode, 0, 0, 0, 0, 0, 0, ...payload];
  const ll = body.length + 2;
  return [(ll >> 8) & 0xff, ll & 0xff, ...body];
}
/** 印刷データ（opcode 1。実機ではフラグ 0x18 / 0x10 / 0x00） */
const dataRecord = (scs: number[], flags = 0x10): number[] => rec(flags, 1, scs);
/** ジョブの終わり: 5553（DBCS）では本体なしの 16 バイト、HPT では本体 0x00 の 17 バイトで届いた */
const endOfJob16 = (): number[] => rec(0x08, 1);
const endOfJob17 = (): number[] => rec(0x08, 1, [0x00]);
/** CLEAR（opcode 2。実機ではジョブの終わりの後に来た） */
const clearRecord = (): number[] => rec(0x18, 2);
/** ACS `DS5250P` の応答（IAC EOR の前まで） */
const NO_ERROR = [0x00, 0x0a, 0x12, 0xa0, 0x01, 0x02, 0x04, 0x00, 0x00, 0x01];
const CLEAR_PROCESSED = [0x00, 0x0a, 0x12, 0xa0, 0x01, 0x02, 0x04, 0x00, 0x00, 0x02];
const replies = (t: { sent: Uint8Array[] }): number[][] => t.sent.map((d) => [...d.subarray(0, 10)]);

const I902 = [0xc9, 0xf9, 0xf0, 0xf2]; // EBCDIC "I902"
const E8925 = [0xf8, 0xf9, 0xf2, 0xf5]; // EBCDIC "8925"

describe("PrinterSession", () => {
  async function open(): Promise<{ session: PrinterSession; transport: FakeTransport; reports: SpoolReport[] }> {
    const reports: SpoolReport[] = [];
    let transport!: FakeTransport;
    const session = await PrinterSession.connect({
      transport: new FakeTransport((t) => {
        transport = t;
        t.feed(startupRecord(I902)); // 起動応答 → connect 解決
      })
    });
    session.on("report", (r) => reports.push(r));
    return { session, transport, reports };
  }

  it("起動応答 I902 で接続し、ジョブの終わりで report を1件発火する", async () => {
    const { session, transport, reports } = await open();
    expect(session.startupCode).toBe("I902");
    transport.feed(dataRecord([0xc1, 0xc2])); // EBCDIC "AB"
    transport.feed(endOfJob17());
    expect(reports).toHaveLength(1);
    expect(reports[0]!.pages[0]!.lines[0]).toBe("AB");
    // 応答は ACS の NO_ERROR（予約 0x0102）。ジョブの終わりにも、直前に決まった応答をそのまま返す
    expect(replies(transport)).toEqual([NO_ERROR, NO_ERROR]);
  });

  it("**本体の無い 16 バイトのジョブの終わりでも帳票が確定する**（日本語機の 5553 で実測）", async () => {
    const { transport, reports } = await open();
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob16());
    expect(reports).toHaveLength(1);
  });

  it("**フラグ 0x08 の無いレコードはジョブの終わりにしない**（~~長さ 17 なら終わり~~）", async () => {
    const { transport, reports } = await open();
    transport.feed(dataRecord([0xc1, 0xc2]));
    transport.feed(rec(0x00, 1, [0x00])); // 長さ 17 だがフラグは 0
    expect(reports).toHaveLength(0);
    transport.feed(endOfJob16());
    expect(reports).toHaveLength(1);
  });

  it("**CLEAR には CLEAR_PROCESSED を返し、受けかけのジョブを閉じる**（ACS `processClear` → `sendEOJ`）", async () => {
    const { transport, reports } = await open();
    transport.feed(dataRecord([0xc1, 0xc2]));
    transport.feed(clearRecord());
    expect(reports, "受けかけの帳票が閉じられていない").toHaveLength(1);
    expect(replies(transport).at(-1)).toEqual(CLEAR_PROCESSED);
    // 次のジョブに前の断片が混ざらない
    transport.feed(dataRecord([0xc3]));
    transport.feed(endOfJob16());
    expect(reports).toHaveLength(2);
    expect(reports[1]!.pages[0]!.lines[0]).toBe("C");
  });

  it("CLEAR の後は、次にデータを書くまで CLEAR_PROCESSED を返し続ける（ACS は応答を消さない）", async () => {
    const { transport } = await open();
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob16());
    transport.feed(clearRecord()); // 実機ではジョブの終わりの後に来た
    transport.feed(endOfJob16());
    expect(replies(transport).slice(-2)).toEqual([CLEAR_PROCESSED, CLEAR_PROCESSED]);
    transport.feed(dataRecord([0xc2]));
    expect(replies(transport).at(-1)).toEqual(NO_ERROR);
  });

  it("**データの無いジョブの終わりでは帳票を出さない**（ACS `sendEOJ` は印刷中でなければ何もしない）", async () => {
    const { transport, reports } = await open();
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob16());
    transport.feed(clearRecord());
    transport.feed(endOfJob16()); // 空のジョブの終わり
    expect(reports, "空の帳票が出た（自動 PDF・自動印刷に白紙）").toHaveLength(1);
  });

  it("フラグ 0x08 でも本体が 0x00 以外の 1 バイトなら、ジョブの終わりではない", async () => {
    const { transport, reports } = await open();
    transport.feed(rec(0x08, 1, [0xc1]));
    expect(reports).toHaveLength(0);
    transport.feed(endOfJob16());
    expect(reports[0]!.pages[0]!.lines[0]).toBe("A");
  });

  it("終了のレコード（ヘッダのバイト 4 が 0x40）は振り分けない（ACS `processPassthru`）", async () => {
    const { transport, reports } = await open();
    const term = rec(0x10, 1, [0xc1]);
    term[4] = 0x40;
    transport.feed(term);
    transport.feed(dataRecord([0xc2]));
    transport.feed(endOfJob16());
    expect(reports[0]!.pages[0]!.lines[0]).toBe("B");
  });

  it("起動の直後は、データを書くまで応答しない（ACS の `response_string` は空で始まる）", async () => {
    const { transport } = await open();
    transport.feed(endOfJob16());
    expect(transport.sent).toHaveLength(0);
  });

  it("opcode 1・2 以外のレコードは帳票に足さない（ACS は処理しない）", async () => {
    const { transport, reports } = await open();
    transport.feed(rec(0x10, 3, [0xc1, 0xc2]));
    transport.feed(dataRecord([0xc3]));
    transport.feed(endOfJob16());
    expect(reports[0]!.pages[0]!.lines[0]).toBe("C");
  });

  it("**交渉で ACS と同じ申告を返す**（DBCS: IBM-5553-B01・IBMIGCFEAT、KBDTYPE と IBMSENDCONFREC は無し）", async () => {
    let transport!: FakeTransport;
    await PrinterSession.connect({
      ccsid: 1399,
      deviceName: "PRT1",
      transport: new FakeTransport((t) => {
        transport = t;
        // 端末タイプの問い合わせ（IAC SB 24 SEND IAC SE）と NEW-ENVIRON の問い合わせ（IAC SB 39 SEND IAC SE）
        t.dataIn([0xff, 0xfa, 0x18, 0x01, 0xff, 0xf0, 0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0]);
        t.feed(startupRecord(I902));
      })
    });
    const text = transport.sent.map((d) => String.fromCharCode(...d)).join("|");
    expect(text).toContain("IBM-5553-B01");
    expect(text).toContain("IBMIGCFEAT");
    expect(text).toContain("QSYSOPR");
    expect(text).not.toContain("KBDTYPE");
    expect(text).not.toContain("IBMSENDCONFREC");
  });

  it("起動応答が失敗コード（8925）なら SESSION_REJECTED で接続を拒否する", async () => {
    await expect(
      PrinterSession.connect({
        transport: new FakeTransport((t) => t.feed(startupRecord(E8925)))
      })
    ).rejects.toMatchObject({ code: "SESSION_REJECTED" });
  });
});

describe("respondAfter: 帳票の出力が終わるまで応答しない（`20260921-printer-hold-response`）", () => {
  async function openWith(
    respondAfter: (r: SpoolReport, ctx: { cleared: boolean }) => Promise<void> | void,
    more: { nextReportSeq?: () => number } = {}
  ) {
    let transport!: FakeTransport;
    const session = await PrinterSession.connect({
      respondAfter,
      ...more,
      transport: new FakeTransport((t) => {
        transport = t;
        t.feed(startupRecord(I902));
      })
    });
    return { session, transport };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("**ジョブの終わりの応答は Promise が解決するまで出さない**（データのレコードにはすぐ応答する）", async () => {
    let release!: () => void;
    const { transport } = await openWith(() => new Promise<void>((r) => (release = r)));
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob17());
    await tick();
    expect(replies(transport)).toEqual([NO_ERROR]);
    release();
    await tick();
    expect(replies(transport)).toEqual([NO_ERROR, NO_ERROR]);
  });

  it("拒否されても応答する（止めたままにするかは呼び出し側が決める）", async () => {
    const { transport } = await openWith(() => Promise.reject(new Error("x")));
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob17());
    await tick();
    expect(replies(transport)).toEqual([NO_ERROR, NO_ERROR]);
  });

  it("**待っている間に届いたレコードは溜めて、応答のあとに順に処理する**", async () => {
    let release!: () => void;
    const { transport } = await openWith(() => new Promise<void>((r) => (release = r)));
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob17());
    transport.feed(clearRecord()); // 待っている間の CLEAR
    await tick();
    expect(replies(transport), "待っている間に CLEAR へ応答した").toEqual([NO_ERROR]);
    release();
    await tick();
    expect(replies(transport)).toEqual([NO_ERROR, NO_ERROR, CLEAR_PROCESSED]);
  });

  // ~~CLEAR で閉じたジョブも待つ~~ → 待たない（独立点検の指摘）。ACS がエラーで止まるのはデータを書くとき（`sendPrintData`）だけで、
  // ジョブを閉じるときの失敗（`closePrinterIfRequired`）は記録するだけ。CLEAR ではスプールがホストに残るので、止めても守るものが無い
  it("**CLEAR で閉じたジョブは待たない**（呼ぶが `cleared: true` を渡し、すぐ CLEAR_PROCESSED を返す）", async () => {
    const seen: boolean[] = [];
    const { transport } = await openWith((_r, ctx) => {
      seen.push(ctx.cleared);
      return new Promise<void>(() => {}); // 解決しない
    });
    transport.feed(dataRecord([0xc1]));
    transport.feed(clearRecord());
    await tick();
    expect(seen).toEqual([true]);
    expect(replies(transport)).toEqual([NO_ERROR, CLEAR_PROCESSED]);
    // ジョブの終わりで閉じた帳票は `cleared: false` で待つ
    transport.feed(dataRecord([0xc2]));
    transport.feed(endOfJob17());
    await tick();
    expect(seen).toEqual([true, false]);
    // 2 本目のデータには NO_ERROR、ジョブの終わりは待っている（解決しないので応答が出ない）
    expect(replies(transport)).toEqual([NO_ERROR, CLEAR_PROCESSED, NO_ERROR]);
  });

  it("帳票の連番は `nextReportSeq` があればそれを使う（張り直しで id が重ならないように）", async () => {
    let n = 41;
    const { session, transport } = await openWith(() => undefined, { nextReportSeq: () => ++n });
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob17());
    transport.feed(dataRecord([0xc2]));
    transport.feed(endOfJob17());
    expect(session.reports().map((r) => r.id)).toEqual(["spool-42", "spool-43"]);
  });

  it("待つものを返さなければ（undefined）すぐ応答する", async () => {
    const { transport } = await openWith(() => undefined);
    transport.feed(dataRecord([0xc1]));
    transport.feed(endOfJob17());
    expect(replies(transport)).toEqual([NO_ERROR, NO_ERROR]);
  });
});

describe("装置名の答え直し（`20260921-device-name-acs`）", () => {
  const E8902 = [0xf8, 0xf9, 0xf0, 0xf2];
  const I902b = [0xc9, 0xf9, 0xf0, 0xf2];
  const SEND = [0xff, 0xfa, 0x27, 0x01, 0xff, 0xf0];
  const devnames = (t: FakeTransport): string[] => {
    const text = String.fromCharCode(...t.sent.flatMap((d) => [...d]));
    return [...text.matchAll(/DEVNAME\x01([A-Z0-9=]*)/g)].map((m) => m[1]!);
  };

  it("**`%` は P、`=` は使用中（8902）なら同じ接続の中で次の番号**で答え直して繋がる", async () => {
    let transport!: FakeTransport;
    const session = await PrinterSession.connect({
      deviceName: "PR%=",
      transport: new FakeTransport((t) => {
        transport = t;
        t.dataIn(SEND);
        t.feed(startupRecord(E8902));
        t.dataIn(SEND); // ホストが聞き直す
        t.feed(startupRecord(I902b));
      })
    });
    expect(devnames(transport)).toEqual(["PRP0", "PRP1"]);
    expect(session.startupCode).toBe("I902");
    session.disconnect();
  });

  it("**答え直したのにホストが聞き直してこなければ、8902 の理由を残して断る**（時間切れにしない）", async () => {
    await expect(
      PrinterSession.connect({
        deviceName: "PR%=",
        negotiationTimeoutMs: 200,
        transport: new FakeTransport((t) => {
          t.dataIn(SEND);
          t.feed(startupRecord(E8902)); // この後ホストは何も言わない
        })
      })
    ).rejects.toMatchObject({ code: "SESSION_REJECTED", message: expect.stringMatching(/8902.*PRP0.*did not ask/) });
  });

  it("記号の無い名前は 8902 で断る", async () => {
    await expect(
      PrinterSession.connect({
        deviceName: "PRT1",
        transport: new FakeTransport((t) => {
          t.dataIn(SEND);
          t.feed(startupRecord(E8902));
          t.dataIn(SEND);
        })
      })
    ).rejects.toMatchObject({ code: "SESSION_REJECTED" });
  });
});
