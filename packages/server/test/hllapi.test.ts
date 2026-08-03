import { describe, it, expect, vi } from "vitest";
import { callHllapi, HllapiState, type HllapiDeps } from "../src/hllapi.js";
import { HF, HRC } from "../src/hllapi-types.js";
import { As400Error } from "@ts5250/base";
import { setAuditSink, type AuditEvent } from "../src/audit.js";
import type { SessionManager } from "../src/session-manager.js";
import type { AuthUser } from "../src/auth.js";
import { encodeCp932, decodeCp932 } from "../src/hllapi-cp932.js";
import type { Cell, CellKind, Field, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * 機能番号の分岐。
 *
 * 一番大事なのは **未実装が黙って成功にならない**こと（既定が `rc=10`）。
 * 実機は要らない——`SessionManager` を偽物に差し替える。
 */
const cell = (char: string, kind: CellKind = "sbcs"): Cell => ({
  char,
  kind,
  color: "green",
  reverse: false,
  underline: false,
  blink: false,
  columnSeparator: false,
  nonDisplay: false
});

const field = (over: Partial<Field> & { index: number; row: number; col: number; length: number }): Field => ({
  protected: false,
  hidden: false,
  numeric: false,
  ...over
});

function snap(opts: {
  text?: string[];
  fields?: Field[];
  rows?: number;
  cols?: number;
  locked?: boolean;
  cursor?: { row: number; col: number };
}): ScreenSnapshot {
  const rows = opts.rows ?? 2;
  const cols = opts.cols ?? 10;
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: Cell[] = [];
    for (const ch of opts.text?.[r] ?? "") {
      // 全角は lead ＋ tail の 2 セル（実物と同じ持ち方）
      if (encodeCp932(ch).bytes.length === 2) line.push(cell(ch, "dbcs-lead"), cell("", "dbcs-tail"));
      else line.push(cell(ch));
    }
    while (line.length < cols) line.push(cell(" "));
    cells.push(line.slice(0, cols));
  }
  return {
    sessionId: "s1",
    rows: rows as 24,
    cols: cols as 80,
    cursor: opts.cursor ?? { row: 1, col: 1 },
    keyboardLocked: opts.locked ?? false,
    cells,
    fields: opts.fields ?? []
  };
}

/** 偽の SessionManager。**実機に触らずに分岐だけ検証する** */
function fakeDeps(opts: {
  snapshot?: ScreenSnapshot;
  sessions?: {
    id: string;
    connectedAt: string;
    owner?: string;
    target?: { system?: string; session?: string; name?: string };
  }[];
  setField?: (t: unknown, v: string) => void;
  sendAid?: ReturnType<typeof vi.fn>;
  keyAllowed?: boolean;
  writable?: boolean;
  /** 既に別の主体が予約している状態から始める */
  reservedBy?: string;
} = {}): {
  deps: HllapiDeps;
  sendAid: ReturnType<typeof vi.fn>;
  setField: ReturnType<typeof vi.fn>;
  /** いま予約している主体（`undefined` なら空き） */
  holder: () => string | undefined;
  /** いま予約に付いている表示名（画面に出るもの） */
  label: () => string | undefined;
} {
  let holder: string | undefined = opts.reservedBy;
  let label: string | undefined;
  const snapshot = opts.snapshot ?? snap({});
  const sendAid = opts.sendAid ?? vi.fn(async () => ({ screen: snapshot, timedOut: false }));
  const setField = vi.fn(opts.setField ?? (() => undefined));
  const entries = (opts.sessions ?? [{ id: "s1", connectedAt: "2026-08-03T00:00:00Z" }]).map((e) => ({
    id: e.id,
    connectedAt: e.connectedAt,
    host: "h",
    ...((e as { target?: unknown }).target !== undefined ? { target: (e as { target?: unknown }).target } : {}),
    ...((e as { owner?: string }).owner !== undefined ? { owner: (e as { owner?: string }).owner } : {}),
    session: { snapshot: () => snapshot, sendAid, setField }
  }));
  const sessions = {
    list: () => entries,
    get: (id: string) => {
      const found = entries.find((e) => e.id === id);
      if (!found) throw new Error("no session");
      return found;
    },
    assertKeyAllowed: () => {
      if (opts.keyAllowed === false) throw new Error("read only");
    },
    assertWritable: () => {
      if (opts.writable === false) throw new Error("read only");
    },
    // 予約は**本物と同じ意味**で動かす（HLLAPI 側の分岐を意味のある形で検査するため）。
    // 実装そのものの検査は `session-manager.test.ts`
    reserve: (_id: string, h: string, lab: string) => {
      // 本物は assertWritable を通す（閲覧専用は予約できない）
      if (opts.writable === false) throw new As400Error("READ_ONLY_SESSION", "read only");
      if (holder !== undefined && holder !== h) {
        throw new As400Error("SESSION_RESERVED", "reserved");
      }
      holder = h;
      label = lab;
    },
    release: (_id: string, h: string) => {
      if (holder === h) {
        holder = undefined;
        label = undefined;
      }
    },
    touchReservation: () => undefined,
    reservationOf: () =>
      holder === undefined ? undefined : { holder, label: label ?? "HLLAPI", expiresAt: 0 }
  } as unknown as SessionManager;
  return {
    deps: { sessions, state: new HllapiState(), sleep: async () => undefined },
    sendAid,
    setField,
    holder: () => holder,
    label: () => label
  };
}

