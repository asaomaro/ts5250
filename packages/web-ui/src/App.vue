<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useTheme, type ThemeMode } from "./composables/useTheme.js";
import { workspaceStore } from "./stores/workspace.js";
import { sessionsStore } from "./stores/sessions.js";
import { nextPaneInDirection, type PaneDir } from "./composables/paneNav.js";
import LauncherPane from "./components/LauncherPane.vue";
import WorkspaceNode from "./components/WorkspaceNode.vue";
import KeybindingsPanel from "./components/KeybindingsPanel.vue";
import AccountPopover from "./components/AccountPopover.vue";
import LoginView from "./components/LoginView.vue";
import { authStore } from "./stores/auth.js";
import { systemsStore } from "./stores/systems.js";

const { mode, setMode } = useTheme();
/** ライト → ダーク → システム（OS 設定に追従）の 3 循環 */
const THEME_CYCLE: ThemeMode[] = ["light", "dark", "system"];
function cycleTheme(): void {
  setMode(THEME_CYCLE[(THEME_CYCLE.indexOf(mode.value) + 1) % THEME_CYCLE.length]!);
}
const themeLabel = computed(() =>
  mode.value === "light" ? "☀ ライト" : mode.value === "dark" ? "🌙 ダーク" : "🖥 システム"
);
workspaceStore.init();

/**
 * いま選択中システムに属する、見えるタブがあるか。
 * **フィルタ後で判定する**——別システムのタブが残っていても、いまのシステムに何も無ければ
 * ランチャーを出すのが正しい。
 */
const hasVisibleTabs = computed(() => visibleTabCount.value > 0);
/** 選択中システムで開いているタブの総数（パンくずのバッジ用） */
const visibleTabCount = computed(() =>
  workspaceStore
    .groups()
    .reduce((n, g) => n + workspaceStore.visibleTabs(g, systemsStore.selected).length, 0)
);
/** システム未選択なら常にシステム選択画面（そこから先が存在しない） */
const showSystemPicker = computed(() => !systemsStore.selected || workspaceStore.showSystemPicker);
/** ランチャーを出すか。タブが無いか、パンくずから明示的に呼ばれたとき */
const showLauncher = computed(() => workspaceStore.showLauncher || !hasVisibleTabs.value);
/** アカウント（API トークン発行 / ログアウト）ポップオーバー */
const showAccount = ref(false);
/**
 * アクティブ（フォーカス中）ペインのタブが 5250 エミュレーター（表示セッション）か。
 * SO/SI・カナ・リンク・キーの各トグルはエミュレーター専用なので、これが true のときだけ出す。
 * 接続画面表示中・プリンター/管理タブ・空ペインでは false。
 */
const activeIsEmulator = computed(() => {
  if (showLauncher.value) return false;
  const tab = workspaceStore.focusedGroup().activeTab;
  if (!tab || tab.startsWith("admin:") || tab.startsWith("list:")) return false;
  const s = sessionsStore.get(tab);
  return !!s && s.kind !== "printer";
});
const showKeys = ref(false);

/** そのシステムで現在つながっているセッション数（セレクタの表示用） */
function liveCount(systemRef: string): number {
  return Object.entries(workspaceStore.tabSystem).filter(
    ([tab, ref]) => ref === systemRef && sessionsStore.get(tab)?.connected === true
  ).length;
}

/**
 * システムを切り替える。**タブは閉じない**——他システムのタブは生きたまま隠れ、戻せば現れる。
 * セレクタは絞り込みであって破棄ではない（移動しただけで 5250 の状態が失われるのは代償が大きすぎる）。
 */
function onSelectSystem(ref: string): void {
  systemsStore.select(ref || undefined);
  workspaceStore.showLauncher = false;
  // 切り替え先で見えるタブがあれば、最後に見ていたものへ寄せる
  for (const g of workspaceStore.groups()) {
    const next = workspaceStore.activeTabFor(g, systemsStore.selected);
    if (next !== undefined) g.activeTab = next;
  }
}

/**
 * 現在地。3 つは排他で、パンくストの選択状態と一致する。
 * **システム選択画面へ移っても選択は外さない**——外すと深い段が消え、
 * 覗きに来ただけの利用者が戻れなくなる。
 */
const atSystems = computed(() => showSystemPicker.value);
const atLauncher = computed(() => !atSystems.value && showLauncher.value);
const atWorkspace = computed(() => !atSystems.value && !showLauncher.value);

/** システム選択画面へ。選択は保ったまま、一覧を見せるだけ */
function gotoSystems(): void {
  workspaceStore.showSystemPicker = true;
  workspaceStore.showLauncher = true;
}

/** メニュー（ランチャー）へ */
function gotoLauncher(): void {
  workspaceStore.showSystemPicker = false;
  workspaceStore.showLauncher = true;
}

