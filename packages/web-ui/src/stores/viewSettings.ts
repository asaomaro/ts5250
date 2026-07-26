import { reactive } from "vue";
import type { ScreenFontId } from "../composables/screenFonts.js";

/**
 * エミュレーター「画面表示」設定。**単一の設定を保存**（localStorage）し、全画面に適用する。
 * メニューで変えた値はそのまま記憶され、新しい画面・再読み込み後も維持される。
 * 対象: SO/SI 表示・半角カナ表示・リンク化・コントロール表現（画面内入力欄の見せ方）・
 *       配色（端末色⇄意味色）・画面の質感（CRT⇄フラット）・フォント。
 */
/** 入力欄の見せ方（画面設定「入力項目設定」）。すべて桁を動かさない手段だけで作る（spec D8）。 */
export type ControlStyle =
  | "plain" | "underline" | "filled" | "box" | "boxRound" | "inset" | "dashed" | "glow";
/** 配色: literal=5250 の 7 色をそのまま／semantic=役割ベース（通常=前景・値=アクセント・エラー=赤）へ再マップ */
export type ColorMode = "literal" | "semantic";
/** 画面の質感: crt=フォスファのにじみ＋ベゼル枠／flat=グロー無し・やわらかい影のカード */
export type Surface = "crt" | "flat";
/**
 * ボタンの設定（画面設定「ボタン設定」）。機能キー凡例のボタンと拡張5250 の選択肢に効く。
 * **入力欄の設定（controls）とは別軸**（spec D5）。`none`＝無効で凡例をボタン化しない
 * （拡張5250 の選択肢はホストが宣言した操作部品なので、無効でも現状の意匠で機能を保つ）。
 */
export type ButtonStyle =
  | "none" | "underline" | "filled" | "box" | "pill" | "ghost" | "raised" | "link";
export interface ViewSettings {
  sosi: boolean;
  kana: boolean;
  linkify: boolean;
  controls: ControlStyle;
  colorMode: ColorMode;
  surface: Surface;
  /** 機能キー凡例・拡張5250 の選択肢の見せ方 */
  buttons: ButtonStyle;
  /** 画面グリッドのフォント（screenFonts.ts の id）。いずれも和欧 1:2 の一体フォント。 */
  font: ScreenFontId;
}
export type ViewKey = keyof ViewSettings;
type Key = ViewKey;

/**
 * 設定項目の定義（表示順・選択肢）。**画面設定メニューとキー設定で共有する単一の出どころ**。
 * font はここに含めない（選択肢が環境依存で、順送りに向かないため。メニューのセレクトで扱う）。
 */
export interface ViewItemDef {
  key: Exclude<ViewKey, "font">;
  label: string;
  /** 選択肢が多い行は、メニューでラベルを上・セグメントを下段全幅にする */
  wide?: boolean;
  opts: { value: ViewSettings[Key]; label: string }[];
  /** セグメントに出す先頭 N 件。残りは「その他」のパレットから選ぶ（spec D7）。
   *  未指定なら全部セグメントに出す。キー設定の順送りは常に opts 全体を一巡する。 */
  quick?: number;
}
export const VIEW_ITEMS: ViewItemDef[] = [
  { key: "sosi", label: "SO/SI 表示", opts: [{ value: false, label: "非表示" }, { value: true, label: "表示" }] },
  { key: "kana", label: "半角カナ表示", opts: [{ value: true, label: "カナ" }, { value: false, label: "英" }] },
  { key: "linkify", label: "リンク化", opts: [{ value: true, label: "ON" }, { value: false, label: "OFF" }] },
  {
    key: "controls",
    label: "入力項目設定",
    wide: true,
    quick: 3,
    opts: [
      { value: "plain", label: "プレーン" },
      { value: "underline", label: "下線" },
      { value: "filled", label: "塗り" },
      { value: "box", label: "枠" },
      { value: "boxRound", label: "丸枠" },
      { value: "inset", label: "くぼみ" },
      { value: "dashed", label: "破線" },
      { value: "glow", label: "発光" },
    ],
  },
  {
    key: "buttons",
    label: "ボタン設定",
    wide: true,
    quick: 3,
    opts: [
      { value: "none", label: "無効" },
      { value: "underline", label: "下線" },
      { value: "filled", label: "塗り" },
      { value: "box", label: "枠" },
      { value: "pill", label: "ピル" },
      { value: "ghost", label: "ゴースト" },
      { value: "raised", label: "立体" },
      { value: "link", label: "リンク風" },
    ],
  },
  { key: "colorMode", label: "配色", opts: [{ value: "literal", label: "端末色" }, { value: "semantic", label: "意味色" }] },
  { key: "surface", label: "画面の質感", opts: [{ value: "flat", label: "フラット" }, { value: "crt", label: "CRT" }] },
];