/** **バッファは CP932 バイト列の base64** で運ぶ（`hllapi-types.ts` の注記） */
const b64 = (s: string): string => Buffer.from(encodeCp932(s).bytes).toString("base64");
/** 応答のバッファを読みやすい文字列へ戻す */
const text = (r: { dataB64?: string }): string =>
  r.dataB64 === undefined ? "" : decodeCp932(new Uint8Array(Buffer.from(r.dataB64, "base64")));

const call = (deps: HllapiDeps, fn: number, over: Partial<{ data: string; length: number; pos: number }> = {}) =>
  callHllapi(deps, {
    function: fn,
    dataB64: b64(over.data ?? ""),
    length: over.length ?? 0,
    pos: over.pos ?? 0
  });

async function connected(opts: Parameters<typeof fakeDeps>[0] = {}) {
  const f = fakeDeps(opts);
  const r = await call(f.deps, HF.CONNECT_PS, { data: "A" });
  expect(r.rc).toBe(HRC.SUCCESSFUL);
  return f;
}

describe("未実装の扱い", () => {
  it("**未実装の機能番号は rc=10**（黙って成功にしない）", async () => {
    const { deps } = await connected();
    for (const fn of [HF.SET_SESSION_PARAMETERS, HF.COPY_OIA, HF.SEND_FILE, HF.GET_KEY]) {
      expect((await call(deps, fn)).rc).toBe(HRC.FUNCTION_UNAVAILABLE);
    }
  });

  it("知らない番号も rc=10", async () => {
    const { deps } = await connected();
    expect((await call(deps, 777)).rc).toBe(HRC.FUNCTION_UNAVAILABLE);
  });
});

describe("接続", () => {
  it("開いているセッションへ短縮名を割り当てる", async () => {
    const { deps } = fakeDeps();
    expect((await call(deps, HF.CONNECT_PS, { data: "A" })).rc).toBe(HRC.SUCCESSFUL);
  });

  it("**セッションが無ければ rc=1**（Connect は新しく開かない）", async () => {
    const { deps } = fakeDeps({ sessions: [] });
    expect((await call(deps, HF.CONNECT_PS, { data: "A" })).rc).toBe(HRC.PS_ID_INVALID);
  });

  it("短縮名が 1 文字の英字でなければ rc=2", async () => {
    const { deps } = fakeDeps();
    expect((await call(deps, HF.CONNECT_PS, { data: "1" })).rc).toBe(HRC.PARAMETER_ERROR);
    expect((await call(deps, HF.CONNECT_PS, { data: "" })).rc).toBe(HRC.PARAMETER_ERROR);
  });

  it("**接続していない状態で操作すると rc=8**（呼ぶ順序が違う）", async () => {
    const { deps } = fakeDeps();
    expect((await call(deps, HF.COPY_PS)).rc).toBe(HRC.PROCEDURE_ERROR);
  });

  it("Disconnect のあとは再び rc=8", async () => {
    const { deps } = await connected();
    expect((await call(deps, HF.DISCONNECT_PS, { data: "A" })).rc).toBe(HRC.SUCCESSFUL);
    expect((await call(deps, HF.COPY_PS)).rc).toBe(HRC.PROCEDURE_ERROR);
  });
});

describe("画面の読み出し", () => {
  it("Copy PS は改行なしの固定長", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["AB", "CD"], rows: 2, cols: 4 }) });
    const r = await call(deps, HF.COPY_PS);
    expect(text(r)).toBe("AB  CD  ");
  });

  it("**バッファに収まらなければ rc=6**（切り詰めを黙らない）", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["ABCD"], rows: 1, cols: 4 }) });
    const r = await call(deps, HF.COPY_PS, { length: 2 });
    expect(r.rc).toBe(HRC.DATA_ERROR);
    expect(text(r)).toBe("AB");
  });

  it("Search PS は**見つかった位置を rc に返す**", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["  FIND"], rows: 1, cols: 6 }) });
    expect((await call(deps, HF.SEARCH_PS, { data: "FIND" })).rc).toBe(3);
  });

  it("見つからなければ rc=7", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["ABC"], rows: 1, cols: 3 }) });
    expect((await call(deps, HF.SEARCH_PS, { data: "ZZ" })).rc).toBe(HRC.PS_POSITION_INVALID);
  });

  it("Query Cursor Location は位置を rc に返す", async () => {
    const { deps } = await connected({ snapshot: snap({ rows: 2, cols: 10, cursor: { row: 2, col: 3 } }) });
    expect((await call(deps, HF.QUERY_CURSOR_LOCATION)).rc).toBe(13);
  });
});

