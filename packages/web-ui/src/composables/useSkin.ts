import { ref } from "vue";

/**
 * 画面スキン（見た目テーマ）の状態管理。**グリッド配置・DOM は変えず**、CSS トークン
 * （クローム＋端末パレット）を `data-skin` で差し替えるだけ。useTheme（data-theme）とは独立で、
 * - 5250 端末（t5250）… data-skin を外し、既定トークン＝useTheme の表示モードに従う
 * - Web アプリ風スキン … data-skin を付け、そのスキンのトークンで固定（表示モードに依存しない）
 * （コントロール表現＝画面内入力欄の見せ方は「画面設定」= viewSettings 側で per-pane 管理。）
 */
export type Skin =
  | "t5250" | "notion" | "slack" | "linear" | "stripe" | "github"
  | "vercel" | "discord" | "material" | "figma" | "apple";

export interface SkinMeta {
  id: Skin;
  name: string;
  tag: string;
  swatch: string;
  group: "term" | "web";
}

/** メニュー表示順・スウォッチ色 */
export const SKIN_META: readonly SkinMeta[] = [
  { id: "t5250", name: "5250 端末", tag: "クラシック", swatch: "#178a48", group: "term" },
  { id: "notion", name: "Notion", tag: "ミニマル文書", swatch: "#37352f", group: "web" },
  { id: "slack", name: "Slack", tag: "オーバジン", swatch: "#4a154b", group: "web" },
  { id: "linear", name: "Linear", tag: "ダーク", swatch: "#5e6ad2", group: "web" },
  { id: "stripe", name: "Stripe", tag: "グラデ", swatch: "#635bff", group: "web" },
  { id: "github", name: "GitHub", tag: "Primer", swatch: "#1f2328", group: "web" },
  { id: "vercel", name: "Vercel", tag: "モノクロ", swatch: "#000000", group: "web" },
  { id: "discord", name: "Discord", tag: "ブラープル", swatch: "#5865f2", group: "web" },
  { id: "material", name: "Material", tag: "M3 トーナル", swatch: "#6750a4", group: "web" },
  { id: "figma", name: "Figma", tag: "多色", swatch: "conic-gradient(from 210deg,#f24e1e,#ff7262,#a259ff,#1abcfe,#0acf83,#f24e1e)", group: "web" },
  { id: "apple", name: "Apple", tag: "macOS", swatch: "#007aff", group: "web" },
];

const SKIN_KEY = "as400.skin";
const SKIN_IDS = SKIN_META.map((s) => s.id) as string[];

const skin = ref<Skin>("t5250");

function applySkin(s: Skin): void {
  if (typeof document === "undefined") return;
  const r = document.documentElement;
  if (s === "t5250") r.removeAttribute("data-skin");
  else r.setAttribute("data-skin", s);
}

/** 起動時に呼ぶ: localStorage の選択を読み、data-skin を適用する */
export function initSkin(): void {
  const s = typeof localStorage !== "undefined" ? localStorage.getItem(SKIN_KEY) : null;
  skin.value = s && SKIN_IDS.includes(s) ? (s as Skin) : "t5250";
  applySkin(skin.value);
}

export function useSkin() {
  function setSkin(s: Skin): void {
    skin.value = s;
    if (typeof localStorage !== "undefined") localStorage.setItem(SKIN_KEY, s);
    applySkin(s);
  }
  return { skin, setSkin };
}
