<script setup lang="ts">
import { computed, ref } from "vue";
import type { GroupNode, TabGroup } from "../stores/workspace.js";
import { systemColorVar } from "../composables/systemColor.js";
import { tabGroupColorVar } from "../composables/tabGroupColor.js";
import { appearance } from "../stores/appearance.js";
import { workspaceStore } from "../stores/workspace.js";
import { sessionsStore } from "../stores/sessions.js";
import { watchesStore } from "../stores/watches.js";
import { systemsStore } from "../stores/systems.js";
import { paneLabelOf, isPaneTab } from "../paneLabels.js";
import { closeSession } from "../session-controller.js";
import { msgCloseTabGroup } from "../composables/opMessages.js";
import SessionInfo from "./SessionInfo.vue";
import TabGroupMenu from "./TabGroupMenu.vue";
import { isFileDrag, TAB_MIME, TAB_GROUP_MIME } from "../dnd.js";

const props = defineProps<{ group: GroupNode }>();
/**
 * 開いているポップオーバー。**セッション情報とタブグループのメニューは同時に開かない**
 * （`20260804-tab-groups`）。別々の変数で持つと両方開いた状態を作れてしまう。
 */
const openPopover = ref<{ kind: "info" | "tabgroup"; id: string } | undefined>();
// 並び替えプレビュー（どのタブの前/後ろに挿入されるか）
const reorder = ref<{ overId: string; after: boolean } | undefined>();
/** 重ねてグループ化する予告（このタブの上に落とすとまとまる） */
const intoTab = ref<string | undefined>();
/** タブを受け入れるタブグループのチップ（畳んだグループへの参加もここで受ける） */
const intoChip = ref<string | undefined>();


/** セッションを持たない（＝接続の概念が無い）タブか。判定は paneLabels に集約している */
const isPane = isPaneTab;
function label(sessionId: string): string {
  // **タブ ID から直接引かない**（`20260802-tabs-own-system`）。
  // ID にシステムが付く（`sql:query@own:a`）ので、完全一致では外れる
  return paneLabelOf(sessionId) ?? sessionsStore.get(sessionId)?.label ?? sessionId.slice(0, 6);
}
function connected(sessionId: string): boolean {
  if (isPane(sessionId)) return true;
  return sessionsStore.get(sessionId)?.connected ?? false;
}

/**
 * 選択中システムに属するタブだけを描画する。
 * **`group.tabs` は変えない**——隠すだけで、切り替えて戻れば元どおり現れる。
 */
const shownTabs = computed(() => new Set(workspaceStore.visibleTabs(props.group)));

/**
 * **タブ帯に並べるもの**（`20260804-tab-groups`）。チップとタブが混ざった一列。
 *
 * チップはそのグループの**最初のメンバーの直前**に入る。走査するのは `visibleTabs` ではなく
 * `group.tabs`——**畳んだグループはメンバーが出ないのでチップだけが残る**必要があり、
 * 隠れたタブの位置を知らないとチップを置く場所が決まらない。
 * 「どのタブを出すか」の判断そのものは `visibleTabs`（ストア側の唯一の規則）に委ねる。
 */
type StripItem = { kind: "chip"; tg: TabGroup } | { kind: "tab"; id: string };
const stripItems = computed<StripItem[]>(() => {
  const visible = shownTabs.value;
  const out: StripItem[] = [];
  const seen = new Set<string>();
  for (const t of props.group.tabs) {
    const tg = workspaceStore.tabGroupOfTab(t);
    if (tg && !seen.has(tg.id)) {
      seen.add(tg.id);
      out.push({ kind: "chip", tg });
    }
    if (visible.has(t)) out.push({ kind: "tab", id: t });
  }
  return out;
});

/** そのタブが属するタブグループ（無ければ undefined） */
const tgOf = (t: string): TabGroup | undefined => workspaceStore.tabGroupOfTab(t);
/** グループ内で最初 / 最後のメンバーか（外側の角だけ丸めるため） */
function tgEdge(t: string): { first: boolean; last: boolean } {
  const tg = tgOf(t);
  if (!tg) return { first: false, last: false };
  const members = props.group.tabs.filter((x) => workspaceStore.tabGroupOf[x] === tg.id);
  return { first: members[0] === t, last: members[members.length - 1] === t };
}
/**
 * 畳んだグループの中のタブがアクティブか。
 *
 * 折りたたみは**アクティブタブに干渉しない**ので、畳んだ中身が出続けることがある
 * （利用者の判断）。タブ帯から消えた中身が出ている理由が読めるよう、チップに印を出す。
 */
