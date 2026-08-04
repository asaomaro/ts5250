<script setup lang="ts">
/**
 * **アプリ系ペインの実体置き場**（`20260802-keep-pane-state-move`）。
 *
 * ペインをグループ（`WorkspaceNode`）に描かせると、**タブを別グループへ移した瞬間に
 * 作り直される**——`v-for` の親が変われば別のコンポーネントだから。書きかけの SQL も
 * IFS の居場所も消える（利用者の指摘）。
 *
 * そこで実体はここ 1 か所に置き、`<Teleport>` でグループ側の**受け皿**
 * （`WorkspaceNode` の `.pane-slot`）へ差し込む。グループが描くのは空の受け皿だけ。
 *
 * - **タブを移す** = 受け皿の場所が変わるだけ。Teleport は DOM を移すが
 *   コンポーネントは作り直さない → 状態がそのまま乗って移る。
 * - **タブを閉じる** = どのグループにも居なくなる → ここから外れて**アンマウント**
 *   （`SqlPane` の結果セット解放など `onUnmounted` の後片付けは従来どおり走る）。
 * - **一度も開いていない** = `openedPanes` に無いので実体を作らない（遅延マウント）。
 *
 * DOM は本当に動くので、`.group[data-group-id] .admin` のような**子孫セレクタも従来どおり
 * 効く**（`App.vue` のペイン移動のフォーカス先探索がこれに依存している）。
 */
import { computed, type Component } from "vue";
import AdminPane from "./AdminPane.vue";
import HostListPane from "./HostListPane.vue";
import ProgramPane from "./ProgramPane.vue";
import SqlPane from "./SqlPane.vue";
import PlanListPane from "./PlanListPane.vue";
import IfsPane from "./IfsPane.vue";
import DtaqPane from "./DtaqPane.vue";
import WatchPane from "./WatchPane.vue";
import ServicesPane from "./ServicesPane.vue";
import TransferPane from "./TransferPane.vue";
import SpoolPane from "./SpoolPane.vue";
import { workspaceStore } from "../stores/workspace.js";
import { systemsStore } from "../stores/systems.js";
import { MSG_SYSTEM_GONE } from "../composables/opMessages.js";
import { openedPanes, paneSlotEls } from "../composables/openedPanes.js";
import { PANE_PREFIXES } from "../paneLabels.js";

const props = defineProps<{
  /** メニュー（ランチャー）を出しているか。出している間はどのペインも見えていない */
  launcher?: boolean;
}>();

/**
 * **タブ ID の接頭辞 → ペイン。**
 *
 * `Record<(typeof PANE_PREFIXES)[number], …>` にしているので、`paneLabels.ts` へ
 * 種類を足してここを忘れると**型エラーになる**（以前 `list:` の追加漏れで
 * タブを閉じる処理が壊れた前例がある。`paneLabels.ts` の注記）。
 *
 * 監視コンソール（`watch:`・push 型）と データ待ち行列（`dtaq:`・pull 型）は別のアプリ。
 * スプール（`spool:`・pull 型）とプリンターセッション（push 型）も別系統。
 */
const APP_PANES: Record<(typeof PANE_PREFIXES)[number], Component> = {
  "admin:": AdminPane,
  "dtaq:": DtaqPane,
  "ifs:": IfsPane,
  "list:": HostListPane,
  "pgm:": ProgramPane,
  "plan:": PlanListPane,
  "sql:": SqlPane,
  "transfer:": TransferPane,
  "spool:": SpoolPane,
  "svc:": ServicesPane,
  "watch:": WatchPane
};
function paneOf(tab: string): Component | undefined {
  const hit = PANE_PREFIXES.find((p) => tab.startsWith(p));
  return hit ? APP_PANES[hit] : undefined;
}

interface Entry {
  tab: string;
  comp: Component;
  /** 差し込み先の**実要素**（まだ描かれていなければ undefined） */
  el: HTMLElement | undefined;
  /** いま見えているか（見えていないペインを裏で働かせないための合図） */
  active: boolean;
  /**
   * **このタブのシステム**（`20260802-tabs-own-system`）。
   *
   * 要求の宛先はここで決まる。**ペインに自分で引かせない**——引き方が 6 か所に散ると、
   * 1 か所の直し忘れがそのまま「画面に出ているシステムと宛先が違う」に直結する。
   *
   * `undefined` になるのは**そのシステムが設定から消えたとき**（と、システムに
   * 紐づかないアプリ画面＝サービス一覧・管理）。
   */
  system: string | undefined;
  /** そのシステムが設定から消えている（銘板を出して操作させない） */
  gone: boolean;
}

/**
 * いま実体を持つべきペイン。
 *
 * 母集合は**「一度でも開いた」かつ「どこかのグループが持っている」**——
 * 閉じたタブは後者から外れるので、ここから落ちて自然にアンマウントされる。
 *
 * **差し込み先はセレクタ文字列ではなく実要素**（`paneSlotEls` の注記を参照）。
 * 文字列だと、木を組み替えて受け皿が作り直されても `to` が同じままで、
 * 外れた古い要素にぶら下がったままになる。
 */
const entries = computed<Entry[]>(() => {
  const out: Entry[] = [];
  for (const tab of openedPanes) {
    const comp = paneOf(tab);
    if (!comp) continue;
    const g = workspaceStore.groupOf(tab);
    if (!g) continue; // 閉じた（どのグループにも居ない）
    const system = workspaceStore.systemOf(tab);
    out.push({
      tab,
      comp,
      el: paneSlotEls.get(tab),
      active: !props.launcher && g.activeTab === tab,
      system,
      // **消えたシステムのタブは黙って別システムへ飛ばさず、止めて理由を出す。**
      // 閉じてしまうと書きかけの内容ごと消えるので、残して操作だけ塞ぐ
      gone: system !== undefined && !systemsStore.systems.some((s) => s.ref === system)
    });
  }
  return out;
});
</script>

<template>
  <!--
    受け皿がまだ無い一瞬は `disabled` でここに残す。**アンマウントしない**のが肝
    ——落とすと状態が消える（それを避けるための仕組みなので本末転倒）。
    このプール自体は見せない。
  -->
  <div class="pane-pool" aria-hidden="true">
    <Teleport v-for="e in entries" :key="e.tab" :to="e.el ?? 'body'" :disabled="!e.el">
      <!--
        **消えたシステムの銘板はここで出す。** ペイン 6 種にそれぞれ書かせると
        文言が 6 か所へ散る。ペイン側は「`system` が無ければ操作させない」だけを守ればよい。
      -->
      <p v-if="e.gone" class="sys-gone" role="alert">{{ MSG_SYSTEM_GONE }}</p>
      <component :is="e.comp" :tab-id="e.tab" :active="e.active" :system="e.gone ? undefined : e.system" />
    </Teleport>
  </div>
</template>

<style scoped>
.pane-pool {
  display: none;
}
/* 銘板は受け皿の中（ペインの上）に出る。プールの `display:none` は継がない */
.sys-gone {
  margin: 0;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--t-red, #c62828);
  background: color-mix(in srgb, currentColor 10%, transparent);
  border-bottom: 1px solid var(--line);
}
</style>
