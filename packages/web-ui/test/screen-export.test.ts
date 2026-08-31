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
    // ローカル時刻の各要素から作る＝**どのタイムゾーンで走らせても同じ名前**になる
    const name = downloadScreenHtml(SID, new Date(2026, 7, 1, 9, 30, 0));
    expect(name).toBe("DEV1-2026-08-01T09-30-00.html");
    expect(downloadName).toBe(name);
    expect(written).toMatch(/^<!DOCTYPE html>/);
    expect(written).toContain("HELLO");
    expect(written).toContain("192.0.2.1"); // 接続先をメタに載せる
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  /**
   * **ファイル名の時刻はブラウザのローカル時刻。**
   *
   * UTC のままだと、日本から保存した画面に 9 時間前の名前が付く。保存した HTML を並べて
   * 突き合わせる使い方なので、名前の時刻が手元の時計と合っていないと効かない。
   *
   * 走らせる環境のタイムゾーンに依存させないため、この 2 件だけ `TZ` を明示して測る
   * （手元は Asia/Tokyo、CI は UTC）。
   */
  it.each([
    ["Asia/Tokyo", "DEV1-2026-08-01T18-30-00.html"],
    ["America/New_York", "DEV1-2026-08-01T05-30-00.html"]
  ])("UTC ではなくローカル時刻で名前を付ける（TZ=%s）", (tz, expected) => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      addSession(snapshotWith([cell("A")]));
      // 同じ瞬間（UTC 09:30）でも、名前は見ている場所の時計で決まる
      expect(downloadScreenHtml(SID, new Date("2026-08-01T09:30:00Z"))).toBe(expected);
    } finally {
      process.env.TZ = prev;
    }
  });

  /** 桁は必ず 2 桁に揃える（名前順＝時刻順を崩さない） */
  it("月日・時分秒を 0 詰めする", () => {
    addSession(snapshotWith([cell("A")]));
    expect(downloadScreenHtml(SID, new Date(2026, 0, 2, 3, 4, 5))).toBe(
      "DEV1-2026-01-02T03-04-05.html"
    );
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

  /**
   * **SO/SI は書き出す側で焼き込まない。** マークは `renderScreenHtml` が常に HTML へ入れ、
   * 読み手が**ページ内の順送り（CSS だけ）**で 非表示 / 薄目 / 濃目 を選べる。ここから渡すのは
   * 「開いたときの見せ方」だけ——画面と同じ状態で開くための初期値である。
   *
   * **画面設定の 3 値をそのまま渡す**のが肝で、ここが 2 値に落ちると「濃目」で保存しても
   * 薄目で開くことになり、画面と保存した HTML で絵が食い違う。
   */
  it("SO/SI 表示「薄目」は、薄目の状態で開く", () => {
    addSession(snapshotWith([cell("", { kind: "so" }), cell("あ", { kind: "dbcs-lead" })]));
    viewSettings.set("sosi", "dim");
    downloadScreenHtml(SID);
    expect(written).toContain('<span class="c-green a-so">{</span>');
    expect(written).toContain('id="s1" checked');
  });

  it("SO/SI 表示「濃目」は、濃目の状態で開く", () => {
    addSession(snapshotWith([cell("", { kind: "so" }), cell("あ", { kind: "dbcs-lead" })]));
    viewSettings.set("sosi", "strong");
    downloadScreenHtml(SID);
    expect(written).toContain('id="s2" checked');
  });

  it("SO/SI 非表示なら、開いた時点では出ていない（順送りは置く）", () => {
    addSession(snapshotWith([cell("", { kind: "so" }), cell("あ", { kind: "dbcs-lead" })]));
    viewSettings.set("sosi", "none");
    downloadScreenHtml(SID);
    expect(written).toContain('<input class="tg" type="radio" name="s" id="s0" checked>');
    expect(written).toContain('for="s2">SO/SI 薄目</label>');
  });
});