/** ワークスペースへ。開いているタブが無いときは押せない */
function gotoWorkspace(): void {
  if (!hasVisibleTabs.value) return;
  workspaceStore.showSystemPicker = false;
  workspaceStore.showLauncher = false;
}

/** 管理タブを開く（既にあれば前面に）。管理者のみ */
function openAdmin(id: string): void {
  const existing = workspaceStore.groups().find((g) => g.tabs.includes(id));
  if (existing) {
    workspaceStore.setActiveTab(existing.id, id);
    workspaceStore.focus(existing.id);
  } else {
    workspaceStore.addSession(id, systemsStore.selected);
  }
  workspaceStore.showLauncher = false;
}

// 狭幅フォールバック（分割無効化）
function checkNarrow(): void {
  workspaceStore.narrow = window.innerWidth < 720;
}

// ---- アプリ全体のキーショートカット（タブ・ペイン移動） ----
const ARROW_DIR: Record<string, PaneDir> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down"
};

/** 各ペイン（分割グループ）の画面矩形を集める（空間ナビ用） */
function paneRects() {
  return Array.from(document.querySelectorAll<HTMLElement>(".group[data-group-id]")).map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.groupId!, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

function onGlobalKey(ev: KeyboardEvent): void {
  // セッションだけでなく管理タブ（admin:*）でも効かせる。セッション有無で判定すると
  // 管理タブしか開いていないときにショートカットが死ぬ
  if (!hasVisibleTabs.value) return;
  // Alt 系のアプリショートカット（タブ・ペイン移動）。Ctrl+PageUp/Down はブラウザ既定の
  // タブ切替と衝突するため使わない。素の PageUp/Down はホストの Roll に割当済み。
  if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  // Alt+PageDown/Up = タブ切替（次/前）
  if (ev.key === "PageDown") {
    ev.preventDefault();
    workspaceStore.cycleTab(1);
    return;
  }
  if (ev.key === "PageUp") {
    ev.preventDefault();
    workspaceStore.cycleTab(-1);
    return;
  }
  // Alt+矢印 = ペイン間フォーカス移動（方向対応）。単一ペインでも preventDefault して
  // ブラウザの戻る/進む（Alt+←/→）で誤ってアプリを離脱するのを防ぐ。
  const dir = ARROW_DIR[ev.key];
  if (dir) {
    ev.preventDefault();
    const id = nextPaneInDirection(paneRects(), workspaceStore.focusedGroupId, dir);
    if (id) {
      workspaceStore.focus(id);
      // 移動先ペインへ実フォーカスを移し、キーボード操作を有効化する。
      // ペインの根要素はエミュレーター/プリンター/管理で class が異なるため全て対象にする
      // （.pane だけだとプリンター・管理ペインへフォーカスが移らない）
      nextTick(() =>
        document
          .querySelector<HTMLElement>(
            `.group[data-group-id="${id}"] .pane, ` +
              `.group[data-group-id="${id}"] .printer-pane, ` +
              `.group[data-group-id="${id}"] .admin`
          )
          ?.focus()
      );
    }
  }
}

onMounted(() => {
  void authStore.refresh();
  checkNarrow();
  window.addEventListener("resize", checkNarrow);
  window.addEventListener("keydown", onGlobalKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", checkNarrow);
  window.removeEventListener("keydown", onGlobalKey);
});
</script>

<template>
  <div class="app-shell">
    <LoginView v-if="authStore.loaded && authStore.needsLogin" />
    <template v-else>
    <header class="topbar">
      <span class="brand">5250 Web エミュレーター</span>
      <!--
        ヘッダーに置くのは「いまどのシステムに繋いでいるか」と、このアプリ自身の管理だけ。
        IBM i の機能はランチャー（本体）に並ぶ——セッションを開くのと同じ「タブを開く」操作なので、
        上下に分けない。
      -->
      <!--
        パンくず: システム: <名前> › メニュー › ワークスペース
        第 1 段は「階層の名前 + 選んだ値」。前半が不変なので、押しても項目名が
        変わったように見えない（値だけが — になる）。
        **選択が残っているかぎり深い段は消さない**——覗きに来ただけなら押して戻れる。
      -->
      <nav class="crumbs" aria-label="現在地">
        <button class="crumb" :class="{ on: atSystems }" :disabled="atSystems" @click="gotoSystems">
          <span class="lvl">システム:</span> {{ systemsStore.current?.name ?? "—" }}
        </button>
        <!-- 未選択のときだけ、その先はまだ存在しないので出さない -->
        <template v-if="systemsStore.selected">
          <span class="sep">›</span>
          <button class="crumb" :class="{ on: atLauncher }" :disabled="atLauncher" @click="gotoLauncher">
            メニュー
          </button>
          <span class="sep">›</span>
          <!-- タブが 1 つも無ければ行き先が無いので不活性にする -->
          <button
            class="crumb"
            :class="{ on: atWorkspace }"
            :disabled="atWorkspace || !hasVisibleTabs"
            :title="hasVisibleTabs ? '' : '開いているタブがありません'"
            @click="gotoWorkspace"
          >
            ワークスペース
            <span v-if="visibleTabCount > 0" class="tabbadge">{{ visibleTabCount }}</span>
          </button>
        </template>
      </nav>
      <div class="toggles">
        <button
          v-if="activeIsEmulator"
          class="theme-btn"
          :aria-pressed="workspaceStore.showShiftMarks"
          @click="workspaceStore.showShiftMarks = !workspaceStore.showShiftMarks"
        >
          SO/SI <span class="tv sosi">{{ workspaceStore.showShiftMarks ? "{ }" : "␣" }}</span>
        </button>
        <button
          v-if="activeIsEmulator"
          class="theme-btn"
          :aria-pressed="workspaceStore.katakanaView"
          title="半角カナ表示切替（英小文字位置をカナ解釈）"
          @click="workspaceStore.katakanaView = !workspaceStore.katakanaView"
        >
          <span class="tv kana">{{ workspaceStore.katakanaView ? "カナ" : "英" }}</span>
        </button>
        <button
          v-if="activeIsEmulator"
          class="theme-btn"
          :aria-pressed="workspaceStore.linkify"
          title="URL/メールのリンク化切替"
          @click="workspaceStore.linkify = !workspaceStore.linkify"
        >
          🔗 <span class="tv onoff">{{ workspaceStore.linkify ? "ON" : "OFF" }}</span>
        </button>
        <button v-if="activeIsEmulator" class="theme-btn" @click="showKeys = true">⌨ キー</button>
        <button class="theme-btn" title="テーマ切替（ライト / ダーク / システム）" @click="cycleTheme">
          <span class="tv theme">{{ themeLabel }}</span>
        </button>
      </div>
      <span v-if="authStore.user" class="whoami">
        <button class="link" title="アカウント（API トークン発行 / ログアウト）" @click="showAccount = true">
          {{ authStore.user.username }}<template v-if="authStore.isAdmin"> (admin)</template>
        </button>
      </span>
    </header>

    <AccountPopover v-if="showAccount" @close="showAccount = false" />
    <KeybindingsPanel v-if="showKeys" @close="showKeys = false" />

    <main v-if="showLauncher">
      <LauncherPane />
    </main>
    <main v-else class="workspace">
      <WorkspaceNode :node="workspaceStore.root" />
    </main>

    </template>
  </div>
</template>

<style scoped>
/* パンくず。移動の起点をここに集約したので、ヘッダーで最も目立つ要素にする */
.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex-wrap: wrap;
}
.crumb {
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 2px 9px;
  font: inherit;
  font-size: 0.86rem;
  color: var(--muted);
  cursor: pointer;
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb:hover {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: transparent;
}
/* 現在地。押しても動かないので、押せる見た目にしない */
.crumb.on {
  color: var(--ink);
  font-weight: 700;
  cursor: default;
}
.crumb.on:hover {
  background: none;
  color: var(--ink);
}
/* 階層の名前。値と分けることで、押しても項目名が変わったように見えない */
.crumb .lvl {
  color: var(--muted);
  font-weight: 400;
  font-size: 0.78rem;
}
.crumb.on .lvl {
  color: var(--muted);
}
/* 開いているタブ数。行き先に何があるかを押す前に知らせる */
.tabbadge {
  display: inline-block;
  margin-left: 6px;
  min-width: 1.5em;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.crumb.on .tabbadge {
  background: var(--accent);
  color: var(--paper);
}
.crumbs .sep {
  color: var(--line);
  font-size: 0.9rem;
  user-select: none;
}

.admin-nav {
  display: inline-flex;
  gap: 4px;
  padding-left: 8px;
  border-left: 1px solid var(--line);
}
.whoami {
  font-size: 12px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.brand {
  font-family: var(--mono);
  font-weight: 600;
}
.link {
  font-family: var(--mono);
  font-size: 12px;
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
}
/* トグルボタンは右側に 1 グループとしてまとめる（個別の margin-left:auto をやめてバラけないようにする） */
.toggles {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.theme-btn {
  /* 絵文字の有無で高さがブレないよう固定高さ＋中央寄せに揃える（28px） */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
  cursor: pointer;
  white-space: nowrap;
}
/* トグルで変化する部分は固定幅を確保し、切替時にボタン幅が変わらない（＝他ボタンが動かない）ようにする */
.tv {
  display: inline-block;
  text-align: left;
}
.tv.sosi {
  width: 1.8em;
}
.tv.kana {
  width: 2.2em;
  text-align: center;
}
.tv.onoff {
  width: 2.4em;
}
.tv.theme {
  width: 5.6em;
}
main {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
main.workspace {
  overflow: hidden;
}
</style>
