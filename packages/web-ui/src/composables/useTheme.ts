import { ref } from "vue";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "as400.theme";
const mode = ref<ThemeMode>("system");

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function effective(m: ThemeMode): "light" | "dark" {
  if (m === "system") return systemPrefersDark() ? "dark" : "light";
  return m;
}

/**
 * **アプリ全体で効いている表示モード**（`20260802-appearance-and-view-cascade`）。
 *
 * `mode` は `system` を取りうるので、そのままでは「いま何色か」が分からない。
 * セッションごとの設定が「既定に従う（ダーク）」と**実値を併記**するのにこれを使う
 * ——併記が無いと、確かめるのに `外観` を開き直すことになる。
 */
const resolved = ref<"light" | "dark">("light");

function apply(m: ThemeMode): void {
  resolved.value = effective(m);
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved.value);
}

/** アプリ全体の実効表示モード（`system` を解決済み） */
export function appTheme(): "light" | "dark" {
  return resolved.value;
}

/** 起動時に呼ぶ: localStorage の選択を読み、data-theme を適用し、system 変更に追従する */
export function initTheme(): void {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  mode.value = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  apply(mode.value);
  if (typeof window !== "undefined") {
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (mode.value === "system") apply("system");
    });
  }
}

export function useTheme() {
  function setMode(m: ThemeMode): void {
    mode.value = m;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, m);
    apply(m);
  }
  /** 通常 ⇄ ダークのトグル（system のときは現在の実効テーマの反対へ） */
  function toggle(): void {
    setMode(effective(mode.value) === "dark" ? "light" : "dark");
  }
  return { mode, effective: () => effective(mode.value), setMode, toggle };
}