function chipActive(tg: TabGroup): boolean {
  const active = props.group.activeTab;
  return !!active && workspaceStore.tabGroupOf[active] === tg.id;
}

/**
 * **システムカラーの帯**（`20260802-tabs-own-system`）。
 * 異なるシステムのタブを並べたときの見分け。文字は着色せず、左端の帯で示す
 * ——タブの文字色は既にアクティブ／非アクティブを表しているため。
 *
 * **タブグループの色と併存する**（`20260804-tab-groups`）。軸が違う（どのシステムか／
 * どの作業か）ので、どちらも同時に要る。帯は左端 3px、グループ色は面（背景と下線）で出す。
 */
const systemOf = (t: string): string | undefined => workspaceStore.systemOf(t);
function tabStyle(t: string): Record<string, string> {
  const ref = systemOf(t);
  const tg = tgOf(t);
  return {
    ...(ref ? { "--tab-sys": systemColorVar(systemsStore.colorOf(ref)) } : {}),
    ...(tg ? { "--tg": tabGroupColorVar(tg.color) } : {})
  };
}

/**
 * **ワークスペース全体で 2 システム以上開いているか。**
 *
 * 判定をペイン単位にすると、**タブを別のペインへ移しただけでラベルが伸び縮みする**。
 * 全体で見れば、動かしても見え方が変わらない。
 */
const manySystems = computed(() => {
  const refs = new Set<string>();
  for (const g of workspaceStore.groups()) {
    for (const t of g.tabs) {
      const ref = workspaceStore.systemOf(t);
      if (ref) refs.add(ref);
    }
  }
  return refs.size >= 2;
});
const showSystemName = (t: string): boolean =>
  // **`外観` の切り替えに従う**（`20260802-appearance-and-view-cascade`）。
  // OFF でも**色帯は残す**——見分けの最後の手段まで消さない
  appearance.value.showTabSystemName && manySystems.value && systemOf(t) !== undefined;


/** タブを選ぶ。ランチャーが開いたままにならないよう閉じる */
function selectTab(id: string): void {
  workspaceStore.setActiveTab(props.group.id, id);
  workspaceStore.showLauncher = false;
}
/**
 * タブのバッジに出す未読数。
 *
 * **セッションタブと pane タブで出どころが違う**——プリンターは
 * `sessionsStore`（1 タブ = 1 接続）だが、監視コンソールは pane タブで
 * セッションを持たないので `watchesStore`（サーバーの写し）から引く。
 * `sessionsStore.get()` は pane タブの id では何も返さないため、
 * ここで分けなければ監視の未読は永久に出ない（research F6）。
 */
function unread(id: string): number {
  if (id.startsWith("watch:")) return watchesStore.totalUnread;
  return sessionsStore.get(id)?.unread ?? 0;
}
/** バッジの説明。種別ごとに何の未読かを言う */
function unreadTitle(id: string): string {
  return id.startsWith("watch:") ? "新着エントリ" : "新着スプール";
}
/**
 * タブを閉じる。**セッションを持たないタブ（管理・一覧）は workspace から外すだけ**——
 * 以前は `list:*` がこの分岐から漏れており、切断処理へ流れていた。
 */
function closeTab(id: string): void {
  if (isPane(id)) workspaceStore.closeSession(id);
  else closeSession(id);
}
// タブエリアが現在ドロップ対象か（末尾追加のハイライト用）
const stripActive = ref(false);

/** このペインが最大化中か */
const maximized = computed(() => workspaceStore.maximizedGroupId === props.group.id);
/**
 * 最大化ボタンを出すか。**分割しているときだけ**——単一ペインは既に全面なので、
 * 押しても何も変わらないボタンを置かない。最大化中は「元に戻す」として出し続ける。
 */
const showMaximize = computed(() => maximized.value || workspaceStore.isSplit());
function toggleMaximize(): void {
  workspaceStore.toggleMaximize(props.group.id);
}

