import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadScreenHtml } from "../src/screenExport.js";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";
import { viewSettings } from "../src/stores/viewSettings.js";
import type { Cell, ScreenSnapshot } from "@ts5250/tn5250";

/**
 * エミュレータ画面の「HTML」ボタン。
 *
 * 固めるのは **書き出した HTML が画面と一致すること**——`renderScreenHtml` はホストの
 * スナップショットをそのまま描くが、画面には表示設定（表示コードの再解釈・SO/SI マーク）が
 * 効いている。素のまま出すと、画面には `F3=exit` と見えているのに HTML は `F3=ｵﾒｹﾎ` になる。
 * カナ系ホスト（930/5026）を「英」で見ているときに実際に起こる食い違いなので、回帰資産として残す。
 */
const SID = "s1";

function cell(char: string, extra: Partial<Cell> = {}): Cell {
  return {
    char, kind: "sbcs", color: "green", reverse: false, underline: false,
    blink: false, columnSeparator: false, nonDisplay: false, ...extra
  } as Cell;
}

/** 1 行目に文字を置いた 24x80 のスナップショット */
function snapshotWith(cells0: Cell[]): ScreenSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < 24; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < 80; c++) row.push(cell(" "));
    cells.push(row);
  }
  cells0.forEach((c, i) => (cells[0]![i] = c));
  return {
    sessionId: SID, rows: 24, cols: 80, cursor: { row: 1, col: 1 },
    keyboardLocked: false, cells, fields: []
  } as ScreenSnapshot;
}

function addSession(snapshot: ScreenSnapshot | undefined, ccsid?: number): void {
  sessionsStore.byId.clear();
  sessionsStore.order = [];
  sessionsStore.add({
    sessionId: SID, label: "DEV1", kind: "display", snapshot,
    edits: new Map(), cursor: { row: 1, col: 1 }, connected: true, readOnly: false,
    ccsid, meta: { host: "192.0.2.1" },
    client: {} as SessionState["client"]
  } as SessionState);
}

let written = "";
let downloadName = "";
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  written = "";
  downloadName = "";
  URL.createObjectURL = vi.fn((b: Blob) => {
    // Blob の中身を同期で読めないので、生成時に文字列化しておく
    void b;
    return "blob:x";
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  // Blob へ渡された文字列を捕まえる
  const RealBlob = globalThis.Blob;
  vi.stubGlobal(
    "Blob",
    class extends RealBlob {
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts);
        written = parts.map((p) => String(p)).join("");
      }
    }
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    downloadName = this.download;
  });
  // 表示設定は全画面共通の保存値。テスト間で持ち越さないよう既定へ戻す
  viewSettings.set("kana", "auto");
  viewSettings.set("sosi", "none");
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionsStore.byId.clear();
  sessionsStore.order = [];
});

describe("画面を HTML で保存", () => {
  it("スナップショットがまだ無ければ何もしない", () => {
    addSession(undefined);
    expect(downloadScreenHtml(SID)).toBeUndefined();
    expect(downloadName).toBe("");
  });

  it("完結した HTML をセッション名つきのファイル名で保存する", () => {
    addSession(snapshotWith([...("HELLO" as string)].map((c) => cell(c))));
    const name = downloadScreenHtml(SID, new Date("2026-08-01T09:30:00Z"));
    expect(name).toBe("DEV1-2026-08-01T09-30-00.html");
    expect(downloadName).toBe(name);
    expect(written).toMatch(/^<!DOCTYPE html>/);
    expect(written).toContain("HELLO");
    expect(written).toContain("192.0.2.1"); // 接続先をメタに載せる
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  /**
   * **ここが本題。** カナ系ホスト（5026）を「英」で見ているとき、画面は生バイトを
   * 1027 の表で読み直して `exit` と出している。書き出しも同じでなければならない。
   */
  it("表示コード「英」を反映する（画面と同じ字が出る）", () => {
    // 0x85 0xa7 0x89 0xa3 = 1027 で "exit" / 290 では半角カナ
    const bytes = [0x85, 0xa7, 0x89, 0xa3];
    addSession(
      snapshotWith(bytes.map((b) => cell("ｵ", { kind: "sbcs", rawByte: b }))),
      5026
    );
    viewSettings.set("kana", "latin");
    downloadScreenHtml(SID);
    expect(written).toContain("exit");
    expect(written).toContain("表示コード=英"); // 素のままでない旨を注記に残す
  });

  it("表示コードが「自動」ならホストの解釈のまま出す", () => {
    addSession(snapshotWith([cell("ｵ", { kind: "sbcs", rawByte: 0x85 })]), 5026);
    downloadScreenHtml(SID);
    expect(written).toContain("ｵ");
    expect(written).not.toContain("表示コード=");
  });

  it("SO/SI 表示「薄目」を反映する（マークは淡色クラス付き）", () => {
    addSession(snapshotWith([cell("", { kind: "so" }), cell("あ", { kind: "dbcs-lead" })]));
    viewSettings.set("sosi", "dim");
    downloadScreenHtml(SID);
    // CSS にも `.a-so` は出るので、**桁に付いた**ことを class 属性の形で見る
    expect(written).toContain('<span class="c-green a-so">{</span>');
    expect(written).toContain("SO・SI 表示=薄目");
  });

  /** 「濃目」も**ふつうの文字より薄い**（薄目との違いは濃さだけ）。画面と絵を食い違わせない。 */
  it("SO/SI 表示「濃目」はマークに濃さの修飾子を足す", () => {
    addSession(snapshotWith([cell("", { kind: "so" }), cell("あ", { kind: "dbcs-lead" })]));
    viewSettings.set("sosi", "strong");
    downloadScreenHtml(SID);
    expect(written).toContain('<span class="c-green a-so a-so-strong">{</span>');
    expect(written).toContain("SO・SI 表示=濃目");
  });
});
