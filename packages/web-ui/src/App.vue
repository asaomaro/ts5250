<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import DesignMenu from "./components/DesignMenu.vue";
import ViewSettingsMenu from "./components/ViewSettingsMenu.vue";
import MacroMenu from "./components/MacroMenu.vue";
import { workspaceStore } from "./stores/workspace.js";
import { sessionsStore } from "./stores/sessions.js";
import { downloadScreenHtml } from "./screenExport.js";
import { nextPaneInDirection, type PaneDir } from "./composables/paneNav.js";
import LauncherPane from "./components/LauncherPane.vue";
import WorkspaceNode from "./components/WorkspaceNode.vue";
import PanePool from "./components/PanePool.vue";
import SystemDot from "./components/SystemDot.vue";
import KeybindingsPanel from "./components/KeybindingsPanel.vue";
import AccountPopover from "./components/AccountPopover.vue";
import LoginView from "./components/LoginView.vue";
import { authStore } from "./stores/auth.js";
import { systemsStore } from "./stores/systems.js";
import type { ViewSettings } from "./stores/viewSettings.js";
import { isPaneTab } from "./paneLabels.js";

workspaceStore.init();

/**
 * 開いているタブがあるか（ワークスペースへ入れるか）。
 *
 * **`visibleTabs` で数えてはいけない**（`20260804-tab-groups`）。あちらは「タブ帯に
 * **描く**タブ」で、畳んだタブグループのメンバーを外す——**畳んだだけでタブは生きている**のに、
 * 数えると 0 になり「タブが無い」と判断されてしまう。実際に踏んだ:
 * 全部を 1 つのグループへ入れて畳んだら、**ワークスペースから締め出されてメニューへ戻され、
 * ワークスペースのボタンもグレーアウトし、バッジの数も消えた**。
 *
 * 「開いているか」の真実は `tabs`（持ち物）で、`visibleTabs`（見せ方）ではない。
 */
const hasVisibleTabs = computed(() => visibleTabCount.value > 0);
/** 開いているタブの総数（パンくずのバッジ用）。**畳んだグループの中も数える** */
const visibleTabCount = computed(() =>
  workspaceStore.groups().reduce((n, g) => n + g.tabs.length, 0)
);
/** システム未選択なら常にシステム選択画面（そこから先が存在しない） */
const showSystemPicker = computed(() => !systemsStore.menuSystem || workspaceStore.showSystemPicker);
/** ランチャーを出すか。タブが無いか、パンくずから明示的に呼ばれたとき */
const showLauncher = computed(() => workspaceStore.showLauncher || !hasVisibleTabs.value);
/** アカウント（API トークン発行 / ログアウト）ポップオーバー */
const showAccount = ref(false);
/**
 * アクティブ（フォーカス中）ペインのタブが 5250 / 3270 エミュレーター（表示セッション）か。
 * SO/SI・カナ・リンク・キーの各トグルはエミュレーター専用なので、これが true のときだけ出す。
 * 接続画面表示中・プリンター/管理タブ・空ペインでは false。
 *
 * **VT も false。** キーの一覧・HTML 保存・マクロ・表示設定はどれもフィールドモデルと
 * `ScreenSnapshot` の上に建っており、VT には対応するものが無い——**出すと「押しても
 * 何も起きない」で混乱させる**（spec D9）。
 */
const activeIsEmulator = computed(() => {
  if (showLauncher.value) return false;
  const tab = workspaceStore.focusedGroup().activeTab;
  if (!tab || isPaneTab(tab)) return false;
  const s = sessionsStore.get(tab);
  return !!s && s.kind !== "printer" && s.meta?.terminal !== "vt";
});
/** アクティブなエミュレーターセッション id（画面設定メニューの対象。非エミュ時は空） */
const activeSessionId = computed(() => {
  const tab = workspaceStore.focusedGroup().activeTab;
  return tab && !isPaneTab(tab) ? tab : "";
});