// ---- タブグループの操作（`20260804-tab-groups`） ----

/** チップ本体を押したらメニュー、`∨` を押したら折りたたみ（クリックの行き先を分ける） */
function toggleMenu(tgId: string): void {
  openPopover.value =
    openPopover.value?.kind === "tabgroup" && openPopover.value.id === tgId
      ? undefined
      : { kind: "tabgroup", id: tgId };
}
function toggleCollapsed(tgId: string): void {
  workspaceStore.toggleTabGroupCollapsed(tgId);
}
/**
 * グループ内のタブをすべて閉じる。**枚数を示して確認する**——1 枚の ✕ と違い、
 * まとめて消えるうえ 5250 セッションを含めば切断まで起きる。
 * 閉じ方はタブごとに従来の経路へ流す（種別の分岐を二重に持たない）。
 */
function closeTabGroup(tgId: string): void {
  const tabs = workspaceStore.tabGroupTabs(tgId);
  if (tabs.length === 0) return;
  if (globalThis.confirm && !globalThis.confirm(msgCloseTabGroup(tabs.length))) return;
  openPopover.value = undefined;
  for (const t of tabs) closeTab(t);
}

function onDragStart(ev: DragEvent, sessionId: string): void {
  ev.dataTransfer?.setData(TAB_MIME, sessionId);
  workspaceStore.draggingSession = sessionId;
}
function onDragEnd(): void {
  workspaceStore.draggingSession = undefined;
  clearMarks();
}
/** チップを掴んだらグループごと動かす。**タブの写しとは別の箱に入れる**（dnd.ts の注記） */
function onChipDragStart(ev: DragEvent, tgId: string): void {
  ev.dataTransfer?.setData(TAB_GROUP_MIME, tgId);
  workspaceStore.draggingTabGroup = tgId;
}
function onChipDragEnd(): void {
  workspaceStore.draggingTabGroup = undefined;
  clearMarks();
}
/** ドロップ予告の印をまとめて消す */
function clearMarks(): void {
  reorder.value = undefined;
  intoTab.value = undefined;
  intoChip.value = undefined;
  stripActive.value = false;
}
/**
 * タブの D&D 対象か（自グループ内の並び替え／別グループからの合流。どちらもタブエリアで受ける）。
 * **ファイルのドラッグは対象外**——データ転送ペインが受けるので、ここでは何もしない
 */
function isTabDrag(ev?: DragEvent): boolean {
  if (ev && isFileDrag(ev)) return false;
  return !!workspaceStore.draggingSession;
}
/** タブグループごとのドラッグ中か（チップを掴んでいる） */
function isGroupDrag(ev?: DragEvent): boolean {
  if (ev && isFileDrag(ev)) return false;
  return !!workspaceStore.draggingTabGroup;
}
/** ドラッグ中タブを除いた配列での挿入位置（0〜末尾）を計算して落とす */
function dropAt(toIndex: number): void {
  const dragged = workspaceStore.draggingSession;
  clearMarks();
  workspaceStore.draggingSession = undefined;
  if (!dragged) return;
  workspaceStore.dropTabInto(props.group.id, dragged, toIndex);
}

/**
 * **タブ上のドロップ位置**（`20260804-tab-groups`）。左右の端が並べ替え、真ん中が「重ねる」。
 *
 * 中央帯を**要素幅に比例**させ、前後の比較を**非厳密**にしてあるのが要点。
 * jsdom の矩形は全て 0 なので、絶対 px の帯や厳密比較にすると幅 0 のときに中央へ倒れ、
 * 既存の並べ替えテスト（`clientX:0`＝前 / `clientX:10`＝後ろ）が落ちる。
 * 比例なら幅 0 で中央帯が潰れ、従来の中点判定にそのまま一致する。
 */
const CENTER_EDGE = 0.3;
type TabZone = "before" | "center" | "after";
function zoneOfTab(ev: DragEvent, el: HTMLElement): TabZone {
  const r = el.getBoundingClientRect();
  const rel = ev.clientX - r.left;
  const edge = r.width * CENTER_EDGE;
  if (rel <= edge) return "before";
  if (rel >= r.width - edge) return "after";
  return "center";
}

