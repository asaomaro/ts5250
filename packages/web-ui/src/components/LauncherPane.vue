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
import type { PublicSession } from "@as400web/server";
import { systemsStore } from "../stores/systems.js";
import { workspaceStore } from "../stores/workspace.js";
import { authStore } from "../stores/auth.js";
import { openSession, openPrinterSession } from "../session-controller.js";
import ConfigCard from "./ConfigCard.vue";

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
const connecting = ref("");
const error = ref("");

onMounted(() => {
  void systemsStore.refresh();
});

/** このシステムの IBM i を見る機能。ヘッダーではなくここに置く（セッションと同じ「タブを開く」操作だから） */
const FEATURES = [
  { id: "list:jobs", name: "ジョブ", desc: "実行中・待機中のジョブを見る。保留・解放・終了もできる。" },
  { id: "list:objects", name: "オブジェクト", desc: "ライブラリー内のオブジェクトを一覧する。" },
  { id: "sql:query", name: "SQL", desc: "SELECT を実行して結果を見る。CSV でダウンロードできる。" },
  {
    id: "transfer:data",
    name: "データ転送",
    desc: "表を CSV に落とす / CSV を表に取り込む。SQL を書かずに済む。"
  },
  { id: "list:users", name: "ユーザー", desc: "ユーザープロファイルと権限を一覧する。" }
] as const;

/**
 * このアプリ自身を扱う画面。IBM i のデータではないので機能とは段を分ける。
 * ヘッダーには置かない——「開くとタブが増える」点は機能と同じなので、入口も同じ場所に揃える。
 */
const APP_PANES = computed(() => {
  const out = [
    { id: "admin:sessions", name: "セッション管理", desc: "このアプリが開いている接続の一覧。切断もできる。" },
    { id: "admin:logs", name: "ログ", desc: "このアプリの操作記録。" }
  ];
  if (authStore.isAdmin) {
    out.push({ id: "admin:users", name: "ユーザー管理", desc: "このアプリのログインユーザーを管理する。" });
  }
  return out;
});

/** すでにワークスペースで開かれているか（「開く」か「表示」かの出し分け） */
function isOpen(id: string): boolean {
  return workspaceStore.groups().some((g) => g.tabs.includes(id));
}

const selected = computed(() => systemsStore.current);

/** システムを選ぶ。選び終えたらメニューへ進む */
function selectSystem(ref: string): void {
  systemsStore.select(ref);
  workspaceStore.showSystemPicker = false;
  workspaceStore.showLauncher = true;
}

/**
 * 機能・管理画面を開く。**すでに開いていれば開き直さず、そこへ移動する**——
 * 「機能選択からアプリへ単純に移動したい」経路を、同じカードで兼ねるため。
 */
function openFeature(id: string, scoped = true): void {
  const existing = workspaceStore.groups().find((g) => g.tabs.includes(id));
  if (existing) {
    workspaceStore.setActiveTab(existing.id, id);
    workspaceStore.focus(existing.id);
    // IBM i の機能は、いま選択中のシステムのものとして見る
    if (scoped && systemsStore.selected) workspaceStore.assignSystem(id, systemsStore.selected);
  } else {
    workspaceStore.addSession(id, scoped ? systemsStore.selected : undefined);
  }
  workspaceStore.showLauncher = false;
}

/** セッション設定から接続する。**資格情報は送らない**——サーバーが参照から解決する */
async function connect(ref: string): Promise<void> {
  // 二重クリックで同じ装置名のセッションを 2 本開くと、2 本目がホスト側で弾かれる
  if (connecting.value) return;
  const s = systemsStore.currentSessions.find((x) => x.ref === ref);
  if (!s) return;
  connecting.value = s.ref;
  error.value = "";
  try {
    const open = { type: "open" as const, kind: s.sessionType, session: s.ref };
    const meta = {
      host: selected.value?.host ?? "",
      ...(s.deviceName !== undefined ? { deviceName: s.deviceName } : {})
    };
    if (s.sessionType === "printer") {
      await openPrinterSession(open, s.name, meta, s.system);
    } else {
      await openSession(open, s.name, meta, s.system);
    }
    workspaceStore.showLauncher = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    connecting.value = "";
  }
}
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
    <template v-if="!systemsStore.selected || workspaceStore.showSystemPicker">
      <p class="sec">システム</p>
      <div class="cards">
        <ConfigCard
          v-for="s in systemsStore.systems"
          :key="s.ref"
          kind="system"
          :system="s"
          :dense="viewMode === 'list'"
          :selected="s.ref === systemsStore.selected"
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
      <p class="sec">{{ selected?.name }} のセッション</p>
      <div class="cards">
        <ConfigCard
          v-for="s in systemsStore.currentSessions"
          :key="s.ref"
          kind="session"
          :session="s"
          :dense="viewMode === 'list'"
          :connecting="connecting === s.ref"
          @open="connect($event)"
          @done="systemsStore.refresh()"
        />
        <ConfigCard
          v-if="addingSession"
          kind="session"
          creating
          :parent-system="systemsStore.selected"
          @done="addingSession = false"
          @cancel="addingSession = false"
        />
        <button v-else class="add" @click="addingSession = true">＋ セッションを追加</button>
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

      <p class="sec">アプリ</p>
      <div class="cards">
        <div v-for="a in APP_PANES" :key="a.id" class="fn app">
          <div class="nm">{{ a.name }}</div>
          <div class="desc">{{ a.desc }}</div>
          <div class="foot">
            <button class="btn ghost" @click="openFeature(a.id, false)">{{ isOpen(a.id) ? "表示" : "開く" }}</button>
          </div>
        </div>
      </div>
      <p class="note">これらは IBM i ではなく、このアプリ自身を扱います。</p>
    </template>
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
