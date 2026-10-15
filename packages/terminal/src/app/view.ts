/**
 * 端末の「画面表示」設定。web-ui の `viewSettings`（ACS の表示設定）のうち、文字端末で実現できるものだけを持つ。
 * **純ロジック**（Node API 非依存）。描画は `render/frame.ts`、切替は `controller.ts`、ヘッダーの操作パネルの文言はここ。
 *
 * 取り込んだ項目と、端末での見せ方（web-ui との差）:
 * - 罫線（DDS のグリッド罫線）の表示・非表示。文字のあるセルの横罫は上線・下線で重ねる（縦罫は重ねられない）
 * - SO/SI の表示（非表示・薄目・濃目）。薄目は SGR 2（淡色）、濃目は桁の色のまま
 * - 表示コード（カナ⇄英）。ホストの SBCS 表を読み直す規則は web-ui の `resolveSbcsView` と同じ
 * - カーソルの形（ブロック・下線）と明滅。DECSCUSR で端末のカーソルそのものを変える（挿入中は下線——ACS と同じ）
 * - ルーラー（ACS の「罫線」＝カーソルの行・桁の十字線）。端末は細い線を引けないので、行と桁を薄い背景色の帯にする
 * - 桁区切り（DSPATR(CS)）の点線の下線の表示・非表示
 * 取り込まないもの: マウスポインター（端末はマウスを使わない）・リンク化・配色・質感・フォント・窓の背景（いずれも端末の側の設定）。
 */
import { katakanaChar, latinChar } from "@ts5250/ebcdic/katakana";

export type SosiMode = "none" | "dim" | "strong";
export type KanaMode = "auto" | "kana" | "latin";
export type CursorShape = "block" | "underline";
export type RuleStyle = "crosshair" | "horizontal" | "vertical";

export interface TermView {
  /** DDS のグリッド罫線・窓の枠を描くか */
  grid: boolean;
  sosi: SosiMode;
  kana: KanaMode;
  cursorShape: CursorShape;
  cursorBlink: boolean;
  /** ルーラーを出すか（ACS「罫線」。既定 OFF） */
  rule: boolean;
  ruleStyle: RuleStyle;
  /** ルーラーがカーソルに従うか。いいえなら出した時点の位置に固定する */
  ruleFollow: boolean;
  /** 桁区切りの点線の下線を出すか */
  colSep: boolean;
  /** ヘッダーの操作パネルを出すか */
  header: boolean;
}

/** 起動時の既定。web-ui の既定（罫線 ON・SO/SI 非表示・表示コード auto・ブロック・明滅 ON・ルーラー OFF）に合わせる */
export const DEFAULT_VIEW: TermView = {
  grid: true,
  sosi: "none",
  kana: "auto",
  cursorShape: "block",
  cursorBlink: true,
  rule: false,
  ruleStyle: "crosshair",
  ruleFollow: true,
  colSep: true,
  header: true
};

/** ヘッダーなしの素の見え方（`renderFrame` に設定を渡さないときの既定。従来の描画と同じ） */
export const PLAIN_VIEW: TermView = { ...DEFAULT_VIEW, header: false };

const next = <T>(all: readonly T[], cur: T): T => all[(all.indexOf(cur) + 1) % all.length]!;

export const SOSI_ORDER: readonly SosiMode[] = ["none", "dim", "strong"];
export const KANA_ORDER: readonly KanaMode[] = ["auto", "kana", "latin"];
export const RULE_STYLE_ORDER: readonly RuleStyle[] = ["crosshair", "horizontal", "vertical"];

/** 接頭キーの次の文字 → 設定の切替。切替後の値を返す（`null` は割り当て無し） */
export function toggleView(v: TermView, key: string): TermView | null {
  switch (key) {
    case "g": return { ...v, grid: !v.grid };
    case "o": return { ...v, sosi: next(SOSI_ORDER, v.sosi) };
    case "k": return { ...v, kana: next(KANA_ORDER, v.kana) };
    case "u": return { ...v, cursorShape: v.cursorShape === "block" ? "underline" : "block" };
    case "b": return { ...v, cursorBlink: !v.cursorBlink };
    case "l": return { ...v, rule: !v.rule };
    case "m": return { ...v, ruleStyle: next(RULE_STYLE_ORDER, v.ruleStyle) };
    case "f": return { ...v, ruleFollow: !v.ruleFollow };
    case "v": return { ...v, colSep: !v.colSep };
    case "w": return { ...v, header: !v.header };
    default: return null;
  }
}