describe("書き込み", () => {
  it("入力欄へ書ける", async () => {
    const f = field({ index: 1, row: 1, col: 1, length: 4 });
    const { deps, setField } = await connected({ snapshot: snap({ text: ["    "], fields: [f], rows: 1, cols: 4 }) });
    const r = await call(deps, HF.COPY_STRING_TO_FIELD, { data: "AB", pos: 1 });
    expect(r.rc).toBe(HRC.SUCCESSFUL);
    expect(setField).toHaveBeenCalledWith({ index: 1 }, "AB  ");
  });

  it("**保護欄には書けない（rc=5）**", async () => {
    const f = field({ index: 1, row: 1, col: 1, length: 4, protected: true });
    const { deps, setField } = await connected({ snapshot: snap({ text: ["    "], fields: [f], rows: 1, cols: 4 }) });
    expect((await call(deps, HF.COPY_STRING_TO_PS, { data: "AB", pos: 1 })).rc).toBe(HRC.FUNCTION_INHIBITED);
    expect(setField).not.toHaveBeenCalled();
  });

  it("欄の外にも書けない（rc=5）", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["    "], fields: [], rows: 1, cols: 4 }) });
    expect((await call(deps, HF.COPY_STRING_TO_PS, { data: "AB", pos: 1 })).rc).toBe(HRC.FUNCTION_INHIBITED);
  });

  it("**欄に収まらなければ rc=6**（切り詰めを黙らない）", async () => {
    const f = field({ index: 1, row: 1, col: 1, length: 2 });
    const { deps, setField } = await connected({ snapshot: snap({ text: ["  "], fields: [f], rows: 1, cols: 2 }) });
    expect((await call(deps, HF.COPY_STRING_TO_FIELD, { data: "ABCD", pos: 1 })).rc).toBe(HRC.DATA_ERROR);
    expect(setField).toHaveBeenCalledWith({ index: 1 }, "AB");
  });
});

describe("キー送信", () => {
  it("AID キーを送る", async () => {
    const { deps, sendAid } = await connected();
    expect((await call(deps, HF.SEND_KEY, { data: "@E" })).rc).toBe(HRC.SUCCESSFUL);
    expect(sendAid).toHaveBeenCalledWith("Enter", expect.anything());
  });

  it("**写せないキーがあれば何も送らずに rc=20**", async () => {
    const { deps, sendAid } = await connected();
    // `@x` は PA1（5250 に無い）。前に @E があっても**送らない**
    expect((await call(deps, HF.SEND_KEY, { data: "@E@x" })).rc).toBe(HRC.UNDEFINED_COMBINATION);
    expect(sendAid).not.toHaveBeenCalled();
  });

  it("キーボードロック中の文字入力は rc=5", async () => {
    const f = field({ index: 1, row: 1, col: 1, length: 4 });
    const { deps } = await connected({
      snapshot: snap({ text: ["    "], fields: [f], rows: 1, cols: 4, locked: true })
    });
    expect((await call(deps, HF.SEND_KEY, { data: "AB" })).rc).toBe(HRC.FUNCTION_INHIBITED);
  });

  it("**読み取り専用のセッションへは書き込めない（rc=5）**", async () => {
    // 画面や MCP で塞いでいる境界を、HLLAPI から横に破らせない
    const f = field({ index: 1, row: 1, col: 1, length: 4 });
    const { deps, setField } = await connected({
      snapshot: snap({ text: ["    "], fields: [f], rows: 1, cols: 4 }),
      writable: false
    });
    expect((await call(deps, HF.COPY_STRING_TO_FIELD, { data: "AB", pos: 1 })).rc).toBe(
      HRC.FUNCTION_INHIBITED
    );
    expect(setField).not.toHaveBeenCalled();
  });

  it("**読み取り専用のセッションでは AID を送らない（rc=5）**", async () => {
    const { deps, sendAid } = await connected({ keyAllowed: false });
    expect((await call(deps, HF.SEND_KEY, { data: "@E" })).rc).toBe(HRC.FUNCTION_INHIBITED);
    expect(sendAid).not.toHaveBeenCalled();
  });

  it("文字を打ってから Enter を送れる", async () => {
    const f = field({ index: 1, row: 1, col: 1, length: 4 });
    const { deps, sendAid, setField } = await connected({
      snapshot: snap({ text: ["    "], fields: [f], rows: 1, cols: 4 })
    });
    expect((await call(deps, HF.SEND_KEY, { data: "AB@E" })).rc).toBe(HRC.SUCCESSFUL);
    expect(setField).toHaveBeenCalledWith({ index: 1 }, "AB  ");
    expect(sendAid).toHaveBeenCalledWith("Enter", expect.anything());
  });
});

