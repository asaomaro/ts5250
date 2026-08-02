<script setup lang="ts">
import { ref, computed, watch } from "vue";
import EmulatorPane from "./EmulatorPane.vue";
import PrinterPane from "./PrinterPane.vue";
import PaneTabs from "./PaneTabs.vue";
import { workspaceStore, type WsNode, type SplitNode, type GroupNode, type DropZone } from "../stores/workspace.js";
import { sessionsStore } from "../stores/sessions.js";
import { isPaneTab } from "../paneLabels.js";
import { openedPanes, markPaneOpened, registerPaneSlot } from "../composables/openedPanes.js";
import { isFileDrag } from "../dnd.js";

const props = defineProps<{ node: WsNode }>();

const isSplit = computed(() => props.node.type === "split");
const split = computed(() => props.node as SplitNode);
const group = computed(() => props.node as GroupNode);

// ---- ディバイダのリサイズ（Pointer Events） ----
const container = ref<HTMLElement>();
function onDividerDown(ev: PointerEvent): void {
  ev.preventDefault();
  const el = container.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const horiz = split.value.dir === "row";
  const move = (e: PointerEvent): void => {
    const ratio = horiz ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    workspaceStore.setRatio((n) => n === split.value, ratio);
  };
  const up = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- タブ D&D のドロップ（端 4 ゾーン＝分割のみ。中央合流は廃止しタブエリアで受ける） ----
type SplitZone = Exclude<DropZone, "center">;
const dropZone = ref<SplitZone | undefined>();
/** 端 4 ゾーンのみ返す。中央は分割対象外（合流はタブエリア＝PaneTabs が担当）→ undefined */
function zoneFrom(ev: DragEvent, el: HTMLElement): SplitZone | undefined {
  // **ファイルのドラッグは分割の対象外**。データ転送ペインが CSV を受けるため、
  // ここで拾うとファイルを落とすたびにペインが割れる（タブは "text/session" を使う）
  if (isFileDrag(ev)) return undefined;
  // 最大化中は分割させない（入れ子を作らない）。タブエリアへの合流だけ受け付ける
  if (workspaceStore.maximizedGroupId !== undefined) return undefined;
  const r = el.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width;
  const y = (ev.clientY - r.top) / r.height;
  if (x < 0.25) return "left";
  if (x > 0.75) return "right";
  if (y < 0.25) return "top";
  if (y > 0.75) return "bottom";
  return undefined; // 中央はドロップ不可
}
function onDragOver(ev: DragEvent): void {
  const zone = zoneFrom(ev, ev.currentTarget as HTMLElement);
  dropZone.value = zone;
  // 有効な端ゾーンのときだけドロップを許可（中央は no-drop カーソルにする）
  if (zone) ev.preventDefault();
}
function onDrop(ev: DragEvent): void {
  const zone = dropZone.value;
  dropZone.value = undefined;
  if (!zone) return; // 中央ドロップは無効
  ev.preventDefault();
  const sessionId = ev.dataTransfer?.getData("text/session");
  if (!sessionId) return;
  workspaceStore.split(group.value.id, zone, sessionId);
}

const focused = computed(() => workspaceStore.focusedGroupId === group.value.id);
/** アクティブタブがプリンターセッションかどうか（ペイン内容の出し分け） */
const activeIsPrinter = computed(
  () => !!group.value.activeTab && sessionsStore.get(group.value.activeTab)?.kind === "printer"
);

/**
 * **開いたタブは閉じるまで生かす**（`20260802-keep-pane-state`）。
 *
 * アクティブなタブのペインだけを描いていた頃は、切り替えるたびにアンマウントされ、
 * **コンポーネントのローカル状態が丸ごと消えていた**（SQL の入力・IFS の居場所・
 * 一覧の絞り込み……。利用者の指摘）。5250 だけ無事に見えたのは、状態が
 * `sessionsStore` にあったから。
 *
 * **実体はここに無い**（`20260802-keep-pane-state-move`）。ここが描くのは**受け皿**だけで、
 * 中身は `PanePool` が `<Teleport>` で差し込む——グループに描かせると
 * **タブを別グループへ移した瞬間に作り直される**ため。
 *
 * - **遅延マウント**: 一度も開いていないタブは受け皿を作らない（`openedPanes`）。
 * - **後片付けはタブの開閉と一致**: 閉じれば `group.tabs` から消え、プールからも落ちて
 *   `onUnmounted`（SQL の結果セット解放など）が走る。**`<KeepAlive>` では
 *   閉じたタブのインスタンスがキャッシュに残り、ここが守れない。**
 */
watch(() => group.value.activeTab, markPaneOpened, { immediate: true });
/** 受け皿を出すアプリ系タブ。閉じた／移した分は `group.tabs` から消えて自然に落ちる */
const liveTabs = computed(() => group.value.tabs.filter((t) => openedPanes.has(t) && isPaneTab(t)));
/** アクティブタブがアプリ系か（5250／プリンターの分岐に使う） */
const activeIsApp = computed(() => isPaneTab(group.value.activeTab));

/**
 * **最大化は木を差し替えず、片側を隠して表す**（`20260802-keep-pane-state-move`）。
 *
 * 以前は `App` が `workspaceStore.displayRoot()`（最大化中はそのグループだけ）を描いていた。
 * 描く木が丸ごと入れ替わるので、**最大化した側も含めて全ペインが作り直され**、
 * 状態が消えていた（利用者の指摘）。
 *
 * いまは常に `root` を描き、この分割段が「最大化したグループを**含まない側**」を隠す。
 * 比率（`split.ratio`）は書き換えないので、解除すれば元の形に戻る。
 */
function containsGroup(n: WsNode, id: string): boolean {
  return n.type === "group" ? n.id === id : containsGroup(n.a, id) || containsGroup(n.b, id);
}
const maximizedIn = computed<{ a: boolean; b: boolean }>(() => {
  const id = workspaceStore.maximizedGroupId;
  if (id === undefined || props.node.type !== "split") return { a: false, b: false };
  return { a: containsGroup(split.value.a, id), b: containsGroup(split.value.b, id) };
});
/** ちょうど片側だけが最大化のグループを含む＝この段で 1 枚に畳む。
 *  どちらにも無い（木が食い違っている）ときは畳まない＝従来どおり両方出す */
const soloed = computed(() => maximizedIn.value.a !== maximizedIn.value.b);
const showA = computed(() => !soloed.value || maximizedIn.value.a);
const showB = computed(() => !soloed.value || maximizedIn.value.b);
/** 1 枚に畳んでいる側は全面。畳んでいなければ従来どおり比率どおり */
const basisA = computed(() => (soloed.value ? "100%" : split.value.ratio * 100 + "%"));
const basisB = computed(() => (soloed.value ? "100%" : (1 - split.value.ratio) * 100 + "%"));
</script>

<template>
  <div v-if="isSplit" ref="container" class="split" :class="split.dir">
    <!-- 最大化中は「そのグループを含まない側」と仕切りを隠す。木も比率も書き換えないので
         解除すれば元の形に戻る（実体を作り直さないため。keep-pane-state-move） -->
    <div v-show="showA" class="split-child" :style="{ flexBasis: basisA }">
      <WorkspaceNode :node="split.a" />
    </div>
    <div v-show="!soloed" class="divider" :class="split.dir" @pointerdown="onDividerDown">
      <span class="grip"><i></i><i></i><i></i></span>
    </div>
    <div v-show="showB" class="split-child" :style="{ flexBasis: basisB }">
      <WorkspaceNode :node="split.b" />
    </div>
  </div>

  <div
    v-else
    class="group"
    :data-group-id="group.id"
    :data-focused="focused"
    @mousedown="workspaceStore.focus(group.id)"
    @dragover="onDragOver"
    @dragleave="dropZone = undefined"
    @drop="onDrop"
  >
    <PaneTabs :group="group" />
    <div class="group-body">
      <!--
        アプリ系ペインの**受け皿**。中身は `PanePool` が `<Teleport>` で差し込む
        （実体をグループに描かせるとタブ移動で作り直される）。

        `ref` で**実要素**を登録するのが肝——Teleport は `to` が変わったときだけ
        行き先を引き直すので、セレクタ文字列にすると木を組み替えて受け皿が作り直されても
        同じ文字列のままで、**外れた古い要素にぶら下がったまま**になる。

        包み紙として `div` を挟むのは、`v-show` がコンポーネントのルート要素に効くため
        ——ルートが複数あるペインでも確実に隠れるようにする。
      -->
      <div
        v-for="t in liveTabs"
        :ref="registerPaneSlot"
        v-show="t === group.activeTab"
        :key="t"
        class="pane-slot"
        :data-pane-slot="`${group.id}/${t}`"
        :data-tab="t"
        :data-hidden="t === group.activeTab ? undefined : 'true'"
      ></div>
      <!--
        5250 とプリンターは**従来どおりアクティブな 1 つだけ**を描く。状態は
        `sessionsStore` にあるので再マウントで復元でき、`ScreenGrid` は 1 画面の DOM が
        大きい——見えていない画面まで snapshot 更新のたびに描き直す意味がない。
      -->
      <PrinterPane
        v-if="group.activeTab && !activeIsApp && activeIsPrinter"
        :session-id="group.activeTab"
        :focused="focused"
        @focus="workspaceStore.focus(group.id)"
      />
      <EmulatorPane
        v-else-if="group.activeTab && !activeIsApp"
        :session-id="group.activeTab"
        :focused="focused"
        @focus="workspaceStore.focus(group.id)"
      />
      <div v-if="!group.activeTab" class="group-empty">セッションなし</div>
      <div v-if="dropZone" class="dz" :data-zone="dropZone"></div>
    </div>
  </div>
</template>

<style scoped>
.split {
  display: flex;
  height: 100%;
  width: 100%;
}
.split.row {
  flex-direction: row;
}
.split.col {
  flex-direction: column;
}
.split-child {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.divider {
  flex: none;
  display: grid;
  place-items: center;
  background: var(--crt-bezel);
  user-select: none;
}
/* つまみ（3 点）は CSS で描画し向きを確実に制御する（フォントのグリフ依存を避ける）。
   縦バー（row 分割）は点を縦並び、横バー（col 分割）は点を横並びにする。 */
.divider .grip {
  display: flex;
  gap: 3px;
}
.divider.row .grip {
  flex-direction: column;
}
.divider.col .grip {
  flex-direction: row;
}
.divider .grip i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--muted);
}
.divider.row {
  width: 10px;
  cursor: col-resize;
}
.divider.col {
  height: 10px;
  cursor: row-resize;
}
.group {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* **画面を大きく取る**（利用者の指摘: ACS 相当の余白に）。
     ペインの枠線が仕切りになるので、外側の余白は要らない */
  padding: 0;
  position: relative;
}
.group[data-focused="true"] {
  background: color-mix(in srgb, var(--t-green) 6%, transparent);
}
.group-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
/* 隠れているタブの包み紙。高さの連鎖（.group → .group-body → ペイン）を切らない */
.pane-slot {
  height: 100%;
  min-height: 0;
}
.group-empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--muted);
}
.dz {
  position: absolute;
  background: color-mix(in srgb, var(--t-green) 22%, transparent);
  border: 1px solid var(--t-green);
  pointer-events: none;
}
.dz[data-zone="top"] { top: 0; left: 0; right: 0; height: 40%; }
.dz[data-zone="bottom"] { bottom: 0; left: 0; right: 0; height: 40%; }
.dz[data-zone="left"] { left: 0; top: 0; bottom: 0; width: 40%; }
.dz[data-zone="right"] { right: 0; top: 0; bottom: 0; width: 40%; }
</style>
