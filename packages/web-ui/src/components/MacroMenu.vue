<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { openHeaderMenu, toggleHeaderMenu, closeHeaderMenu } from "../composables/headerMenu.js";
import { macrosStore, type SecretChoice } from "../stores/macros.js";
import { sessionsStore } from "../stores/sessions.js";
import {
  startRecording,
  pauseRecording,
  resumeRecording,
  stopRecording,
  pendingSecrets,
  isRecording,
  isPlaying,
  type PendingSecret
} from "../macro-record.js";
import { play, pausePlay, resumePlay, stopPlay } from "../macro-engine.js";

/**
 * マクロのポップオーバー（一覧・記録・再生・休止・停止）。
 *
 * ACS の 4 操作（記録 / 再生 / 休止 / 停止）をそのまま出す。**状態は OIA が示す**ので、
 * ここは操作に徹する（spec D10）。ヘッダーのメニューは同時に 1 つだけ開く規約
 * （`headerMenu.ts`）に参加する。
 *
 * **秘密（パスワード）の扱いを聞くのはここ**（spec D5）。記録中に非表示欄へ入力があったら、
 * 保存時に欄ごと「保存する / 毎回入力する / 記録しない」を選ばせる。**値は表示しない**——
 * 表示できてしまうと、画面を覗かれただけで漏れる。
 */
const props = defineProps<{ sessionId: string }>();

const MENU_ID = "macro";
const open = computed(() => openHeaderMenu.value === MENU_ID);

const state = computed(() => sessionsStore.get(props.sessionId));
const mode = computed(() => state.value?.macro?.mode ?? "idle");
// 判定は macro-record の共通ヘルパへ寄せる（同じ条件を 2 か所で書かない）
const recording = computed(() => isRecording(props.sessionId));
const playing = computed(() => isPlaying(props.sessionId));
const paused = computed(() => mode.value === "recordPaused" || mode.value === "playPaused");
const idle = computed(() => !recording.value && !playing.value);
const stepCount = computed(() => state.value?.macro?.steps.length ?? 0);

/** ボタンのラベル。**幅は CSS で固定**し、切り替えで隣がずれないようにする（UI-DESIGN） */
const btnLabel = computed(() => {
  if (recording.value) return "⏺ 記録中";
  if (playing.value) return "▶ 再生中";
  return "⏺ マクロ";
});

const error = ref("");

// ---- 保存ダイアログ ----
const saving = ref(false);
const saveName = ref("");
const secrets = ref<PendingSecret[]>([]);
const choices = ref<Record<string, SecretChoice>>({});

function onToggle(): void {
  toggleHeaderMenu(MENU_ID);
  if (!macrosStore.loaded) void macrosStore.refresh();
}

function onStartRecording(): void {
  error.value = "";
  startRecording(props.sessionId);
}

/** 記録停止 → 秘密の扱いを聞く画面へ。ステップが無ければそのまま破棄する */
function onStopRecording(): void {
  if (stepCount.value === 0) {
    void stopRecording(props.sessionId, false);
    return;
  }
  secrets.value = pendingSecrets(props.sessionId);
  // 鍵が無い環境では「保存する」を選ばせない（保存が 400 で落ちて記録を失う）
  const fallback: SecretChoice = macrosStore.canStoreSecrets ? "store" : "prompt";
  choices.value = Object.fromEntries(secrets.value.map((s) => [s.key, fallback]));
  saveName.value = "";
  saving.value = true;
}

async function onSave(): Promise<void> {
  error.value = "";
  try {
    await stopRecording(props.sessionId, true, saveName.value.trim(), choices.value);
    saving.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    saving.value = false; // 記録は既に閉じられている（macro-record が先に状態を戻す）
  }
}

function onDiscard(): void {
  void stopRecording(props.sessionId, false);
  saving.value = false;
}