describe("日本語（DBCS）", () => {
  it("**全角を含む画面がバイト単位で正しく返る**", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["サイン"], rows: 1, cols: 10 }) });
    const r = await call(deps, HF.COPY_PS);
    expect(r.rc).toBe(HRC.SUCCESSFUL);
    expect(r.length).toBe(10); // 桁数 = バイト数
    expect(text(r)).toBe("サイン    ");
  });

  it("**日本語で検索できる**（文字列連結だった頃は引けなかった）", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["  サイン"], rows: 1, cols: 10 }) });
    expect((await call(deps, HF.SEARCH_PS, { data: "サイン" })).rc).toBe(3);
  });

  it("全角を入力欄へ書ける", async () => {
    const f = field({ index: 1, row: 1, col: 1, length: 6 });
    const { deps, setField } = await connected({
      snapshot: snap({ text: ["      "], fields: [f], rows: 1, cols: 6 })
    });
    expect((await call(deps, HF.COPY_STRING_TO_FIELD, { data: "あ", pos: 1 })).rc).toBe(HRC.SUCCESSFUL);
    expect(setField).toHaveBeenCalledWith({ index: 1 }, expect.stringContaining("あ"));
  });
});

describe("カーソル", () => {
  it("Set Cursor は範囲内なら成功、範囲外は rc=7", async () => {
    const { deps } = await connected({ snapshot: snap({ rows: 2, cols: 10 }) });
    expect((await call(deps, HF.SET_CURSOR, { pos: 15 })).rc).toBe(HRC.SUCCESSFUL);
    expect((await call(deps, HF.SET_CURSOR, { pos: 21 })).rc).toBe(HRC.PS_POSITION_INVALID);
  });

  it("Set Cursor のあと Copy PS to String がそこから読む", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["ABCDE"], rows: 1, cols: 5 }) });
    await call(deps, HF.SET_CURSOR, { pos: 3 });
    expect(text(await call(deps, HF.COPY_PS_TO_STRING, { length: 2 }))).toBe("CD");
  });
});

describe("欄の問い合わせ", () => {
  it("Find Field Position / Length は rc に返す", async () => {
    const f = field({ index: 1, row: 1, col: 3, length: 4 });
    const { deps } = await connected({ snapshot: snap({ text: ["  ABCD"], fields: [f], rows: 1, cols: 8 }) });
    expect((await call(deps, HF.FIND_FIELD_POSITION, { pos: 4 })).rc).toBe(3);
    expect((await call(deps, HF.FIND_FIELD_LENGTH, { pos: 4 })).rc).toBe(4);
  });

  it("Copy Field to String", async () => {
    const f = field({ index: 1, row: 1, col: 3, length: 4 });
    const { deps } = await connected({ snapshot: snap({ text: ["  ABCD"], fields: [f], rows: 1, cols: 8 }) });
    expect(text(await call(deps, HF.COPY_FIELD_TO_STRING, { pos: 3 }))).toBe("ABCD");
  });

  it("欄が無ければ rc=7", async () => {
    const { deps } = await connected({ snapshot: snap({ text: ["    "], fields: [], rows: 1, cols: 4 }) });
    expect((await call(deps, HF.FIND_FIELD_POSITION, { pos: 1 })).rc).toBe(HRC.PS_POSITION_INVALID);
  });
});

describe("セッションを要さない機能", () => {
  it("Convert Position or RowCol（P: 位置 → 行桁）", async () => {
    const { deps } = fakeDeps();
    const r = await call(deps, HF.CONVERT_POS_ROWCOL, { data: "AP 24x80", pos: 81 });
    expect(text(r)).toBe("2 1");
  });

  it("Convert（R: 行桁 → 位置）", async () => {
    const { deps } = fakeDeps();
    expect((await call(deps, HF.CONVERT_POS_ROWCOL, { data: "AR 24x80", pos: 2, length: 1 })).rc).toBe(81);
  });

  it("2 文字目が P/R でなければ rc=2", async () => {
    const { deps } = fakeDeps();
    expect((await call(deps, HF.CONVERT_POS_ROWCOL, { data: "AX" })).rc).toBe(HRC.PARAMETER_ERROR);
  });

  it("**接続していなくても Query System は答える**", async () => {
    const { deps } = fakeDeps();
    const r = await call(deps, HF.QUERY_SYSTEM);
    expect(r.rc).toBe(HRC.SUCCESSFUL);
    expect(text(r)).toContain("ts5250");
  });
});

describe("待ち", () => {
  it("ロックが解けていれば Wait は即成功", async () => {
    const { deps } = await connected({ snapshot: snap({ locked: false }) });
    expect((await call(deps, HF.WAIT)).rc).toBe(HRC.SUCCESSFUL);
  });

  it("**ロックしたままなら時間切れで rc=4**（無限に待たない）", async () => {
    const { deps } = await connected({ snapshot: snap({ locked: true }) });
    expect((await call(deps, HF.WAIT)).rc).toBe(HRC.PS_BUSY);
  });
});

/**
 * **予約**（`Reserve` 11 / `Release` 12）。
 *
 * これが無いと、利用者がブラウザで打っている最中に自動操作が画面を変えられる。
 * 5250 は欄の値を AID と一緒に送るので、**同じ画面に 2 人が書くと衝突する**。
 */
