import { reactive } from "vue";
import type { WsVtFrame, WsVtRun, WsVtStyle } from "@ts5250/server";

/**
 * **VT の画面。**
 *
 * 5250 / 3270 の `ScreenSnapshot` とは別物なので `sessionsStore` には入れない——
 * あちらはセルの二次元配列で、フィールドと編集差分を伴う。VT は
 * **run（同じ見た目が続く一区切り）の並び**で、フィールドも編集差分も無い。
 *
 * サーバーは**変わった行だけ**を送ってくる（`vt-wire.ts`）。ここが前の状態に重ねて
 * 完全な画面を保つ。**重ねる先を持つのがブラウザ側**という分担にしているのは、
 * 打鍵のたびに全画面を流さないため。
 */

/** 見た目を解決した run（`style` は palette から引いたもの） */
export interface VtRunView {
  col: number;
  text: string;
  style?: WsVtStyle;
}

export interface VtViewState {
  sessionId: string;
  rows: number;
  cols: number;
  cursor: { row: number; col: number; visible: boolean };
  /** 代替画面を表示中か。**このとき履歴は出さない**（`vi` の背後に履歴が見えるのはおかしい） */
  alternate: boolean;
  title: string;
  /** 表示中の画面（`rows` 行） */
  lines: VtRunView[][];
  /** 主画面から流れ出た行（古い順） */
  scrollback: VtRunView[][];
  /** ホストが ECHO を握ったか＝文字モードが成立しているか */
  hostEchoes: boolean;
  ibmI: boolean;
  encoding: string;
  connected: boolean;
  /** 利用者を最下部へ引き戻すか（自分で遡っている間は引き戻さない） */
  followTail: boolean;
}

const byId = reactive(new Map<string, VtViewState>());

export const vtStore = {
  get(id: string): VtViewState | undefined {
    return byId.get(id);
  },

  /** `vt-opened` から作る（フレームには全行が入っている） */
  create(
    id: string,
    frame: WsVtFrame,
    info: { encoding: string; ibmI: boolean; hostEchoes: boolean }
  ): VtViewState {
    const state: VtViewState = reactive({
      sessionId: id,
      rows: frame.rows,
      cols: frame.cols,
      cursor: frame.cursor,
      alternate: frame.alternate,
      title: frame.title,
      lines: blankLines(frame.rows),
      scrollback: [],
      hostEchoes: info.hostEchoes,
      ibmI: info.ibmI,
      encoding: info.encoding,
      connected: true,
      followTail: true
    }) as VtViewState;
    applyFrame(state, frame);
    byId.set(id, state);
    return state;
  },

  /** 差分を重ねる */
  apply(id: string, frame: WsVtFrame): void {
    const s = byId.get(id);
    if (s === undefined) return;
    applyFrame(s, frame);
  },

  setTitle(id: string, title: string): void {
    const s = byId.get(id);
    if (s !== undefined) s.title = title;
  },

  setHostEchoes(id: string, on: boolean): void {
    const s = byId.get(id);
    if (s !== undefined) s.hostEchoes = on;
  },

  setConnected(id: string, connected: boolean): void {
    const s = byId.get(id);
    if (s !== undefined) s.connected = connected;
  },

  setFollowTail(id: string, follow: boolean): void {
    const s = byId.get(id);
    if (s !== undefined) s.followTail = follow;
  },

  remove(id: string): void {
    byId.delete(id);
  },

  /** 画面をテキストに（検証スクリプト・コピー用） */
  text(id: string, withScrollback = false): string {
    const s = byId.get(id);
    if (s === undefined) return "";
    const rows = withScrollback && !s.alternate ? [...s.scrollback, ...s.lines] : s.lines;
    return rows.map((r) => lineText(r)).join("\n");
  }
};

/**
 * run の並びを桁どおりの 1 行テキストへ（間は空白で埋める）。
 *
 * **文字数ではなく桁数で数える。** 全角は 1 文字で 2 桁を占めるので、
 * `String.length` で位置を測ると全角を含む行がずれる。
 */
export function lineText(runs: readonly VtRunView[]): string {
  let out = "";
  let col = 0;
  for (const r of runs) {
    if (r.col > col) {
      out += " ".repeat(r.col - col);
      col = r.col;
    }
    out += r.text;
    col += textCols(r.text);
  }
  return out.replace(/ +$/u, "");
}

/** 文字列が占める桁数（全角は 2 桁） */
export function textCols(text: string): number {
  let n = 0;
  for (const ch of text) n += isWide(ch) ? 2 : 1;
  return n;
}

/**
 * 全角かどうか。**`@ts5250/base` の `isFullWidth` と同じ範囲**を使う。
 *
 * base を実行時に引き込まないのは、web-ui のバンドルに 1 つでも余計な依存を足さないため
 * （AGENTS.md「ブラウザから触る側は狭い入口を使う」）。**判定の出どころはコメントで縛る**。
 */
function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function blankLines(rows: number): VtRunView[][] {
  return Array.from({ length: rows }, () => []);
}

function resolve(runs: readonly WsVtRun[], styles: readonly WsVtStyle[]): VtRunView[] {
  return runs.map((r) => ({
    col: r.col,
    text: r.text,
    ...(r.s !== undefined && styles[r.s] !== undefined ? { style: styles[r.s] } : {})
  }));
}

function applyFrame(s: VtViewState, frame: WsVtFrame): void {
  // **行数が変わったら器を作り直す**（差分の行番号が指す先が変わっている）
  if (frame.rows !== s.rows || s.lines.length !== frame.rows) {
    s.lines = blankLines(frame.rows);
  }
  s.rows = frame.rows;
  s.cols = frame.cols;
  s.cursor = frame.cursor;
  s.alternate = frame.alternate;
  s.title = frame.title;
  // **交渉は開いたあとに終わることがある**ので、載ってきたら更新する
  if (frame.hostEchoes !== undefined) s.hostEchoes = frame.hostEchoes;

  for (const line of frame.lines) {
    if (line.row < 0 || line.row >= s.lines.length) continue;
    s.lines[line.row] = resolve(line.runs, frame.styles);
  }

  // **頭から落ちたぶんを先に削る**（順番を逆にすると、足した行まで削ってしまう）
  if (frame.scrollbackDropped !== undefined && frame.scrollbackDropped > 0) {
    s.scrollback.splice(0, frame.scrollbackDropped);
  }
  if (frame.scrollback !== undefined) {
    for (const runs of frame.scrollback) s.scrollback.push(resolve(runs, frame.styles));
  }
}
