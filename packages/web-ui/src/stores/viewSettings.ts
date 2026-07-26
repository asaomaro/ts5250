import { reactive } from "vue";
import type { ScreenFontId } from "../composables/screenFonts.js";

/**
 * エミュレーター「画面表示」設定。**単一の設定を保存**（localStorage）し、全画面に適用する。
 * メニューで変えた値はそのまま記憶され、新しい画面・再読み込み後も維持される。
 * 対象: SO/SI 表示・半角カナ表示・リンク化・コントロール表現（画面内入力欄の見せ方）・
 *       配色（端末色⇄意味色）・画面の質感（CRT⇄フラット）・フォント。
 */
/** 入力欄(コントロール)の見せ方: plain=5250 準拠（最小）／underline=Material 風下線／
 *  filled=Notion 風の塗り／rich=枠付きボックス＋フォーカスリング */
export type ControlStyle = "plain" | "underline" | "filled" | "rich";
/** 配色: literal=5250 の 7 色をそのまま／semantic=役割ベース（通常=前景・値=アクセント・エラー=赤）へ再マップ */
export type ColorMode = "literal" | "semantic";
/** 画面の質感: crt=フォスファのにじみ＋ベゼル枠／flat=グロー無し・やわらかい影のカード */
export type Surface = "crt" | "flat";
export interface ViewSettings {
  sosi: boolean;
  kana: boolean;
  linkify: boolean;
  controls: ControlStyle;
  colorMode: ColorMode;
  surface: Surface;
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
}
export const VIEW_ITEMS: ViewItemDef[] = [
  { key: "sosi", label: "SO/SI 表示", opts: [{ value: false, label: "非表示" }, { value: true, label: "表示" }] },
  { key: "kana", label: "半角カナ表示", opts: [{ value: true, label: "カナ" }, { value: false, label: "英" }] },
  { key: "linkify", label: "リンク化", opts: [{ value: true, label: "ON" }, { value: false, label: "OFF" }] },
  {
    key: "controls",
    label: "コントロール表現",
    wide: true,
    opts: [
      { value: "plain", label: "プレーン" },
      { value: "underline", label: "下線" },
      { value: "filled", label: "塗り" },
      { value: "rich", label: "枠" },
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
    if (raw) state.settings = { ...FALLBACK, ...(JSON.parse(raw) as Partial<ViewSettings>) };
  } catch {
    /* 壊れていれば既定のまま */
  }
}