/** 項目定義を引く（不明キーは undefined）。 */
export function viewItem(key: string): ViewItemDef | undefined {
  return VIEW_ITEMS.find((i) => i.key === key);
}

// 単層の保存キー（旧二層の as400.view.defaults とは分ける＝新しい初期値をクリーンに適用）。
const STORAGE_KEY = "as400.view.settings";
const FALLBACK: ViewSettings = {
  sosi: false, // 非表示
  kana: false, // 英
  linkify: true,
  controls: "plain",
  colorMode: "literal", // 端末色
  surface: "flat",
  buttons: "none",
  font: "system",
};

const state = reactive({ settings: { ...FALLBACK } as ViewSettings });

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* localStorage 不可でも動作は継続 */
  }
}

/** 保存済みの旧値を現行の値へ読み替える。`rich` は「枠」の意匠そのままなので `box` に対応する
 *  （spec D8「旧値の移行」）。利用者から見た変化は無い。 */
function migrate(v: ViewSettings): ViewSettings {
  const out = { ...v };
  if ((out.controls as string) === "rich") out.controls = "box";
  if ((out.buttons as string) === "rich") out.buttons = "box";
  return out;
}

export const viewSettings = {
  /** 現在の設定（保存済み・全画面共通） */
  get settings(): ViewSettings {
    return state.settings;
  },
  /** 各画面（ペイン）に渡す実効設定。いまは全画面共通なので保存済み設定をそのまま返す。 */
  effective(_sessionId?: string): ViewSettings {
    return state.settings;
  },
  /** 1 項目を変更して即保存（全画面に反映・再読み込み後も維持）。 */
  set<K extends Key>(key: K, value: ViewSettings[K]): void {
    state.settings = { ...state.settings, [key]: value };
    persist();
  },
  /**
   * 項目を次の選択肢へ**順送り**（末尾なら先頭へ戻る）。キー設定からの切替に使う。
   * 通知用に「項目名」と「切り替わった後の値のラベル」を返す（不明キーは undefined）。
   */
  cycle(key: string): { label: string; valueLabel: string } | undefined {
    const item = viewItem(key);
    if (!item) return undefined;
    const cur = state.settings[item.key];
    const i = item.opts.findIndex((o) => o.value === cur);
    const next = item.opts[(i + 1) % item.opts.length]!; // 見つからない(-1)ときは先頭へ
    this.set(item.key, next.value as never);
    return { label: item.label, valueLabel: next.label };
  },
};

/** 起動時に呼ぶ: localStorage から設定を読み込む。 */
export function initViewSettings(): void {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    // 保存値が無ければ**既定へ戻す**（何もしないと前の状態が残る）。起動時は元から既定なので
    // 実挙動は変わらないが、「読み込み or 既定」を保証しておく方が再初期化に強い。
    state.settings = raw ? migrate({ ...FALLBACK, ...(JSON.parse(raw) as Partial<ViewSettings>) }) : { ...FALLBACK };
  } catch {
    /* 壊れていれば既定のまま */
  }
}