function onPauseResume(): void {
  if (mode.value === "recording") pauseRecording(props.sessionId);
  else if (mode.value === "recordPaused") resumeRecording(props.sessionId);
  else if (mode.value === "playing") pausePlay(props.sessionId);
  else if (mode.value === "playPaused") resumePlay(props.sessionId);
}

function onStop(): void {
  if (recording.value) onStopRecording();
  else stopPlay(props.sessionId);
}

function onPlay(id: string, incomplete?: boolean): void {
  error.value = "";
  // 記録できない操作を含むマクロは**途中で止まるのが分かっている**。黙って走らせない（spec D8）
  if (incomplete === true && !confirm("このマクロには記録できなかった操作が含まれます。再生しますか？")) return;
  play(props.sessionId, id);
  closeHeaderMenu(MENU_ID);
}

async function onRename(id: string, current: string): Promise<void> {
  const next = prompt("新しい名前", current);
  if (next === null || next.trim() === "" || next === current) return;
  try {
    await macrosStore.rename(id, next.trim());
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function onRemove(id: string, name: string): Promise<void> {
  if (!confirm(`「${name}」を削除します。保存した秘密も一緒に消えます。`)) return;
  try {
    await macrosStore.remove(id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest?.(".mcm")) closeHeaderMenu(MENU_ID);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeHeaderMenu(MENU_ID);
}

// 閉じたら保存ダイアログも畳む（次に開いたとき途中の状態で出てこないように）
watch(open, (v) => {
  if (!v) {
    saving.value = false;
    error.value = "";
  }
});

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  if (!macrosStore.loaded) void macrosStore.refresh();
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="mcm">
    <button
      class="mcm-btn"
      :class="{ on: open, rec: recording, play: playing }"
      title="マクロ（画面操作の記録・再生）"
      :aria-expanded="open"
      @click.stop="onToggle"
    >
      <span class="mcm-lbl">{{ btnLabel }}</span>
    </button>

    <div v-if="open" class="mcm-menu" role="menu" @click.stop @mousedown.stop>
      <div class="mcm-head">マクロ</div>

      <p v-if="error" class="mcm-err" role="alert">{{ error }}</p>

      <!-- 保存ダイアログ（記録停止時）。秘密は**位置だけ**出し、値は決して出さない -->
      <template v-if="saving">
        <label class="mcm-field">
          <span>名前</span>
          <input v-model="saveName" type="text" maxlength="120" placeholder="サインオン" />
        </label>

        <template v-if="secrets.length > 0">
          <div class="mcm-sub">パスワード欄の扱い</div>
          <div v-for="s in secrets" :key="s.key" class="mcm-secret">
            <span class="mcm-pos">ステップ {{ s.step + 1 }} / {{ s.row }}行 {{ s.col }}桁</span>
            <select v-model="choices[s.key]">
              <option v-if="macrosStore.canStoreSecrets" value="store">保存する（自動で入力）</option>
              <option value="prompt">毎回入力する（そこで休止）</option>
              <option value="skip">記録しない</option>
            </select>
          </div>
          <p class="mcm-note">
            保存した値はサーバーで暗号化され、再生時だけ使われます。画面には二度と表示されません。
          </p>
        </template>

        <div class="mcm-actions">
          <button class="mcm-act primary" :disabled="saveName.trim() === ''" @click="onSave">保存</button>
          <button class="mcm-act" @click="onDiscard">破棄</button>
        </div>
      </template>

      <template v-else>
        <!-- 記録・再生のコントロール（ACS の 4 操作） -->
        <div class="mcm-actions">
          <button v-if="idle" class="mcm-act" @click="onStartRecording">⏺ 記録</button>
          <template v-else>
            <button class="mcm-act" @click="onPauseResume">{{ paused ? "▶ 再開" : "⏸ 休止" }}</button>
            <button class="mcm-act" @click="onStop">⏹ 停止</button>
          </template>
        </div>
        <p v-if="recording" class="mcm-note">
          {{ stepCount }} ステップ記録しました{{ paused ? "（休止中は記録されません）" : "" }}
        </p>

        <div class="mcm-sub">保存済み</div>
        <p v-if="macrosStore.macros.length === 0" class="mcm-note">まだありません</p>
        <div v-for="m in macrosStore.macros" :key="m.id" class="mcm-item">
          <button
            class="mcm-name"
            :disabled="!idle"
            :title="idle ? '再生する' : '記録・再生中は実行できません'"
            @click="onPlay(m.id, m.incomplete)"
          >
            <span class="mcm-flag" :title="m.hasSecret ? 'パスワードを保存しています' : ''">
              {{ m.hasSecret ? "🔑" : "　" }}
            </span>
            {{ m.name }}
            <span class="mcm-steps">{{ m.steps.length }}</span>
          </button>
          <button class="mcm-mini" title="名前を変える" @click="onRename(m.id, m.name)">✎</button>
          <button class="mcm-mini" title="削除する" @click="onRemove(m.id, m.name)">✕</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mcm {
  position: relative;
  display: inline-flex;
}
/* トップバーの意匠（UI-DESIGN「ボタン意匠」）。固定高 28px + inline-flex 中央寄せ */
.mcm-btn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1;
  padding: 0 12px;
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.mcm-btn:hover,
.mcm-btn.on {
  color: var(--accent);
  border-color: var(--accent);
}
.mcm-btn.rec {
  color: var(--t-red, #e05252);
  border-color: var(--t-red, #e05252);
}
.mcm-btn.play {
  color: var(--t-green);
  border-color: var(--t-green);
}
/* ラベルは「⏺ マクロ」「⏺ 記録中」「▶ 再生中」で入れ替わる。**幅を固定**して
   隣のボタン（⚙ 画面・デザイン）が動かないようにする（UI-DESIGN の鉄則） */
.mcm-lbl {
  display: inline-block;
  width: 5.2em;
  text-align: left;
}
.mcm-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 90;
  width: 290px;
  padding: 8px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 16px 44px -14px rgba(0, 0, 0, 0.45);
  font-family: var(--sans);
}
.mcm-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  padding: 2px 4px 8px;
}
.mcm-sub {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  padding: 8px 4px 4px;
  border-top: 1px solid var(--line);
  margin-top: 6px;
}
.mcm-note {
  font-size: 11px;
  color: var(--muted);
  margin: 4px;
  line-height: 1.5;
}
.mcm-err {
  font-size: 11px;
  color: var(--t-red, #e05252);
  margin: 4px;
}
.mcm-actions {
  display: flex;
  gap: 6px;
  padding: 4px;
}
.mcm-act {
  flex: 1;
  height: 28px;
  font: inherit;
  font-size: 12px;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
  cursor: pointer;
}
.mcm-act:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.mcm-act:disabled {
  color: var(--muted);
  cursor: default;
}
.mcm-act.primary {
  color: var(--accent);
  border-color: var(--accent);
}
.mcm-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  font-size: 12px;
}
.mcm-field input {
  flex: 1;
  min-width: 0;
  height: 26px;
  font: inherit;
  padding: 0 6px;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.mcm-secret {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  font-size: 11px;
}
.mcm-pos {
  color: var(--muted);
  white-space: nowrap;
}
.mcm-secret select {
  flex: 1;
  min-width: 0;
  height: 24px;
  font: inherit;
  font-size: 11px;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 6px;
}
.mcm-item {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 1px 4px;
}
.mcm-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  background: none;
  color: var(--ink);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 0 6px;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.mcm-name:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.mcm-name:disabled {
  color: var(--muted);
  cursor: default;
}
/* 鍵の有無で幅が変わらないよう、無い側は全角空白を置く（行がガタつかない） */
.mcm-flag {
  display: inline-block;
  width: 1.2em;
}
.mcm-steps {
  margin-left: auto;
  font-size: 10px;
  color: var(--muted);
}
.mcm-mini {
  width: 24px;
  height: 24px;
  font: inherit;
  font-size: 11px;
  background: none;
  color: var(--muted);
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.mcm-mini:hover {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