describe("予約（Reserve / Release）", () => {
  it("**Reserve が通り、Release で戻る**", async () => {
    const f = await connected();
    expect((await call(f.deps, HF.RESERVE)).rc).toBe(HRC.SUCCESSFUL);
    expect(f.holder()).toBe("hllapi:");
    expect((await call(f.deps, HF.RELEASE)).rc).toBe(HRC.SUCCESSFUL);
    expect(f.holder()).toBeUndefined();
  });

  it("**別の主体が持っていたら rc=11**（資源が使えない）", async () => {
    const f = await connected({ reservedBy: "someone-else" });
    expect((await call(f.deps, HF.RESERVE)).rc).toBe(HRC.RESOURCE_UNAVAILABLE);
  });

  it("同じ主体の再予約は通る（期限の延長。何度呼ばれても壊れない）", async () => {
    const f = await connected();
    expect((await call(f.deps, HF.RESERVE)).rc).toBe(HRC.SUCCESSFUL);
    expect((await call(f.deps, HF.RESERVE)).rc).toBe(HRC.SUCCESSFUL);
  });

  it("**Disconnect で予約が外れる**（正常終了したのに締め切ったままにしない）", async () => {
    const f = await connected();
    await call(f.deps, HF.RESERVE);
    expect(f.holder()).toBe("hllapi:");
    expect((await call(f.deps, HF.DISCONNECT_PS, { data: "A" })).rc).toBe(HRC.SUCCESSFUL);
    expect(f.holder()).toBeUndefined();
  });

  it("持っていなくても Release は成功（HLLAPI の慣行）", async () => {
    const f = await connected();
    expect((await call(f.deps, HF.RELEASE)).rc).toBe(HRC.SUCCESSFUL);
  });

  it("**接続していなければ rc=8**（順序違い。予約も接続を要する）", async () => {
    const { deps } = fakeDeps();
    expect((await call(deps, HF.RESERVE)).rc).toBe(HRC.PROCEDURE_ERROR);
  });

  it("**閲覧専用は予約できない**（予約しても書けない）", async () => {
    const f = await connected({ writable: false });
    expect((await call(f.deps, HF.RESERVE)).rc).toBe(HRC.FUNCTION_INHIBITED);
  });
});

/**
 * **どのシステムのどのセッションかを指定する**（ts5250 の拡張）。
 *
 * 標準の `Connect` は短縮名 1 文字しか渡さないので、開いた順でしか指せない。
 * 自動化にとってこれは危うい——順番が変われば**別のシステムの本番画面**を操作しうる。
 * `"A <指定>"` と書けるようにして、当たらなければ**繋がずに断る**。
 */
describe("Connect の指定（どのシステムのどのセッションか）", () => {
  const two = {
    sessions: [
      { id: "id-honban", connectedAt: "2026-08-03T00:00:00Z",
        target: { system: "srv:pa", session: "srv:s1", name: "本番" } },
      { id: "id-kensho", connectedAt: "2026-08-03T01:00:00Z",
        target: { system: "srv:pb", session: "srv:s2", name: "検証" } }
    ]
  };
  /** 短縮名 A がどのセッションを指しているか（Query Sessions の行から読む） */
  const boundTo = async (deps: HllapiDeps): Promise<string> =>
    text(await call(deps, HF.QUERY_SESSIONS, { length: 256 })).trim();

  it("**名前で指せる**（開いた順に依らない）", async () => {
    const { deps } = fakeDeps(two);
    expect((await call(deps, HF.CONNECT_PS, { data: "A 検証" })).rc).toBe(HRC.SUCCESSFUL);
    expect(await boundTo(deps)).toContain("検証");
  });

  it("**設定の参照でも指せる**", async () => {
    const { deps } = fakeDeps(two);
    expect((await call(deps, HF.CONNECT_PS, { data: "A srv:s2" })).rc).toBe(HRC.SUCCESSFUL);
    expect(await boundTo(deps)).toContain("検証");
  });

  it("**セッション id でも指せる**", async () => {
    const { deps } = fakeDeps(two);
    expect((await call(deps, HF.CONNECT_PS, { data: "A id-honban" })).rc).toBe(HRC.SUCCESSFUL);
    expect(await boundTo(deps)).toContain("本番");
  });

  it("**システムと名前の組で指せる**（名前が重なるとき）", async () => {
    const { deps } = fakeDeps(two);
    expect((await call(deps, HF.CONNECT_PS, { data: "A srv:pa/本番" })).rc).toBe(HRC.SUCCESSFUL);
    expect(await boundTo(deps)).toContain("本番");
  });

  it("大文字小文字は無視する（VBA から書く名前なので）", async () => {
    const { deps } = fakeDeps({
      sessions: [{ id: "x", connectedAt: "2026-08-03T00:00:00Z", target: { name: "Main" } }]
    });
    expect((await call(deps, HF.CONNECT_PS, { data: "A main" })).rc).toBe(HRC.SUCCESSFUL);
  });

  it("**当たらなければ繋がない**（黙って別の画面を操作させない）", async () => {
    const { deps } = fakeDeps(two);
    expect((await call(deps, HF.CONNECT_PS, { data: "A 存在しない" })).rc).toBe(HRC.PS_ID_INVALID);
    // 繋がっていないので、以降の操作は順序違い
    expect((await call(deps, HF.COPY_PS, { length: 20 })).rc).toBe(HRC.PROCEDURE_ERROR);
  });

  it("**曖昧なら断る**（同じ名前が 2 つ開いている）", async () => {
    const { deps } = fakeDeps({
      sessions: [
        { id: "a", connectedAt: "2026-08-03T00:00:00Z", target: { name: "同じ" } },
        { id: "b", connectedAt: "2026-08-03T01:00:00Z", target: { name: "同じ" } }
      ]
    });
    expect((await call(deps, HF.CONNECT_PS, { data: "A 同じ" })).rc).toBe(HRC.RESOURCE_UNAVAILABLE);
  });

  it("**固定長バッファの NUL 埋めを無視する**（VBA の `String * 64` / C の `char[64]`）", async () => {
    const { deps } = fakeDeps(two);
    const padded = "A 検証".padEnd(64, "\0");
    expect((await call(deps, HF.CONNECT_PS, { data: padded, length: 64 })).rc).toBe(HRC.SUCCESSFUL);
    expect(await boundTo(deps)).toContain("検証");
  });

  it("**指定なしは従来どおり**（既存の資産が動く）", async () => {
    const { deps } = fakeDeps(two);
    expect((await call(deps, HF.CONNECT_PS, { data: "A" })).rc).toBe(HRC.SUCCESSFUL);
    expect(await boundTo(deps)).toContain("本番"); // 古い順に A
  });

  it("**Query Sessions が指定の書き方を出す**（これが無いと指し方が分からない）", async () => {
    const { deps } = fakeDeps(two);
    await call(deps, HF.CONNECT_PS, { data: "A 検証" });
    await call(deps, HF.CONNECT_PS, { data: "B 本番" });
    const lines = (await boundTo(deps)).split("\n").sort();
    expect(lines[0]).toMatch(/^A h 2x10 検証$/u);
    expect(lines[1]).toMatch(/^B h 2x10 本番$/u);
  });
});

