import { reactive, shallowReactive, type ComponentPublicInstance } from "vue";
import { isPaneTab } from "../paneLabels.js";

/**
 * **一度でもアクティブになったアプリ系タブ**（`20260802-keep-pane-state-move`）。
 *
 * 遅延マウントの記録。ここに入ったタブだけを `PanePool` が実体として持つ。
 *
 * **グループの持ち物にしない。** ペインの実体はグループから切り離して 1 か所
 * （`PanePool`）に置き、`<Teleport>` で受け皿へ差し込む——タブを別グループへ移しても
 * 作り直さないため。記録がグループ側にあると、移した先で「まだ開いていない」扱いになる。
 *
 * **消し込みはしない。** 閉じたタブがここに残っていても実体は作られない
 * （プールの母集合は「どこかのグループが持っているタブ」）。逆に、閉じたタブを
 * 開き直したときは即座に実体ができる——利用者から見れば「開いた」のだから正しい。
 */
export const openedPanes = reactive(new Set<string>());

/** そのタブが見えた（アクティブになった）ことを記録する。アプリ系以外は無視する */
export function markPaneOpened(tab: string | undefined): void {
  if (tab && isPaneTab(tab)) openedPanes.add(tab);
}

/**
 * **受け皿の実要素**（タブ ID → `WorkspaceNode` が描いた `.pane-slot`）。
 *
 * `PanePool` の `<Teleport>` はここを行き先にする。**セレクタ文字列では駄目**——
 * Teleport は `to` が**変わったときだけ**行き先を引き直すので、木を組み替えて
 * 受け皿が作り直されても、id から作った文字列が同じままだと
 * **外れた古い要素にぶら下がったまま**になる（分割で実際に踏んだ）。
 * 要素そのものを渡せば、作り直し＝別のオブジェクト＝`to` の変化になる。
 */
export const paneSlotEls = shallowReactive(new Map<string, HTMLElement>());

/**
 * 受け皿を登録する（`.pane-slot` の `ref`）。**`null`（取り外し）は無視する。**
 *
 * 受け皿が別のグループへ移るとき、新しい方の登録と古い方の取り外しの順序は保証されない。
 * 取り外しで消すと「移した直後に行き先を見失う」が起きうる。閉じたタブは
 * `PanePool` の母集合（どこかのグループが持っている）から落ちるので、古い登録が
 * 残っていても使われない。
 */
export function registerPaneSlot(el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement && el.dataset.tab) paneSlotEls.set(el.dataset.tab, el);
}

/** 記録を捨てる（テストの後片付け用。本番の経路では呼ばない） */
export function resetOpenedPanes(): void {
  openedPanes.clear();
  paneSlotEls.clear();
}
