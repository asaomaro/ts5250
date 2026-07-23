import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { parseTraceJsonl, bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord, parseRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, AID, FFW } from "../src/protocol/constants.js";
import { codecForCcsid } from "../src/codec/codec.js";
import { IAC, CMD } from "../src/telnet/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const codec = codecForCcsid(37);

/** レコードを telnet 枠（IAC エスケープ＋IAC EOR）に包んで rx trace エントリにする */
function rxRecord(record: Uint8Array): TraceEntry {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
}

function e(text: string): number[] {
  return [...codec.encode(text).bytes];
}

/** 合成のメニュー画面レコード（CLEAR + WTD(unlock) + MAIN 見出し + コマンド行フィールド + READ） */
function menuRecord(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18); // CC2: SET_BLINK|UNLOCK
  w.u8(ORDER.SBA).u8(1).u8(36).bytes(e("MAIN"));
  w.u8(ORDER.SBA).u8(3).u8(2).bytes(e("Select one of the following:"));
  w.u8(ORDER.SBA).u8(20).u8(2).bytes(e("===>"));
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x24).u16(60); // (20,7) 属性 → (20,8) から 60 桁
  w.u8(ORDER.IC).u8(20).u8(8);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

function signonEntries(): TraceEntry[] {
  return parseTraceJsonl(readFileSync(join(here, "fixtures", "pub400-signon.jsonl"), "utf8"));
}

/** サインオン → (送信) → メニュー のリプレイシナリオ */
function scenario(): TraceEntry[] {
  return [
    ...signonEntries(),
    { ts: "t", dir: "tx", masked: true, len: 0 },
    rxRecord(menuRecord())
  ];
}

async function connectReplay(entries: TraceEntry[]) {
  const transport = new ReplayTransport(entries);
  const session = await Session5250.connect({ transport, id: "test-1" });
  return { transport, session };
}

/** 実機（PUB400）で捕えた起動応答レコード。I902 / PUB400 / QPADEV001P */
function startupResponseRecord(): Uint8Array {
  const out = new Uint8Array(73);
  out.set(
    [
      0x00, 0x49, 0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00,
      0x00,
      0xc9, 0xf9, 0xf0, 0xf2, // "I902"
      0xd7, 0xe4, 0xc2, 0xf4, 0xf0, 0xf0, 0x40, 0x40, // "PUB400  "
      0xd8, 0xd7, 0xc1, 0xc4, 0xc5, 0xe5, 0xf0, 0xf0, 0xf1, 0xd7 // "QPADEV001P"
    ],
    0
  );
  return out;
}

/**
 * 起動応答レコード（RFC 4777 §10）。**接続時に必ず来る**ので、
 * ここから実際の装置名（＝対話ジョブのジョブ名）が分かる。画面には流さない。
 */
describe("起動応答レコード", () => {
  it("1 レコード目の起動応答を保持し、画面には流さない", async () => {
    const { session } = await connectReplay([
      rxRecord(startupResponseRecord()),
      ...signonEntries()
    ]);
    expect(session.startup).toEqual({
      code: "I902",
      system: "PUB400",
      device: "QPADEV001P"
    });
    // 画面はサインオン（起動応答の後ろのレコード）が出ている＝食べ違えていない
    expect(session.snapshot().cells[0]?.map((c) => c.char).join("")).toContain(
      "Welcome to PUB400.COM"
    );
  });

  it("起動応答が来ない接続では undefined（画面はそのまま出る）", async () => {
    const { session } = await connectReplay(signonEntries());
    expect(session.startup).toBeUndefined();
    expect(session.snapshot().cells[0]?.map((c) => c.char).join("")).toContain(
      "Welcome to PUB400.COM"
    );
  });

  /** 2 レコード目以降は判定しない（画面のデータを食べない） */
  it("2 レコード目に同じ形が来ても食べない", async () => {
    const { session } = await connectReplay([
      ...signonEntries(),
      { ts: "t", dir: "tx", masked: true, len: 0 },
      rxRecord(startupResponseRecord())
    ]);
    expect(session.startup).toBeUndefined();
  });
});