/**
 * **`Connect("A")` の割り当て**——指定を書かない標準の使い方。
 *
 * `docs/hllapi-sample.bas` の `Connect` は **128 バイトの固定長**で渡す
 * （`"A"` ＋ 空白 127）。詰め物で 2 度踏んでいるので、**サンプルが実際に送る形**で見る。
 */
describe("Connect(\"A\") の割り当て", () => {
  /** VBA サンプルが実際に送る形（"A" ＋ 空白で 128 バイト） */
  const vbaShape = (psName: string) => ({ data: psName.padEnd(128, " "), length: 128 });
  const at = (id: string, hour: string) => ({ id, connectedAt: `2026-08-03T${hour}:00:00Z` });
  const bound = async (deps: HllapiDeps) => text(await call(deps, HF.QUERY_SESSIONS, { length: 256 })).trim();

  it("**1 台だけ動いていれば、それが割り当たる**", async () => {
    const { deps } = fakeDeps({ sessions: [at("only", "00")] });
    expect((await call(deps, HF.CONNECT_PS, vbaShape("A"))).rc).toBe(HRC.SUCCESSFUL);
    // 実際に操作できる（繋がったつもりで終わっていない）
    expect((await call(deps, HF.COPY_PS, { length: 20 })).rc).toBe(HRC.SUCCESSFUL);
  });

  it("**空白の詰め物があっても効く**（サンプルの固定長がそのまま通る）", async () => {
    const { deps } = fakeDeps({ sessions: [at("only", "00")] });
    expect((await call(deps, HF.CONNECT_PS, vbaShape("A"))).rc).toBe(HRC.SUCCESSFUL);
  });

  it("1 台も動いていなければ rc=1", async () => {
    const { deps } = fakeDeps({ sessions: [] });
    expect((await call(deps, HF.CONNECT_PS, vbaShape("A"))).rc).toBe(HRC.PS_ID_INVALID);
  });

  it("2 台なら A=古いほう・B=新しいほう", async () => {
    const { deps } = fakeDeps({ sessions: [at("old", "00"), at("new", "01")] });
    expect((await call(deps, HF.CONNECT_PS, vbaShape("A"))).rc).toBe(HRC.SUCCESSFUL);
    expect((await call(deps, HF.CONNECT_PS, vbaShape("B"))).rc).toBe(HRC.SUCCESSFUL);
    expect(await bound(deps)).toBe("A h 2x10 old\nB h 2x10 new");
  });

  it("**1 台しか無いのに B を指すと、その 1 台が割り当たる**（空きへ寄せる）", async () => {
    const { deps } = fakeDeps({ sessions: [at("only", "00")] });
    expect((await call(deps, HF.CONNECT_PS, vbaShape("B"))).rc).toBe(HRC.SUCCESSFUL);
    expect(await bound(deps)).toBe("B h 2x10 only");
  });

  it("**空きが無ければ rc=1**（同じ 1 台を A と B の両方には割り当てない）", async () => {
    const { deps } = fakeDeps({ sessions: [at("only", "00")] });
    await call(deps, HF.CONNECT_PS, vbaShape("A"));
    expect((await call(deps, HF.CONNECT_PS, vbaShape("B"))).rc).toBe(HRC.PS_ID_INVALID);
  });

  it("同じ短縮名をもう一度繋いでも同じ 1 台のまま", async () => {
    const { deps } = fakeDeps({ sessions: [at("only", "00")] });
    await call(deps, HF.CONNECT_PS, vbaShape("A"));
    expect((await call(deps, HF.CONNECT_PS, vbaShape("A"))).rc).toBe(HRC.SUCCESSFUL);
    expect(await bound(deps)).toBe("A h 2x10 only");
  });
});

