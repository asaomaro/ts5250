import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tn3270Session } from "../src/session/session.js";
import { Trace, traced, toHex, fromHex } from "../src/trace/trace.js";
import { ReplayTransport } from "../src/trace/replay.js";
import type { Transport } from "../src/transport/types.js";

/**
 * **記録した実バイト列を再生して回帰を固定する**（5250 側と同じ方式）。
 *
 * ここが緑なら **docker もホストも要らない**——照合（`TN3270_E2E=1`）で一度確かめた
 * バイト列が、以後は普通の単体テストとして効き続ける。
 */

const here = dirname(fileURLToPath(import.meta.url));

function loadEntries(name: string): ReturnType<typeof Trace.fromJsonl> {
  return Trace.fromJsonl(readFileSync(join(here, "fixtures", name), "utf8"));
}

describe("trace の記録", () => {
  it("hex の往復が保たれる", () => {
    const data = Uint8Array.from([0x00, 0x0e, 0xff, 0x7d, 0xc1]);
    expect(fromHex(toHex(data))).toEqual(data);
  });

  it("JSONL として往復する", () => {
    const t = new Trace();
    t.record("in", Uint8Array.from([0xf5, 0xc3]));
    t.record("out", Uint8Array.from([0x7d, 0x40, 0x40]));
    const back = Trace.fromJsonl(t.toJsonl());
    expect(back.length).toBe(2);
    expect(back[0]).toEqual({ dir: "in", seq: 1, hex: "f5c3" });
    expect(back[1]!.dir).toBe("out");
  });

  it("traced() は透過的（包んでも挙動が変わらない）", () => {
    const sent: string[] = [];
    let dataFn: ((d: Uint8Array) => void) | undefined;
    const base: Transport = {
      send: (d) => sent.push(toHex(d)),
      close: () => undefined,
      onData: (fn) => (dataFn = fn),
      onClose: () => undefined,
      onError: () => undefined
    };
    const trace = new Trace();
    const wrapped = traced(base, trace);
    const seen: string[] = [];
    wrapped.onData((d) => seen.push(toHex(d)));
    wrapped.send(Uint8Array.from([0x01]));
    dataFn?.(Uint8Array.from([0x02]));
    expect(sent).toEqual(["01"]); // 下位へそのまま渡る
    expect(seen).toEqual(["02"]); // 上位へそのまま渡る
    expect(trace.all.map((e) => `${e.dir}:${e.hex}`)).toEqual(["out:01", "in:02"]);
  });
});

describe("replay（docker 不要）", () => {
  it("DBCS の記録を再生すると日本語の画面が組み上がる", () => {
    const entries = loadEntries("dbcs-cp930.jsonl");
    expect(entries.length).toBeGreaterThan(0);

    const s = new Tn3270Session({ host: "replay", model: 2, ccsid: 930 });
    const transport = ReplayTransport.fromEntries(entries);
    let screens = 0;
    s.on("screen", () => screens++);
    s.attach(transport);

    expect(screens).toBeGreaterThan(0);
    expect(s.status).toBe("ready");

    const text = s
      .snapshot()
      .cells.map((r) => r.map((c) => (c.kind === "dbcs-tail" ? "" : c.char)).join("").trimEnd())
      .join("\n");
    // **照合（TN3270_E2E=1）で s3270 と一致を確認した内容そのもの**
    expect(text).toContain("3270 DBCS TEST");
    expect(text).toContain("kanji :  日本語表示");
    expect(text).toContain("kana  :  カタカナ");
    expect(text).toContain("mixed : ABC あいう DEF");
  });

  it("TK4- ウェルカム画面のレコード fixture が読める", () => {
    const records = loadEntries("tk4-welcome.jsonl");
    expect(records.length).toBe(2);
    expect(records[0]!.hex.startsWith("f5")).toBe(true); // Erase/Write
  });

  it("**IBM i の記録を再生するとサインオン画面が組み上がる**", () => {
    // SNA 系コマンドコード ＋ WSF Query ＋ Outbound 3270DS の経路を docker 無しで固定する。
    // ここが緑なら「IBM i に繋がる」ことが実ホスト無しで回帰する
    const entries = loadEntries("ibmi-signon.jsonl");
    const s = new Tn3270Session({ host: "replay", model: 2, ccsid: 37 });
    const transport = ReplayTransport.fromEntries(entries);
    let screens = 0;
    s.on("screen", () => screens++);
    s.attach(transport);

    expect(screens).toBeGreaterThan(0);
    const snap = s.snapshot();
    expect(snap.fields.length).toBeGreaterThan(10); // サインオン画面は欄が多い
    const text = snap.cells.map((r) => r.map((c) => c.char).join("").trimEnd()).join("\n");
    expect(text).toContain("PUB400");
    expect(text).toContain("Your user name");

    // **Query Reply を返していること**（返さないとホストは画面を出さない）
    const sent = transport.sent.map(toHex).join("");
    expect(sent).toContain("88"); // AID_STRUCTURED_FIELD で始まる応答
  });

  it("送信バイトも記録される（照合に使える）", () => {
    const entries = loadEntries("dbcs-cp930.jsonl");
    const s = new Tn3270Session({ host: "replay", model: 2, ccsid: 930 });
    const transport = ReplayTransport.fromEntries(entries);
    s.attach(transport);
    expect(transport.sent.length).toBeGreaterThan(0);
    expect(transport.sent.map(toHex).join("")).toContain("fffb18"); // WILL TERMINAL-TYPE
  });
});