/**
 * **`⚙ 表示` を出す対象**（`20260802-view-menu-refine`）。
 *
 * エミュレータに加え、**帳票を読む画面**（プリンターセッション・スプール）でも出す。
 * ただし項目は同じではない——5250 画面専用の設定を並べても効かないので、
 * **そのペインで実際に効くものだけ**を渡す。
 *
 * 帳票の本文は SCS の復号を通った Unicode 文字列として届き、SO/SI は復号時に
 * 消費され、生バイトは端末に来ない。したがって SO/SI 表示・表示コードは
 * **この経路では実装できない**ので出さない（spec の注記を参照）。
 */
const REPORT_VIEW_KEYS: readonly (keyof ViewSettings)[] = ["linkify", "font"];
const viewMenuTarget = computed<
  { sessionId: string; keys?: readonly (keyof ViewSettings)[] } | undefined
>(() => {
  if (showLauncher.value) return undefined;
  const tab = workspaceStore.focusedGroup().activeTab;
  if (!tab) return undefined;
  if (activeIsEmulator.value) return { sessionId: activeSessionId.value };
  // スプールはタブ ID、プリンターはセッション ID を鍵にする（どちらも文字列で衝突しない）
  if (tab.startsWith("spool:")) return { sessionId: tab, keys: REPORT_VIEW_KEYS };
  if (sessionsStore.get(tab)?.kind === "printer") return { sessionId: tab, keys: REPORT_VIEW_KEYS };
  return undefined;
});
const showKeys = ref(false);

/**
 * 今の画面を HTML で保存する。**表示設定（表示コード・SO/SI）を反映して**書き出すので、
 * 見えているとおりの絵になる（`screenExport.ts` の注記を参照）。
 */
function saveScreenHtml(): void {
  if (activeSessionId.value) downloadScreenHtml(activeSessionId.value);
}

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
  // **タブには触らない**（`20260802-tabs-own-system`）。絞り込みをやめたので、
  // システムを選び直しても見えるタブの集合は変わらない——寄せ直す先も無い
  systemsStore.select(ref || undefined);
  workspaceStore.showLauncher = false;
}

/**
 * 現在地。3 つは排他で、パンくストの選択状態と一致する。
 * **システム選択画面へ移っても選択は外さない**——外すと深い段が消え、
 * 覗きに来ただけの利用者が戻れなくなる。
 */
const atSystems = computed(() => showSystemPicker.value);
const atLauncher = computed(() => !atSystems.value && showLauncher.value);

/**
 * **ヘッダーは常に「いま見ているタブ」のシステムを映す**（`20260802-header-follows-tab`）。
 *
 * 以前はメニューを開いた瞬間にだけ合わせていた。そのため**タブを選び替えただけでは
 * ヘッダーが変わらず**、A のタブを見ているのにヘッダーは B、という食い違いが起きていた
 * （利用者の指摘）。異なるシステムのタブを並べられる以上、ヘッダーは
 * 「いまどのシステムを見ているか」を常に正しく出す必要がある。
 *
 * ただし **メニュー（ランチャー）を出している間は動かさない**。開いた後に対象が
 * 入れ替わると、押した先が意図と違うシステムになる（`20260802-tabs-own-system` の判断）。
 * 監視の元を「メニュー中は `undefined`」にすることで、その間の更新を止めている。
 *
 * システムを持たないタブ（サービス一覧・管理）のときは**直前の対象を維持**する。
 */
watch(
  () => (showLauncher.value ? undefined : workspaceStore.systemOf(workspaceStore.focusedGroup().activeTab)),
  (sys) => {
    if (sys) systemsStore.select(sys);
  },
  { immediate: true }
);
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
    // 管理タブはこのアプリ自身の画面。IBM i のシステムには紐づかない
    workspaceStore.addSession(id);
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

/**
 * グループの中の「フォーカスを受ける根要素」へ実フォーカスを移す。
 *
 * **隠れている要素は飛ばす**（`20260802-keep-pane-state`）。開いたタブは切り替えても
 * アンマウントせず `v-show` で隠すようになったので、同じグループに `.admin` を名乗る
 * 要素（`AdminPane` と `SqlPane` の両方が持つ）が**複数居うる**。先頭を無条件に取ると
 * 隠れている方を掴み、`focus()` が黙って何も起きない。
 *
 * 判定は包み紙の `data-hidden` で行う。**算出スタイルは使えない**——`display: none` は
 * 包み紙側に付くので、中の要素の computed display は "none" にならない。
 */