function onTabDragOver(ev: DragEvent, t: string): void {
  if (!isTabDrag(ev)) return; // グループのドラッグは帯（合流）へ通す
  ev.preventDefault();
  ev.stopPropagation(); // グループ全体（分割ゾーン）へは伝播させない
  const zone = zoneOfTab(ev, ev.currentTarget as HTMLElement);
  const self = t === workspaceStore.draggingSession;
  if (zone === "center" && !self) {
    reorder.value = undefined;
    intoTab.value = t;
  } else {
    intoTab.value = undefined;
    reorder.value = { overId: t, after: zone === "after" };
  }
  stripActive.value = false;
}
function onTabDrop(ev: DragEvent, t: string): void {
  if (!isTabDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const dragged = workspaceStore.draggingSession!;
  const zone = zoneOfTab(ev, ev.currentTarget as HTMLElement);
  if (t === dragged) {
    // 自身へのドロップは無操作
    clearMarks();
    workspaceStore.draggingSession = undefined;
    return;
  }
  if (zone === "center") {
    clearMarks();
    workspaceStore.draggingSession = undefined;
    workspaceStore.groupTabs(props.group.id, t, dragged);
    return;
  }
  // ドラッグ中タブを除いた配列での挿入位置（t の前/後ろ）
  const rest = props.group.tabs.filter((x) => x !== dragged);
  const j = rest.indexOf(t);
  dropAt(j < 0 ? rest.length : zone === "after" ? j + 1 : j);
}

/** チップの上へタブを落としたらそのグループへ参加させる（**畳んだままでも受ける**） */
function onChipDragOver(ev: DragEvent, tgId: string): void {
  if (!isTabDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  reorder.value = undefined;
  intoTab.value = undefined;
  intoChip.value = tgId;
  stripActive.value = false;
}
function onChipDrop(ev: DragEvent, tgId: string): void {
  if (!isTabDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const dragged = workspaceStore.draggingSession!;
  clearMarks();
  workspaceStore.draggingSession = undefined;
  // **末尾のメンバーの隣へ付ける**——チップへの追加は「このグループに足す」であって
  // 割り込みではない。先頭を起点にすると 2 番目に挿し込まれて並びが入れ替わる
  const members = workspaceStore.tabGroupTabs(tgId);
  const anchor = members[members.length - 1];
  // **展開はしない**（畳んだまま参加）。畳んだ状態が勝手に解けないようにする
  if (anchor && anchor !== dragged) workspaceStore.groupTabs(props.group.id, anchor, dragged);
}

/**
 * タブの隙間・末尾の空き領域に落としたら末尾へ追加（合流）。
 *
 * **ここへ来た時点で「タブ耳の上ではない」ことが確定している**——
 * タブ耳の dragover は stopPropagation するため、この関数まで届かない。
 * よって残っている `reorder`（タブ間の挿入位置の目印）は過去のもので、消してよい。
 *
 * 以前は `if (!reorder.value)` で抑制していたため、タブ耳を通ってから空き領域へ移ると
 * 目印が残ったままになり、**帯のドロップ領域が出なくなっていた**。
 *
 * **タブグループごとのドラッグもここで受ける**（`20260804-tab-groups`）——
 * グループの合流は「このペインへ持ってくる」であって挿入位置を持たないので、帯全体で足りる。
 */
function onStripDragOver(ev: DragEvent): void {
  if (isGroupDrag(ev)) {
    ev.preventDefault();
    ev.stopPropagation();
    reorder.value = undefined;
    intoTab.value = undefined;
    intoChip.value = undefined;
    // 既にこのペインに載っているグループなら、移動先が変わらないので目印を出さない
    stripActive.value = workspaceStore.paneOfTabGroup(workspaceStore.draggingTabGroup!)?.id !== props.group.id;
    return;
  }
  if (!isTabDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  reorder.value = undefined;
  intoTab.value = undefined;
  intoChip.value = undefined;
  // 同じグループ内の並べ替えでは合流の目印を出さない——移動先が変わらないので意味がない
  stripActive.value = !props.group.tabs.includes(workspaceStore.draggingSession!);
}
function onStripDrop(ev: DragEvent): void {
  if (isGroupDrag(ev)) {
    ev.preventDefault();
    ev.stopPropagation();
    const tgId = workspaceStore.draggingTabGroup!;
    clearMarks();
    workspaceStore.draggingTabGroup = undefined;
    workspaceStore.moveTabGroupInto(props.group.id, tgId);
    return;
  }
  if (!isTabDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  dropAt(props.group.tabs.filter((x) => x !== workspaceStore.draggingSession).length); // 末尾
}
/**
 * ドラッグがこの帯から出たら、表示中の目印を消す。
 *
 * **`reorder` も消すのが要点**——タブ個別には dragleave が無いため、
 * ドラッグ元のペインでタブ上を通過すると目印が立ちっぱなしになり、
 * 移動先のペインが反応していないように見えていた。
 * 子要素（タブ）へ移っただけの dragleave では消さない（ちらつく）。
 */
function onStripLeave(ev: DragEvent): void {
  const to = ev.relatedTarget as Node | null;
  if (to && (ev.currentTarget as HTMLElement).contains(to)) return;
  clearMarks();
}
</script>

<template>
  <div
    class="tabs"
    :class="{ 'strip-drop': stripActive }"
    @dragover="onStripDragOver"
    @dragleave="onStripLeave"
    @drop="onStripDrop"
  >
    <template v-for="item in stripItems" :key="item.kind === 'chip' ? `tg:${item.tg.id}` : item.id">
      <!-- タブグループのチップ。**タブと同じ行**に置く（帯を高くしないため）。
           本体を押すとメニュー、`∨` を押すと折りたたみ。掴めばグループごと移動する -->
      <div
        v-if="item.kind === 'chip'"
        class="tg-chip"
        :class="{ on: chipActive(item.tg), collapsed: item.tg.collapsed, 'chip-drop': intoChip === item.tg.id }"
        :style="{ '--tg': tabGroupColorVar(item.tg.color) }"
        :data-tab-group="item.tg.id"
        draggable="true"
        :title="item.tg.name || 'タブグループ'"
        @dragstart="onChipDragStart($event, item.tg.id)"
        @dragend="onChipDragEnd"
        @dragover="onChipDragOver($event, item.tg.id)"
        @drop="onChipDrop($event, item.tg.id)"
        @click="toggleMenu(item.tg.id)"
      >
        <span v-if="item.tg.name" class="tg-name">{{ item.tg.name }}</span>
        <button
          class="tg-fold"
          :aria-pressed="item.tg.collapsed"
          :title="item.tg.collapsed ? 'タブグループを展開' : 'タブグループを折りたたむ'"
          @click.stop="toggleCollapsed(item.tg.id)"
        >
          {{ item.tg.collapsed ? "›" : "∨" }}
        </button>
        <TabGroupMenu
          v-if="openPopover?.kind === 'tabgroup' && openPopover.id === item.tg.id"
          :tg="item.tg"
          @close="openPopover = undefined"
          @close-all="closeTabGroup(item.tg.id)"
        />
      </div>

      <div
        v-else
        class="tab"
        :class="{
          on: group.activeTab === item.id,
          off: !connected(item.id),
          'drop-before': reorder?.overId === item.id && !reorder.after,
          'drop-after': reorder?.overId === item.id && reorder.after,
          'drop-into': intoTab === item.id,
          'tg-member': !!tgOf(item.id),
          'tg-first': tgEdge(item.id).first,
          'tg-last': tgEdge(item.id).last
        }"
        draggable="true"
        @dragstart="onDragStart($event, item.id)"
        @dragend="onDragEnd"
        @dragover="onTabDragOver($event, item.id)"
        @drop="onTabDrop($event, item.id)"
        :style="tabStyle(item.id)"
        @click="selectTab(item.id)"
      >
        <span class="dot" :class="{ live: connected(item.id) }"></span>
        <!-- **システム名は 2 つ以上のシステムが開いているときだけ**（`20260802-tabs-own-system`）。
             1 システムしか使っていない人の見た目は変えない。名前側に独自の省略を掛けて、
             長いシステム名がタブ名を押し出さないようにする -->
        <span v-if="showSystemName(item.id)" class="sysname">{{
          systemsStore.nameOf(systemOf(item.id)!)
        }}</span>
        {{ label(item.id) }}
        <span v-if="unread(item.id) > 0" class="badge" :title="unreadTitle(item.id)">{{
          unread(item.id)
        }}</span>
        <button
          v-if="!isPane(item.id)"
          class="info"
          title="セッション情報"
          @click.stop="
            openPopover =
              openPopover?.kind === 'info' && openPopover.id === item.id
                ? undefined
                : { kind: 'info', id: item.id }
          "
        >
          ⓘ
        </button>
        <button class="x" title="閉じる" @click.stop="closeTab(item.id)">✕</button>
        <SessionInfo
          v-if="openPopover?.kind === 'info' && openPopover.id === item.id && !isPane(item.id)"
          :session-id="item.id"
          @close="openPopover = undefined"
        />
      </div>
    </template>
    <button
      v-if="showMaximize"
      class="maximize"
      :aria-pressed="maximized"
      :title="maximized ? 'ペインを元に戻す' : 'ペインを最大化'"
      @click.stop="toggleMaximize"
    >
      {{ maximized ? "🗗" : "🗖" }}
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  /* 上の余白を削って画面に回す（ACS 相当の余白に）。
     高さはヘッダーと同じ変数を見る（`--chrome-row-h`）——揃えるため */
  min-height: var(--chrome-row-h);
  box-sizing: border-box;
  padding: 1px 2px 0;
  flex-wrap: wrap;
  /* タブが少なくても末尾の空き領域へドロップ（合流）できるよう最低幅・高さを確保 */
  min-height: 28px;
  align-content: flex-start;
}
/* 別ペインのタブをこのタブエリアへドロップして合流できることを示すハイライト */
.tabs.strip-drop {
  background: color-mix(in srgb, var(--t-green) 12%, transparent);
  outline: 1px dashed var(--t-green);
  outline-offset: -2px;
  border-radius: 6px;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-family: var(--mono);
  font-size: 12px;
  border: 1px solid var(--crt-line);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: var(--crt);
  color: var(--muted);
  cursor: grab;
}
/* システムカラーの帯（左端）。`--tab-sys` が無いタブ（システムに紐づかない画面）には出さない */
.tab[style*="--tab-sys"]::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: 6px 0 0 0;
  background: var(--tab-sys);
}
.tab[style*="--tab-sys"] {
  padding-left: 11px; /* 帯のぶん本文を寄せる（8px + 3px） */
}
.sysname {
  color: var(--muted);
  /* **名前側だけを縮める**。長いシステム名がタブ名を押し出さないように */
  max-width: 7ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sysname::after {
  content: "｜";
  color: var(--line);
}
.tab.on {
  color: var(--t-green);
}
.tab.off {
  opacity: 0.6;
}
/*
  **タブグループのメンバー**（`20260804-tab-groups`）。
  まとまりは**薄い背景と下線**で示す。`box-shadow` を使うのが要点——
  border / padding / outline はレイアウトを押し広げ、**タブ帯が 1 行ぶん高くなる**
  （高さはヘッダーと共有の `--chrome-row-h`＝28px に収める約束）。
  折り返しても各タブが自分で装飾を持つので、まとまりが途切れて見えない。
*/
/*
  **グループの中は「面」で見せる**（ブラウザのタブグループに寄せる。利用者の指摘）。

  ブラウザのタブは**1 枚ずつ枠で囲まない**——上端の色線と細い仕切りだけで、
  地はひと続きの面になっている。こちらも同じにする: メンバーの枠は透明にし、
  仕切りは**右枠 1 本をグループ色の薄い線**にする（`--crt-line` の濃い枠だと
  1 枚ずつ箱に見えて、まとまりが切れる）。

  **枠は消すのではなく透明にする**のが要点。`border-width` を 0 にすると
  その 1px ぶん背が縮み、グループの内と外でタブの高さが変わってしまう。
*/
.tab.tg-member {
  background: color-mix(in srgb, var(--tg) 10%, var(--crt));
  /* 色の線は上端（ブラウザと同じ向き）。枠を透明にしたので、この影が線そのもの */
  box-shadow: inset 0 3px 0 var(--tg);
  border-color: transparent;
  border-right-color: color-mix(in srgb, var(--tg) 45%, transparent);
  border-radius: 0;
  /*
    **ひと続きに見せる。** 帯の `gap: 2px` を負のマージンで打ち消し、左枠を落として
    「左隣の右枠」だけを仕切りにする。チップ → 先頭タブ → … → 末尾タブが 1 本の塊になる。
    横方向だけの調整なので**タブ帯の高さには触れていない**。
  */
  margin-left: -2px;
  border-left: none;
}
/* **選択中のタブだけ濃く塗る**（ブラウザと同じ）。文字色だけだと面の中で埋もれる */
.tab.tg-member.on {
  background: color-mix(in srgb, var(--tg) 26%, var(--crt));
}
.tab.tg-member.tg-last {
  border-top-right-radius: 6px;
  border-right-color: transparent; /* 末尾の右は仕切りではないので出さない */
}
/* 並び替えの挿入位置インジケータ（ドラッグ中に前/後ろを示す） */
.tab.drop-before::before,
.tab.drop-after::after {
  content: "";
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 2px;
  background: var(--t-green);
  box-shadow: 0 0 4px var(--t-green);
}
.tab.drop-before::before {
  left: -2px;
}
.tab.drop-after::after {
  right: -2px;
}
/* 重ねてグループ化する予告。**枠ではなく内側の影**で出す（高さを変えない） */
.tab.drop-into {
  box-shadow: inset 0 0 0 2px var(--t-green);
  background: color-mix(in srgb, var(--t-green) 14%, var(--crt));
}
/*
  **チップはタブと地続き**（ブラウザのタブグループと同じ。利用者の指摘）。

  以前はチップだけ丸ピル・小さめの高さ・行の中央寄せで、`gap: 2px` を挟んで浮いていたため
  **タブとは別の部品に見えていた**。いまは**タブと同じ箱**（同じ padding・枠・下枠なし）にして、
  左端だけ角を丸め、右は角ばらせて次のタブへ続ける。隙間はメンバー側の負のマージンで潰す。

  **高さは `align-self: stretch` で行に合わせる**のが要点。固定値やフォント寸法から決めると、
  タブ側の文字サイズを変えたときに片方だけ伸びて**段差**になる（＝また別部品に見える）。
  行の高さはタブが決めるので、それに従わせておけばずれようがない。
*/
.tg-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  align-self: stretch;
  gap: 4px;
  padding: 4px 8px;
  /* 枠は透明にして幅だけ残す（0 にするとタブと高さがずれる） */
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 0 0 0;
  /*
    **べた塗りのピル**（ブラウザのタブグループと同じ）。面の左端が「グループの名札」で、
    そこから右へタブが続く。抜き文字は地の色（`--crt`）——パレットは中間調なので、
    暗いテーマでは暗い字、明るいテーマでは明るい字になり、どちらでも読める。
  */
  background: var(--tg);
  color: var(--crt);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  cursor: grab;
  user-select: none;
}
/* 畳むとチップだけが残る＝独立した 1 個なので、両端とも丸める */
.tg-chip.collapsed {
  border-radius: 6px 6px 0 0;
}
/*
  畳んだ中のタブがアクティブなときの印（タブ帯から消えた中身が出ている理由を示す）。
  地はもう塗りつぶしなので、**内側の輪**で示す——色を変えると別のグループに見える。
*/
.tg-chip.on {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--crt) 65%, transparent);
}
.tg-chip.chip-drop {
  box-shadow: inset 0 0 0 2px var(--t-green);
}
.tg-name {
  max-width: 12ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tg-fold {
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 0 1px;
  font-size: 11px;
  line-height: 1;
}
/* 最大化 / 元に戻す。タブの並びとは別物なので右端へ寄せる */
.maximize {
  margin-left: auto;
  align-self: center;
  border: 1px solid var(--crt-line);
  border-radius: 4px;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 1px 6px;
  font-size: 12px;
  line-height: 1.4;
}
.maximize[aria-pressed="true"] {
  color: var(--t-green);
  border-color: var(--t-green);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.live {
  background: var(--t-green);
}
.info,
.x {
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
}
.badge {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent, #3b82f6);
  color: #fff;
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  font-family: var(--mono);
}
</style>
