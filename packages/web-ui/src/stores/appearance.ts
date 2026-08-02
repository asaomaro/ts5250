import { reactive } from "vue";

/**
 * **アプリ全体の外観設定**（`20260802-appearance-and-view-cascade`）。
 *
 * `viewSettings` とは別に置く——あちらは**ペインの中の見え方**（そのうえ 2 段の
 * カスケード）で、こちらは**クロームの見え方**。同じ箱に入れると、
 * 「この項目はセッションごとに変えられるのか」が箱から判断できなくなる。
 *
 * 置き場所は `外観` メニュー。保存は `localStorage`。
 */
const STORAGE_KEY = "as400.appearance";

export interface Appearance {
  /**
   * **タブにシステム名を出す**（既定 ON）。
   *
   * ON の意味は「**ワークスペース全体で 2 システム以上開いているときだけ出す**」
   * （`20260802-tabs-own-system`）——1 システムしか使わない人の見た目は変えない。
   * OFF なら常に出さない。
   *
   * **OFF にしても色帯は残す。** 見分けの最後の手段まで消さないため。
   */
  showTabSystemName: boolean;
}

const FALLBACK: Appearance = { showTabSystemName: true };

const state = reactive({ value: { ...FALLBACK } as Appearance });

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));
  } catch {
    /* localStorage 不可でも動作は継続 */
  }
}

export const appearance = {
  get value(): Appearance {
    return state.value;
  },
  set<K extends keyof Appearance>(key: K, v: Appearance[K]): void {
    state.value = { ...state.value, [key]: v };
    persist();
  }
};

/** 起動時に呼ぶ: localStorage から読み込む */
export function initAppearance(): void {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    state.value = raw ? { ...FALLBACK, ...(JSON.parse(raw) as Partial<Appearance>) } : { ...FALLBACK };
  } catch {
    /* 壊れていれば既定のまま */
  }
}