function focusPane(id: string): void {
  const sel = [".pane", ".printer-pane", ".admin"]
    .map((c) => `.group[data-group-id="${id}"] ${c}`)
    .join(", ");
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    if (el.closest("[data-hidden]")) continue;
    el.focus();
    return;
  }
}

function onGlobalKey(ev: KeyboardEvent): void {
  // セッションだけでなく管理タブ（admin:*）でも効かせる。セッション有無で判定すると
  // 管理タブしか開いていないときにショートカットが死ぬ
  if (!hasVisibleTabs.value) return;
  // **Alt+Shift 系**のアプリショートカット（タブ・ペイン移動）。
  //
  // Ctrl+PageUp/Down はブラウザ既定のタブ切替と衝突するため使わない。
  // 素の PageUp/Down はホストの Roll に割当済み。Shift 単独は矩形選択（Shift+矢印）が使用中。
  // Meta（⌘/Win）は Windows の Win+矢印が OS のウィンドウスナップに奪われ届かない。
  //
  // **Alt 単独から Alt+Shift へ移した**のは、`Alt+↓` をオプション欄のドロップダウンに空けるため
  // （コンボボックスの慣用キー）。指の形を変えずに済むので移行が小さい。
  if (!ev.altKey || !ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  // Alt+Shift+PageDown/Up = タブ切替（次/前）
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
  // Alt+Shift+矢印 = ペイン間フォーカス移動（方向対応）。単一ペインでも preventDefault して
  // ブラウザの戻る/進む（Alt+←/→ 相当）で誤ってアプリを離脱するのを防ぐ。
  const dir = ARROW_DIR[ev.key];
  if (dir) {
    ev.preventDefault();
    const id = nextPaneInDirection(paneRects(), workspaceStore.focusedGroupId, dir);
    if (id) {
      workspaceStore.focus(id);
      // 移動先ペインへ実フォーカスを移し、キーボード操作を有効化する。
      // ペインの根要素はエミュレーター/プリンター/管理で class が異なるため全て対象にする
      // （.pane だけだとプリンター・管理ペインへフォーカスが移らない）
      nextTick(() => focusPane(id));
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
      <!--
        **製品名はヘッダーに置かない**（`20260802-message-line`）。
        `5250 Web エミュレーター` は幅を食うだけで何の操作にもならず、狭い画面で
        **ヘッダーを早々に折り返させていた**（利用者の指摘）。ここに置くのは
        「いまどこに繋いでいるか」と操作の入口だけにする。
      -->
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
          <!-- **色は点で出す**（`20260802-tabs-own-system`）。文字は着色しない
               ——テーマをまたいだ文字色のコントラストを保証できないため -->
          <!-- **`:` は置かない**（利用者の指摘）。色の点が区切りの役目を果たしている -->
          <span class="lvl">システム</span>
          <SystemDot v-if="systemsStore.menuSystem" :system-ref="systemsStore.menuSystem" />
          <template v-else>—</template>
        </button>
        <!-- 未選択のときだけ、その先はまだ存在しないので出さない -->
        <template v-if="systemsStore.menuSystem">
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
        <!-- 表示設定（SO/SI・カナ・リンク・コントロール表現ほか）は ⚙ 画面 に集約。
             キー設定からも同じ項目を順送りで切り替えられる。 -->
        <button v-if="activeIsEmulator" class="theme-btn" @click="showKeys = true">⌨ キー</button>
        <!-- 今の画面を自己完結 HTML で保存。**サーバーへ往復しない**（スナップショットは
             既にブラウザ側にある）。表示設定を反映するので、見えているとおりの絵が出る -->
        <button
          v-if="activeIsEmulator"
          class="theme-btn"
          title="今の画面を HTML で保存する（見えているとおり・単体で開ける）"
          @click="saveScreenHtml"
        >
          <!-- 印は JSONL の書き出し（`LogPanel`）と揃える——どちらも
               「ファイルを落とす」操作。`🖹` は文書の印で、操作を表していない -->
          ⬇ HTML
        </button>
        <!-- マクロは 5250 セッション専用（記録も再生も画面操作なので） -->
        <MacroMenu v-if="activeIsEmulator" :session-id="activeSessionId" />
        <ViewSettingsMenu
          v-if="viewMenuTarget"
          :key="viewMenuTarget.sessionId"
          :session-id="viewMenuTarget.sessionId"
          :keys="viewMenuTarget.keys"
        />
        <DesignMenu />
      </div>
      <span v-if="authStore.user" class="whoami">
        <button class="link" title="アカウント（API トークン発行 / ログアウト）" @click="showAccount = true">
          {{ authStore.user.username }}<template v-if="authStore.isAdmin"> (admin)</template>
        </button>
      </span>
    </header>

    <AccountPopover v-if="showAccount" @close="showAccount = false" />
    <KeybindingsPanel v-if="showKeys" @close="showKeys = false" />

    <!--
      **ワークスペースは外さない**（`20260802-keep-pane-state`・利用者の指示）。
      `v-if` でメニューと入れ替えていた頃は、メニューへ寄っただけ／別のシステムを
      選んだだけでタブのペインが丸ごとアンマウントされ、書きかけの SQL も
      IFS の居場所も消えていた。**隠すだけ**にして、開いているタブは閉じるまで生かす。

      `<main>` は 1 つのまま両方を内包する——`display: none` で隠しても
      「文書に main は 1 つ」を崩さないため。見た目の違い（メニューは縦スクロール、
      ワークスペースは固定）はクラスの付け外しで従来どおり切り替える。
    -->
    <main :class="{ workspace: !showLauncher }">
      <LauncherPane v-show="showLauncher" />
      <div v-show="!showLauncher" class="ws-root">
        <!-- **常に木の全体を描く**（`20260802-keep-pane-state-move`）。最大化中だけ
             そのグループを描く形にしていた頃は、木が入れ替わって全ペインが作り直され、
             状態が消えていた。最大化は `WorkspaceNode` の分割段が片側を隠して表す。 -->
        <WorkspaceNode :node="workspaceStore.root" />
      </div>
    </main>
    <!--
      アプリ系ペインの**実体**。受け皿（`WorkspaceNode` の `.pane-slot`）へ Teleport する。
      **`<main>` より後ろに置く**——差し込み先が先に描かれている必要がある。
    -->
    <PanePool :launcher="showLauncher" />

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
  /**
   * **inline-flex で並べる**（利用者の指摘: システム名の高さが他の段より小さく見える）。
   *
   * 素のインライン並びだと、中に入る `SystemDot`（inline-flex）のベースラインが
   * **最初の子＝色の点**から決まる。点には文字が無いので、名前の行box が他の段と
   * 揃わず、1 段だけ低く小さく見えていた。flex にすれば中身が中央で揃う。
   *
   * `gap` は**ラベルと色の点の間**の余白でもある（利用者の指摘: 近すぎる）。
   */
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 2px 9px;
  font: inherit;
  font-size: 0.86rem;
  line-height: 1.5;
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
  /* 余白は `.crumb` の `gap` が持つ（margin と二重に効かせない） */
  display: inline-block;
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
  /* **タブ帯と同じ高さに揃える**（`--chrome-row-h`）。縦の余白は持たせず、
     中身を中央に置く——画面に回せる高さを増やすため */
  height: var(--chrome-row-h);
  box-sizing: border-box;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  flex: none;
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
  /* 絵文字の有無で高さがブレないよう固定高さ＋中央寄せに揃える。
     ヘッダーの行高（`--chrome-row-h`）に収まる大きさにする */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
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
/* ワークスペースの入れ物。`main` の高さをそのまま分割ツリーへ渡す */
.ws-root {
  height: 100%;
}
</style>
