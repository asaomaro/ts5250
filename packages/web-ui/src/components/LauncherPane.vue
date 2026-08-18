<script setup lang="ts">
/**
 * ランチャー（設計案の画面 1・2）。
 *
 * - システム未選択 … システムのカード一覧だけを出す。**選ぶまで何も実行できない**ので他を見せない
 * - システム選択後 … そのシステムに属するセッションと、機能を並べる
 *
 * セッションを開くのも機能を開くのも「**このシステムに対してタブを 1 枚開く**」同じ操作なので、
 * 上下に分けず同じ場所に並べる。
 */
import { computed, onMounted, ref } from "vue";
import type { PublicSession } from "@ts5250/server";
import { systemsStore } from "../stores/systems.js";
import { workspaceStore } from "../stores/workspace.js";
import SystemDot from "./SystemDot.vue";
import { makePaneTabId } from "../paneLabels.js";
import { authStore } from "../stores/auth.js";
import { openedSession, useOpenConfigured } from "../composables/openConfigured.js";
import ConfigCard from "./ConfigCard.vue";

/** 開く処理は共有（ランチャーとサービス一覧で同じ判断を使う） */
const openConfigured = useOpenConfigured();

/** カード / 一覧の表示切り替え（端末ごとに localStorage で保持。旧 UI から引き継ぐ） */
const VIEW_KEY = "as400.launcherView";
const viewMode = ref<"card" | "list">(
  typeof localStorage !== "undefined" && localStorage.getItem(VIEW_KEY) === "list" ? "list" : "card"
);
function setViewMode(m: "card" | "list"): void {
  viewMode.value = m;
  if (typeof localStorage !== "undefined") localStorage.setItem(VIEW_KEY, m);
}

const addingSystem = ref(false);
const addingSession = ref(false);
/** 接続中の設定 ref と直近の失敗。**共有**——同時に 2 本開かせないため（`openConfigured`） */
const { connecting, error } = openConfigured;

onMounted(() => {
  void systemsStore.refresh();
});

/** このシステムの IBM i を見る機能。ヘッダーではなくここに置く（セッションと同じ「タブを開く」操作だから） */
const FEATURES = [
  { id: "list:jobs", name: "ジョブ", desc: "実行中・待機中のジョブを見る。保留・解放・終了もできる。" },
  { id: "list:objects", name: "オブジェクト", desc: "ライブラリー内のオブジェクトを一覧する。" },
  { id: "sql:query", name: "SQL", desc: "SELECT を実行して結果を見る。CSV でダウンロードできる。" },
  {
    id: "plan:explain",
    name: "実行計画",
    desc: "SQL の実行計画をグラフで見る。索引の助言も出る。一覧は特権が要る。"
  },
  {
    id: "transfer:data",
    name: "データ転送",
    desc: "表を CSV に落とす / CSV を表に取り込む。SQL を書かずに済む。"
  },
  {
    id: "msg:queue",
    name: "メッセージ",
    desc: "待ち行列を読む。**応答待ちの照会に答えられる**。送信もできる。"
  },
  {
    id: "pgm:call",
    name: "プログラム呼び出し",
    desc: "画面を経由せずに RPG / COBOL を呼ぶ。引数は型で書く。"
  },
  {
    id: "pcml:call",
    name: "PCML 呼び出し",
    desc: "コンパイラが吐いた `.pcml` から呼ぶ。**構造体と配列を名前で**扱える。"
  },
  { id: "list:users", name: "ユーザー", desc: "ユーザープロファイルと権限を一覧する。" },
  {
    id: "ifs:files",
    name: "IFS",
    desc: "IFS のフォルダを辿ってファイルを見る / 取り出す / 置く。"
  },
  {
    id: "dtaq:entries",
    name: "データ待ち行列",
    desc: "データ待ち行列にエントリを送受信・ピークする。作成・クリア・削除・属性も。"
  },
  {
    id: "spool:files",
    name: "スプール",
    // desc で push 型と区別する——プリンターセッションのタブと紛らわしいため
    desc: "出力待ち行列にある既存のスプールを検索して、中身を読む / PDF で保存する。"
  }
] as const;

/**
 * このアプリ自身を扱う画面。IBM i のデータではないので機能とは段を分ける。
 * ヘッダーには置かない——「開くとタブが増える」点は機能と同じなので、入口も同じ場所に揃える。
 */
const APP_PANES = computed(() => {
  const out = [
    {
      id: "svc:services",
      name: "サービス",
      // **タブを開かなくても分かる**のがこのペインの値打ちなので、そこを説明に書く
      desc: "サーバーで動き続けるプリンター・待ち行列の一覧。開始・停止もできる。"
    },
    { id: "admin:sessions", name: "セッション管理", desc: "このアプリが開いている接続の一覧。切断もできる。" },
    { id: "admin:logs", name: "ログ", desc: "このアプリの操作記録。" }
  ];
  if (authStore.isAdmin) {
    out.push({ id: "admin:users", name: "ユーザー管理", desc: "このアプリのログインユーザーを管理する。" });
  }
  return out;
});