/** 実効の表示コード。`host` は読み直さない（web-ui `resolveSbcsView` と同じ規則） */
export type SbcsView = "host" | "kana" | "latin";
export function resolveSbcsView(kana: KanaMode, hostIsKatakana: boolean): SbcsView {
  if (kana === "auto") return "host";
  if (kana === "kana") return hostIsKatakana ? "host" : "kana";
  return hostIsKatakana ? "latin" : "host";
}

/**
 * 生バイトを実効の表で読み直した字。読み直した結果が制御文字（EBCDIC の SBCS 表は 256 中 96 バイトを C0/C1 へ写す）や
 * 未定義なら空白にする——そのまま出すと端末が幅を取り違えて行がずれる（web-ui `recodeChar` と同じ理由）。
 */
export function recodeByte(byte: number, view: Exclude<SbcsView, "host">): string {
  const ch = view === "kana" ? katakanaChar(byte) : latinChar(byte);
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfffd ? " " : ch;
}

/** 端末のカーソルの形（DECSCUSR）。挿入中は形によらず下線（ACS `ScreenText.setInsert`）。 */
export function cursorSequence(v: TermView, insert: boolean): string {
  const underline = insert || v.cursorShape === "underline";
  const n = (underline ? 3 : 1) + (v.cursorBlink ? 0 : 1);
  return `\x1b[${n} q`;
}

const onOff = (b: boolean): string => (b ? "入" : "切");
const SOSI_LABEL: Record<SosiMode, string> = { none: "なし", dim: "薄", strong: "濃" };
const KANA_LABEL: Record<KanaMode, string> = { auto: "自動", kana: "カナ", latin: "英" };
const RULE_LABEL: Record<RuleStyle, string> = { crosshair: "十字", horizontal: "横", vertical: "縦" };

/** ヘッダーの操作パネル 1 行。`Ctrl+<接頭> の次` のキーを頭に付け、いまの値を並べる */
export function headerText(v: TermView, prefix: string): string {
  const rule = v.rule ? `${RULE_LABEL[v.ruleStyle]}${v.ruleFollow ? "" : "固定"}` : "切";
  return [
    `Ctrl+${prefix}→`,
    `g罫線:${onOff(v.grid)}`,
    `oSO/SI:${SOSI_LABEL[v.sosi]}`,
    `kカナ:${KANA_LABEL[v.kana]}`,
    `uカーソル:${v.cursorShape === "block" ? "■" : "_"}`,
    `b明滅:${onOff(v.cursorBlink)}`,
    `lルーラー:${rule}`,
    `m形 f固定`,
    `v桁区切:${onOff(v.colSep)}`,
    `wパネル`
  ].join(" ");
}

/** 切替したときに状態行へ出す一言 */
export function viewNote(v: TermView, key: string): string {
  switch (key) {
    case "g": return `罫線: ${onOff(v.grid)}`;
    case "o": return `SO/SI 表示: ${SOSI_LABEL[v.sosi]}`;
    case "k": return `表示コード: ${KANA_LABEL[v.kana]}`;
    case "u": return `カーソル: ${v.cursorShape === "block" ? "ブロック" : "下線"}`;
    case "b": return `カーソルの明滅: ${onOff(v.cursorBlink)}`;
    case "l": return `ルーラー: ${v.rule ? RULE_LABEL[v.ruleStyle] : "切"}`;
    case "m": return `ルーラーの形: ${RULE_LABEL[v.ruleStyle]}`;
    case "f": return `ルーラー: ${v.ruleFollow ? "カーソルに従う" : "固定"}`;
    case "v": return `桁区切り: ${onOff(v.colSep)}`;
    default: return "";
  }
}
