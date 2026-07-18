<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useTheme, type ThemeMode } from "./composables/useTheme.js";
import { workspaceStore } from "./stores/workspace.js";
import { sessionsStore } from "./stores/sessions.js";
import { nextPaneInDirection, type PaneDir } from "./composables/paneNav.js";
import ConnectView from "./components/ConnectView.vue";
import WorkspaceNode from "./components/WorkspaceNode.vue";
import LogPanel from "./components/LogPanel.vue";
import KeybindingsPanel from "./components/KeybindingsPanel.vue";
import AccountPopover from "./components/AccountPopover.vue";
import LoginView from "./components/LoginView.vue";
import { authStore } from "./stores/auth.js";

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

// ワークスペースに何かタブがあるか（セッション＋管理タブ）。表示切替の基準
const hasWorkspaceContent = computed(() => workspaceStore.groups().some((g) => g.tabs.length > 0));
const showConnect = ref(true);
/** アカウント（API トークン発行 / ログアウト）ポップオーバー */
const showAccount = ref(false);
/**
 * アクティブ（フォーカス中）ペインのタブが 5250 エミュレーター（表示セッション）か。
 * SO/SI・カナ・リンク・キーの各トグルはエミュレーター専用なので、これが true のときだけ出す。
 * 接続画面表示中・プリンター/管理タブ・空ペインでは false。
 */
const activeIsEmulator = computed(() => {
  if (showConnect.value || !hasWorkspaceContent.value) return false;
  const tab = workspaceStore.focusedGroup().activeTab;
  if (!tab || tab.startsWith("admin:")) return false;
  const s = sessionsStore.get(tab);
  return !!s && s.kind !== "printer";
});
const showKeys = ref(false);

function onConnected(): void {
  showConnect.value = false;
}

/** 管理タブを開く（既にあれば前面に）。管理者のみ */
function openAdmin(id: string): void {
  const existing = workspaceStore.groups().find((g) => g.tabs.includes(id));
  if (existing) {
    workspaceStore.setActiveTab(existing.id, id);
    workspaceStore.focus(existing.id);
  } else {
    workspaceStore.addSession(id);
  }
  showConnect.value = false;
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
  if (!hasWorkspaceContent.value) return;
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
      <button v-if="hasWorkspaceContent" class="link" @click="showConnect = !showConnect">
        {{ showConnect ? "ワークスペースへ" : "＋ 接続" }}
      </button>
      <span v-if="authStore.isAdmin" class="admin-nav">
        <button class="link" @click="openAdmin('admin:users')">ユーザー</button>
        <button class="link" @click="openAdmin('admin:sessions')">セッション</button>
        <button class="link" @click="openAdmin('admin:logs')">ログ</button>
      </span>
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

    <main v-if="showConnect || !hasWorkspaceContent">
      <ConnectView @connected="onConnected" />
    </main>
    <main v-else class="workspace">
      <WorkspaceNode :node="workspaceStore.root" />
    </main>

    <LogPanel />
    </template>
  </div>
</template>

<style scoped>
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
