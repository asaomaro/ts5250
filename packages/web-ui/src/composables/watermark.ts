import type { Watermark } from "@ts5250/server";

/**
 * ウォーターマーク（画面に重ねる透かし）の実効値を組み立てる。
 *
 * 設定はセッション設定（`systems`/`sessions` の子）が持ち、**描くのはブラウザだけ**——
 * ホストへも core（プロトコル層）へも渡らない純粋な表示設定である。
 * ここは「保存値（欠けを許す）→ 描画に必要な値が揃った形」への変換と、
 * 差し込み変数の展開だけを担う純関数に閉じてある（コンポーネントから切り離してテストするため）。
 */

/** 保存値。サーバーの `watermarkSchema` と同じ形（欠けている項目は既定で補う） */
export type WatermarkConfig = Watermark;

/** 描画に渡す実効値。欠けが無い＝コンポーネントは分岐なしで描ける */
export interface WatermarkView {
  /** 差し込み変数を展開したあとの文字 */
  text: string;
  opacity: number;
  size: number;
  layout: "tile" | "center";
  angle: number;
  /** 未指定なら端末の前景色（`--t-white`）に追従する */
  color?: string;
}

/**
 * 既定値。**ホストや画面の内容を隠さない濃さ**を初期値にする（透かしは背景であって主役ではない）。
 * 角度と敷き詰めは ACS の見え方に合わせた。
 */
export const WATERMARK_DEFAULTS = {
  opacity: 0.12,
  size: 22,
  layout: "tile",
  angle: -30
} as const satisfies Omit<Required<WatermarkView>, "text" | "color">;

/** 差し込み変数の値。分からないものは undefined のまま渡してよい（空文字に潰れる） */
export interface WatermarkVars {
  /** 接続先ホスト */
  host?: string | undefined;
  /** 接続先ポート */
  port?: string | undefined;
  /** システム設定の名前（利用者が付けた「本番」「検証」等） */
  system?: string | undefined;
  /** セッション設定の名前 */
  session?: string | undefined;
  /** 装置名（実際に割り当てられた名前を優先） */
  device?: string | undefined;
  /** サインオンしたユーザー */
  user?: string | undefined;
}

/** 設定画面に出す変数の一覧（説明つき）。**置換側と同じ出どころ**にして食い違いを防ぐ */
export const WATERMARK_VARS: { key: keyof WatermarkVars; label: string }[] = [
  { key: "host", label: "ホスト" },
  { key: "port", label: "ポート" },
  { key: "system", label: "システム設定の名前" },
  { key: "session", label: "セッション設定の名前" },
  { key: "device", label: "装置名" },
  { key: "user", label: "ユーザー" }
];

const VAR_KEYS = new Set<string>(WATERMARK_VARS.map((v) => v.key));

/**
 * `{host}` のような差し込み変数を展開する。
 *
 * - **既知のキーは値が無ければ空文字に潰す**（サインオン前の `{user}` 等。生の `{user}` が
 *   画面に残るより、消えている方が透かしとして自然）。
 * - **未知のキーはそのまま残す**——打ち間違い（`{hosts}`）を利用者が見て気づけるようにする。
 */
export function expandWatermarkText(text: string, vars: WatermarkVars): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    VAR_KEYS.has(key) ? (vars[key as keyof WatermarkVars] ?? "") : whole
  );
}

/**
 * 保存値と差し込み変数から実効値を作る。表示しないケースは undefined を返す:
 * 設定が無い / `enabled: false` / `text` が文字列でない（下記参照） /
 * 展開後の文字が空白だけ（`{user}` だけの指定でサインオン前、等）。
 *
 * **`cfg.text` の型を確かめてから使う。** サーバー設定・個人設定経由（`watermarkSchema`）は
 * `text: z.string().min(1)` で保証されるが、**VSCode拡張の`.ts5250`ファイル経由はスキーマ検証を
 * 通らない**（`vscode-extension/src/schema.ts`の設計——手編集を許すため「JSONとして読めるか」
 * 以外は検証しない）。`{}` のような手編集の壊れた透かしがそのままここへ届きうるので、
 * `text.replace(...)` を`undefined`/数値等に対して呼んで例外にする前に弾く
 * （`20260924-vscode-extension` D16。落ちると`EmulatorPane`ごと描画不能になる）。
 */
export function resolveWatermark(
  cfg: WatermarkConfig | undefined,
  vars: WatermarkVars = {}
): WatermarkView | undefined {
  if (!cfg || cfg.enabled === false || typeof cfg.text !== "string") return undefined;
  const text = expandWatermarkText(cfg.text, vars).trim();
  if (!text) return undefined;
  const view: WatermarkView = {
    text,
    opacity: cfg.opacity ?? WATERMARK_DEFAULTS.opacity,
    size: cfg.size ?? WATERMARK_DEFAULTS.size,
    layout: cfg.layout ?? WATERMARK_DEFAULTS.layout,
    angle: cfg.angle ?? WATERMARK_DEFAULTS.angle
  };
  if (cfg.color !== undefined) view.color = cfg.color;
  return view;
}