/**
 * **監査**。MCP は `withAudit` を 25 箇所、WebSocket は 12 箇所で通しているのに、
 * HLLAPI だけ素通しだった（2026-08-04 に発覚）。
 *
 * ここは **管理者が他人のセッションへ届く経路**でもある——`assertOwner` は admin を通し、
 * `list` も admin には全件返す。誰が誰のセッションを動かしたか残らないのはまずい。
 */
describe("監査", () => {
  const collect = async (fn: () => Promise<unknown>): Promise<AuditEvent[]> => {
    const events: AuditEvent[] = [];
    setAuditSink((e) => events.push(e));
    try {
      await fn();
    } finally {
      setAuditSink(() => undefined);
    }
    return events;
  };

  it("**画面を変えうる操作は記録される**", async () => {
    const { deps } = fakeDeps();
    const events = await collect(async () => {
      await call(deps, HF.CONNECT_PS, { data: "A" });
      await call(deps, HF.SEND_KEY, { data: "@E" });
    });
    expect(events.map((e) => e.op)).toEqual([`hllapi_${HF.CONNECT_PS}`, `hllapi_${HF.SEND_KEY}`]);
    expect(events[1]).toMatchObject({ result: "ok", sessionId: "s1" });
  });

  it("**読むだけの操作は記録しない**（画面を見ただけで監査が膨らまない）", async () => {
    const { deps } = await connected();
    const events = await collect(async () => {
      await call(deps, HF.COPY_PS, { length: 20 });
      await call(deps, HF.SEARCH_PS, { data: "X" });
      await call(deps, HF.QUERY_CURSOR_LOCATION);
    });
    expect(events).toEqual([]);
  });

  it("失敗も残る（`rc` つき）", async () => {
    const { deps } = fakeDeps({ sessions: [] });
    const events = await collect(() => call(deps, HF.CONNECT_PS, { data: "A" }));
    expect(events[0]).toMatchObject({ result: "error", code: `rc=${HRC.PS_ID_INVALID}` });
  });

  it("**他人のセッションを触ったことが読み取れる**（管理者の遠隔操作）", async () => {
    const { deps } = fakeDeps({
      sessions: [
        { id: "s1", connectedAt: "2026-08-03T00:00:00Z", owner: "tanaka", target: { name: "田中の画面" } }
      ]
    });
    const admin = { username: "kanri", role: "admin" } as AuthUser;
    // **名指しでなければ届かない**（既定は自分のセッションだけ）。
    // 越権は明示的な操作なので、監査に残す価値もそこにある
    const events = await collect(async () => {
      const spec = "A 田中の画面";
      await callHllapi(deps, { function: HF.CONNECT_PS, dataB64: b64(spec), length: spec.length, pos: 0 }, admin);
      await callHllapi(deps, { function: HF.SEND_KEY, dataB64: b64("@E"), length: 2, pos: 0 }, admin);
    });
    // **所有者が載る**——自分以外のセッションを動かしたことが監査から分かる
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.key === "owner=tanaka")).toBe(true);
  });

  it("自分のセッションなら所有者は載せない（雑音にしない）", async () => {
    const { deps } = fakeDeps({
      sessions: [{ id: "s1", connectedAt: "2026-08-03T00:00:00Z", owner: "tanaka" }]
    });
    const self = { username: "tanaka", role: "user" } as AuthUser;
    const events = await collect(() =>
      callHllapi(deps, { function: HF.CONNECT_PS, dataB64: b64("A"), length: 1, pos: 0 }, self)
    );
    expect(events[0]?.key).toBeUndefined();
  });

  it("**バッファの中身は載せない**（サインオン画面への入力が通る経路）", async () => {
    const { deps } = await connected();
    const events = await collect(() => call(deps, HF.SEND_KEY, { data: "HIMITSU@E" }));
    expect(JSON.stringify(events)).not.toContain("HIMITSU");
  });
});

/**
 * **指定なしの `Connect` は自分のセッションだけを見る。**
 *
 * `SessionManager.list` は admin には全件返す（`ownedOnly` が admin を素通し）。
 * そのままだと管理者の `Connect("A")` が「サーバー上で最も古いセッション」——
 * 十中八九**他人の画面**——を黙って掴む。
 *
 * 支援のために他人を触るのは正当な用途なので**塞がない**が、**既定にはしない**。
 * 名指しすれば届く＝越権は明示的な操作に閉じる。
 */
