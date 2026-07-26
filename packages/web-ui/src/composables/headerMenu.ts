import { ref } from "vue";

/**
 * ヘッダーのポップオーバー（画面設定・デザイン設定など）は**同時に 1 つだけ**開く。
 * 開いているメニューの id を共有し、別のメニューを開いたら前のは自動で閉じる
 * （各メニューはボタンで @click.stop するため、相手の外側クリック検出には頼れない）。
 */
export const openHeaderMenu = ref<string | null>(null);

/** そのメニューを開閉する（同じ id を再度押したら閉じ、別を押したら切り替え）。 */
export function toggleHeaderMenu(id: string): void {
  openHeaderMenu.value = openHeaderMenu.value === id ? null : id;
}

/** 指定メニューが開いていれば閉じる（外側クリック用）。 */
export function closeHeaderMenu(id: string): void {
  if (openHeaderMenu.value === id) openHeaderMenu.value = null;
}