/**
 * すでにワークスペースで開かれているか（「開く」か「表示」かの出し分け）。
 * **判定は (機能, システム) の組**——A の SQL が開いていても B の SQL は「開く」。
 */
function isOpen(id: string, scoped = true): boolean {
  const tab = tabIdFor(id, scoped);
  return workspaceStore.groups().some((g) => g.tabs.includes(tab));
}

const selected = computed(() => systemsStore.current);

/** システムを選ぶ。選び終えたらメニューへ進む */
function selectSystem(ref: string): void {
  systemsStore.select(ref);
  workspaceStore.showSystemPicker = false;
  workspaceStore.showLauncher = true;
}

/**
 * そのタブ ID（`20260802-tabs-own-system`）。
 *
 * IBM i の機能は**システムごとに別のタブ**になる（`sql:query@own:a`）。
 * このアプリ自身の画面（`scoped: false`。サービス一覧・管理）はシステムに紐づかないので
 * ID をそのまま使う。
 */
function tabIdFor(id: string, scoped: boolean): string {
  const sys = scoped ? systemsStore.menuSystem : undefined;
  return sys ? makePaneTabId(id, sys) : id;
}

/**
 * 機能・管理画面を開く。**すでに開いていれば開き直さず、そこへ移動する**——
 * 「機能選択からアプリへ単純に移動したい」経路を、同じカードで兼ねるため。
 *
 * **開き直しでシステムを付け替えない**（`20260802-tabs-own-system`）。以前は
 * `assignSystem` で既存タブを今のシステムへ付け替えていたが、それは
 * **実行済みの結果が別システムのものに化ける**ということ。いまは (機能, システム) の
 * 組ごとに別のタブなので、付け替える必要そのものが無い。
 */
function openFeature(id: string, scoped = true): void {
  const tab = tabIdFor(id, scoped);
  const existing = workspaceStore.groups().find((g) => g.tabs.includes(tab));
  if (existing) {
    workspaceStore.setActiveTab(existing.id, tab);
    workspaceStore.focus(existing.id);
  } else {
    workspaceStore.addSession(tab, scoped ? systemsStore.menuSystem : undefined);
  }
  workspaceStore.showLauncher = false;
}

/**
 * セッション設定から接続する。**中身は `openConfigured` に出してある**
 * （`20260802-printer-report-history`）——サービス一覧からも同じ操作ができるようになり、
 * 「開いていればタブへ戻す」「装置名の二重掴みを断る」「監視はセッションとして開かない」
 * という判断を 2 か所に持ちたくないため。
 */
const connect = openConfigured.open;
</script>