describe("既定は自分のセッションに限る（管理者の誤操作を防ぐ）", () => {
  const admin = { username: "kanri", role: "admin" } as AuthUser;
  const conn = (deps: HllapiDeps, data: string, u?: AuthUser) =>
    callHllapi(deps, { function: HF.CONNECT_PS, dataB64: b64(data), length: data.length, pos: 0 }, u);
  const bound = async (deps: HllapiDeps, u?: AuthUser) =>
    text(
      await callHllapi(deps, { function: HF.QUERY_SESSIONS, dataB64: "", length: 256, pos: 0 }, u)
    ).trim();

  /** 他人のセッションのほうが古い＝従来なら管理者の "A" がこれを掴んでいた */
  const mixed = {
    sessions: [
      { id: "hito-no", connectedAt: "2026-08-03T00:00:00Z", owner: "tanaka", target: { name: "田中の画面" } },
      { id: "jibun-no", connectedAt: "2026-08-03T01:00:00Z", owner: "kanri", target: { name: "自分の画面" } }
    ]
  };

  it("**管理者の `Connect(\"A\")` は他人の画面を掴まない**（自分のほうへ行く）", async () => {
    const { deps } = fakeDeps(mixed);
    expect((await conn(deps, "A", admin)).rc).toBe(HRC.SUCCESSFUL);
    expect(await bound(deps, admin)).toContain("自分の画面");
  });

  it("**自分のセッションが無ければ rc=1**（他人へは寄せない）", async () => {
    const { deps } = fakeDeps({
      sessions: [{ id: "hito-no", connectedAt: "2026-08-03T00:00:00Z", owner: "tanaka" }]
    });
    expect((await conn(deps, "A", admin)).rc).toBe(HRC.PS_ID_INVALID);
  });

  it("**名指しなら他人へ届く**（支援は塞がない。越権は明示的な操作に閉じる）", async () => {
    const { deps } = fakeDeps(mixed);
    expect((await conn(deps, "A 田中の画面", admin)).rc).toBe(HRC.SUCCESSFUL);
    expect(await bound(deps, admin)).toContain("田中の画面");
  });

  it("一般の利用者は影響を受けない（`list` の時点で自分の分しか来ない）", async () => {
    const { deps } = fakeDeps({
      sessions: [{ id: "jibun-no", connectedAt: "2026-08-03T00:00:00Z", owner: "tanaka" }]
    });
    const user = { username: "tanaka", role: "user" } as AuthUser;
    expect((await conn(deps, "A", user)).rc).toBe(HRC.SUCCESSFUL);
  });

  it("認証オフも影響を受けない（`user` も `owner` も undefined で一致する）", async () => {
    const { deps } = fakeDeps({ sessions: [{ id: "only", connectedAt: "2026-08-03T00:00:00Z" }] });
    expect((await conn(deps, "A")).rc).toBe(HRC.SUCCESSFUL);
  });
});

/**
 * **触られた側に「誰が操作しているか」を出す。**
 *
 * 管理者は他人のセッションへ届く。支援としては正当だが、
 * 「HLLAPI が自動操作中です」としか出ないのは不親切で、無断操作の抑止にもならない。
 */
describe("予約の表示名", () => {
  const owned = (owner: string) => ({
    sessions: [{ id: "s1", connectedAt: "2026-08-03T00:00:00Z", owner, target: { name: "画面" } }]
  });

  it("**他人のセッションなら操作者の名前が出る**", async () => {
    const f = fakeDeps(owned("tanaka"));
    const admin = { username: "kanri", role: "admin" } as AuthUser;
    const spec = "A 画面";
    await callHllapi(f.deps, { function: HF.CONNECT_PS, dataB64: b64(spec), length: spec.length, pos: 0 }, admin);
    await callHllapi(f.deps, { function: HF.RESERVE, dataB64: "", length: 8, pos: 0 }, admin);
    // 画面には `msgReserved(label)` ＝「… が自動操作中です」として出る
    expect(f.label()).toBe("kanri（HLLAPI）");
  });

  it("自分のセッションなら仕組みの名前だけ（自分に自分の名前を出しても情報が無い）", async () => {
    const f = fakeDeps(owned("tanaka"));
    const self = { username: "tanaka", role: "user" } as AuthUser;
    await callHllapi(f.deps, { function: HF.CONNECT_PS, dataB64: b64("A"), length: 1, pos: 0 }, self);
    await callHllapi(f.deps, { function: HF.RESERVE, dataB64: "", length: 8, pos: 0 }, self);
    expect(f.label()).toBe("HLLAPI");
  });

  it("認証オフでも仕組みの名前だけ", async () => {
    const f = await connected();
    await call(f.deps, HF.RESERVE, { length: 8 });
    expect(f.label()).toBe("HLLAPI");
  });
});