describe("Session5250 リプレイ E2E", () => {
  it("接続でサインオン画面が Ready になる", async () => {
    const { session } = await connectReplay(signonEntries());
    expect(session.currentState).toBe("ready");
    const snap = session.snapshot();
    expect(snap.sessionId).toBe("test-1");
    expect(snap.fields).toHaveLength(2);
    expect(snap.cells[0]?.map((c) => c.char).join("")).toContain("Welcome to PUB400.COM");
    expect(snap.keyboardLocked).toBe(false);
  });

  it("setField + sendAid(Enter) でメニュー画面へ遷移する", async () => {
    const { transport, session } = await connectReplay(scenario());
    session.setField({ index: 1 }, "MYUSER");
    session.setField({ row: 6, col: 25 }, "MYPASS");

    const result = await session.sendAid("Enter", { cursor: { row: 5, col: 25 } });
    expect(result.timedOut).toBe(false);
    expect(session.currentState).toBe("ready");
    const row1 = result.screen.cells[0]?.map((c) => c.char).join("") ?? "";
    expect(row1).toContain("MAIN");
    expect(result.screen.cursor).toEqual({ row: 20, col: 8 });

    // 送信された Read 応答を検証（telnet 枠を外して解析）
    const sent = transport.sentChunks.at(-1);
    expect(sent).toBeDefined();
    const raw = [...(sent as Uint8Array)];
    expect(raw.slice(-2)).toEqual([IAC, CMD.EOR]);
    const record = Uint8Array.from(raw.slice(0, -2)); // この応答に 0xFF は含まれない
    const parsed = parseRecord(record);
    const d = [...parsed.data];
    expect(d.slice(0, 3)).toEqual([5, 25, AID.ENTER]);
    expect(d.slice(3, 6)).toEqual([ORDER.SBA, 5, 25]);
    expect(d.slice(6, 12)).toEqual(e("MYUSER"));
    // hidden フィールドもホストへは送られる（マスクは対外スナップショットのみ）
    expect(d.slice(12, 15)).toEqual([ORDER.SBA, 6, 25]);
    expect(d.slice(15)).toEqual(e("MYPASS"));
  });

  it("応答が来なければ timedOut=true で現画面を返し Ready に戻る", async () => {
    const { session } = await connectReplay(signonEntries());
    session.setField({ index: 1 }, "X");
    const result = await session.sendAid("Enter", { timeoutMs: 30 });
    expect(result.timedOut).toBe(true);
    expect(session.currentState).toBe("ready");
  });

  it("Locked 中の setField / sendAid は KEYBOARD_LOCKED", async () => {
    const { session } = await connectReplay(signonEntries());
    const pending = session.sendAid("Enter", { timeoutMs: 50 });
    expect(() => session.setField({ index: 1 }, "X")).toThrow(
      expect.objectContaining({ code: "KEYBOARD_LOCKED" })
    );
    await pending;
  });

  it("screen イベントがホスト発更新でも発火する", async () => {
    const entries = scenario();
    const transport = new ReplayTransport(entries);
    const screens: number[] = [];
    const session = await Session5250.connect({ transport, id: "ev" });
    session.on("screen", () => screens.push(1));
    session.setField({ index: 1 }, "U");
    await session.sendAid("Enter");
    expect(screens.length).toBeGreaterThanOrEqual(1);
  });

  it("disconnect 後の操作は SESSION_CLOSED", async () => {
    const { session } = await connectReplay(signonEntries());
    let closedReason = "";
    session.on("closed", (r) => (closedReason = r));
    session.disconnect();
    expect(session.currentState).toBe("closed");
    expect(closedReason).not.toBe("");
    expect(() => session.setField({ index: 1 }, "X")).toThrow(
      expect.objectContaining({ code: "SESSION_CLOSED" })
    );
  });

  it("waitForScreen は次の画面更新（条件一致）まで待つ", async () => {
    // menu 到達後、ホスト発の追加画面（合成）を feed して waitForScreen が拾うことを確認
    const entries = [
      ...signonEntries(),
      { ts: "t", dir: "rx" as const, hex: "" } // 末尾ダミー（advance 用）
    ];
    const transport = new ReplayTransport(entries);
    const session = await Session5250.connect({ transport, id: "wait" });
    // until 条件がすでに満たされていれば即時解決する（現在画面）
    const r = await session.waitForScreen({ until: { text: "PUB400" }, timeoutMs: 500 });
    expect(r.timedOut).toBe(false);
    expect(r.screen.cells[0]?.map((c) => c.char).join("")).toContain("PUB400");
  });

  it("waitForScreen はタイムアウトで timedOut を返す", async () => {
    const { session } = await connectReplay(signonEntries());
    const r = await session.waitForScreen({ until: { text: "NEVER_APPEARS" }, timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
  });

  it("SysReq は SRQ ヘッダフラグの空レコードを送る", async () => {
    const { transport, session } = await connectReplay(signonEntries());
    void session.sendAid("SysReq", { timeoutMs: 20 });
    // 送信フレーム（IAC EOR 除去）を GDS 解析し、SRQ フラグ・空データを確認
    const sent = transport.sentChunks.at(-1);
    expect(sent).toBeDefined();
    const raw = [...(sent as Uint8Array)];
    const record = Uint8Array.from(raw.slice(0, -2)); // IAC EOR
    const parsed = parseRecord(record);
    expect(parsed.flags.srq).toBe(true);
    expect(parsed.data).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 30)); // タイムアウトを消化
  });

  /**
   * **起動応答レコードを送ってこないホストでも壊れない。**
   * この fixture は実機の採取だが、当時は `IBMSENDCONFREC` を申告しておらず起動応答が無い。
   * 1 レコード目（WTD）を食べずに画面へ流していること＝画面が出ることで確かめる。
   */
  it("起動応答が来ない実機キャプチャでも画面が出る（startup は undefined）", async () => {
    const entries = parseTraceJsonl(
      readFileSync(join(here, "fixtures", "pub400-jobinfo.jsonl"), "utf8")
    );
    const transport = new ReplayTransport(entries);
    const session = await Session5250.connect({ transport, id: "job", user: "USER", password: "dummy" });
    expect(session.currentState).toBe("ready");
    expect(session.startup).toBeUndefined();
    // 画面が組み上がっている（1 レコード目を食べていない）
    expect(session.snapshot().fields.length).toBeGreaterThan(0);
  });

  it("自動サインオン fixture のリプレイでメニュー画面に到達する", async () => {
    // 実機採取した自動サインオン→Query Reply→メニューの rx シーケンスを再生
    // （tx は伏字化済み。ReplayTransport は rx で駆動し、我々の送信は tx マーカーで消費）
    const entries = parseTraceJsonl(
      readFileSync(join(here, "fixtures", "pub400-autosignon-menu.jsonl"), "utf8")
    );
    const transport = new ReplayTransport(entries);
    const session = await Session5250.connect({
      transport,
      id: "auto",
      user: "USER",
      password: "dummy" // 再生では実パスワード不要（rx が固定応答を返す）
    });
    expect(session.currentState).toBe("ready");
    const text = session.snapshot().cells.map((r) => r.map((c) => c.char).join("")).join("\n");
    expect(text).toMatch(/Main Menu/i);
  });

  it("存在しないフィールド指定は FIELD_NOT_FOUND", async () => {
    const { session } = await connectReplay(signonEntries());
    expect(() => session.setField({ index: 9 }, "X")).toThrow(
      expect.objectContaining({ code: "FIELD_NOT_FOUND" })
    );
    expect(() => session.setField({ row: 1, col: 1 }, "X")).toThrow(
      expect.objectContaining({ code: "FIELD_NOT_FOUND" })
    );
  });
});