<template>
  <div class="launcher" :class="'view-' + viewMode">
    <div class="view-toggle" role="group" aria-label="表示切り替え">
      <button :class="{ active: viewMode === 'card' }" title="カード表示" @click="setViewMode('card')">
        ▦ カード
      </button>
      <button :class="{ active: viewMode === 'list' }" title="一覧表示" @click="setViewMode('list')">
        ☰ 一覧
      </button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>

    <!-- システム選択画面。未選択なら常にここ。選択済みでもパンくずから来られる -->
    <template v-if="!systemsStore.menuSystem || workspaceStore.showSystemPicker">
      <p class="sec">システム</p>
      <div class="cards">
        <ConfigCard
          v-for="s in systemsStore.systems"
          :key="s.ref"
          kind="system"
          :system="s"
          :dense="viewMode === 'list'"
          :selected="s.ref === systemsStore.menuSystem"
          @select="selectSystem"
          @done="systemsStore.refresh()"
        />
        <ConfigCard v-if="addingSystem" kind="system" creating @done="addingSystem = false" @cancel="addingSystem = false" />
        <button v-else class="add" @click="addingSystem = true">＋ システムを追加</button>
      </div>
      <p v-if="systemsStore.loaded && systemsStore.systems.length === 0" class="empty">
        システムがまだありません。接続先とユーザーを登録してください。
      </p>
    </template>

    <!-- 選択後: セッションと機能 -->
    <template v-else>
      <!-- **どのシステムのメニューを見ているか**を、タブと同じ色で示す -->
      <p class="sec">
        <SystemDot v-if="systemsStore.menuSystem" :system-ref="systemsStore.menuSystem" />
        のセッション
      </p>
      <div class="cards">
        <ConfigCard
          v-for="s in systemsStore.currentSessions"
          :key="s.ref"
          kind="session"
          :session="s"
          :dense="viewMode === 'list'"
          :connecting="connecting === s.ref"
          :opened="openedSession(s.ref) !== undefined"
          @open="connect($event)"
          @open-new="connect($event, true)"
          @done="systemsStore.refresh()"
        />
        <ConfigCard
          v-if="addingSession"
          kind="session"
          creating
          :parent-system="systemsStore.menuSystem"
          @done="addingSession = false"
          @cancel="addingSession = false"
        />
        <button v-else class="add" @click="addingSession = true">＋ {{ selected?.name }} にセッションを追加</button>
      </div>

      <p class="sec">このシステムの機能</p>
      <div class="cards">
        <div v-for="f in FEATURES" :key="f.id" class="fn">
          <div class="nm">{{ f.name }}</div>
          <div class="desc">{{ f.desc }}</div>
          <div class="foot">
            <button class="btn ghost" @click="openFeature(f.id)">{{ isOpen(f.id) ? "表示" : "開く" }}</button>
          </div>
        </div>
      </div>
      <p class="note">
        機能はセッションを開かなくても使えます。システムを選んだ時点で認証情報が揃っているためです。
      </p>
    </template>

    <!--
      アプリ自身の画面。**システムの選択に依存しない**——扱うのは IBM i のデータではなく
      このアプリだからである。

      以前は「選択後」の段の中にあったが、それだと**サーバー設定のシステムしか無い環境で、
      一般ユーザーがどの画面にも辿り着けない**（サーバー設定は admin にしか見えないので
      選べるシステムが 0 件になる）。サービス一覧を「見るだけは許す」と決めた以上、
      入口が閉じていては意味が無い。
    -->
    <p class="sec">アプリ</p>
    <div class="cards">
      <div v-for="a in APP_PANES" :key="a.id" class="fn app">
        <div class="nm">{{ a.name }}</div>
        <div class="desc">{{ a.desc }}</div>
        <div class="foot">
          <button class="btn ghost" @click="openFeature(a.id, false)">{{ isOpen(a.id, false) ? "表示" : "開く" }}</button>
        </div>
      </div>
    </div>
    <p class="note">これらは IBM i ではなく、このアプリ自身を扱います。</p>
  </div>
</template>

<style scoped>
.launcher {
  padding: 16px 18px;
  overflow: auto;
  height: 100%;
  box-sizing: border-box;
}
.sec {
  font-size: 0.72rem;
  color: var(--muted);
  letter-spacing: 0.04em;
  margin: 0 0 9px;
  display: flex;
  align-items: center;
  gap: 9px;
}
.sec:not(:first-child) {
  margin-top: 22px;
}
.sec::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line);
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 11px;
}

/* 表示切り替え。端末ごとの好みなので localStorage に持つ */
.view-toggle {
  display: inline-flex;
  margin-bottom: 14px;
}
.view-toggle button {
  border-radius: 0;
  font-size: 0.78rem;
  padding: 3px 11px;
}
.view-toggle button:first-child {
  border-radius: 6px 0 0 6px;
}
.view-toggle button:last-child {
  border-radius: 0 6px 6px 0;
  /* 枠線を消すと活性時に左辺が欠ける。重ねて二重線だけを解消する */
  margin-left: -1px;
}
.view-toggle button.active {
  position: relative;
  z-index: 1;
}
.view-toggle button.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

/* 一覧表示: 1 列にして、各カードを横並びのコンパクト行にする（件数が多いとき用） */
.view-list .cards {
  grid-template-columns: 1fr;
  gap: 4px;
}
.view-list .fn,
.view-list .add {
  min-height: 0;
}
.view-list .fn {
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
}
.view-list .fn .desc {
  flex: 1;
}
.view-list .fn .foot {
  margin-top: 0;
  padding-top: 0;
}
.view-list .add {
  padding: 7px 12px;
}
.add {
  border: 1px dashed var(--line);
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 0.82rem;
  min-height: 88px;
  cursor: pointer;
}
.add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.fn {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 12px 13px;
  background: var(--card);
  display: flex;
  flex-direction: column;
}
.fn .nm {
  font-weight: 700;
  font-size: 0.86rem;
  margin-bottom: 3px;
}
.fn .desc {
  font-size: 0.74rem;
  color: var(--muted);
  line-height: 1.5;
}
.fn .foot {
  margin-top: auto;
  padding-top: 10px;
}
/* アプリ自身の画面は、IBM i の機能と視覚的に分ける */
.fn.app {
  border-style: dashed;
}
.btn {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
  padding: 4px 12px;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.btn.ghost {
  background: transparent;
  color: var(--accent);
}
.note,
.empty {
  margin-top: 14px;
  font-size: 0.8rem;
  color: var(--muted);
}
.err {
  color: #c62828;
  font-size: 0.82rem;
  margin: 0 0 10px;
}
</style>
