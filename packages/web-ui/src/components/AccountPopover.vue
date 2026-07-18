<script setup lang="ts">
import { ref } from "vue";
import { authStore } from "../stores/auth.js";

/**
 * アカウント（ヘッダーのユーザー名から開く）。API トークンの発行とログアウト。
 *
 * トークンは**ユーザーの資格情報**であり接続設定に紐づかない（1 本でそのユーザーができること全部に
 * アクセスできる）。だから接続の編集画面ではなくここに置く——編集画面に置くと「この接続用のトークン」
 * と誤解され、接続を編集しに来ただけの人が既存トークンを失効させる事故も起きる。
 */
defineEmits<{ (e: "close"): void }>();

/** 発行直後だけ保持する平文。閉じると二度と表示できない（サーバーもハッシュしか持たない） */
const issued = ref("");
const busy = ref(false);
const error = ref("");
const copied = ref(false);

async function issue(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    const res = await fetch("/api/me/token", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
    issued.value = body.token;
    authStore.hasToken = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(issued.value);
    copied.value = true;
  } catch {
    /* クリップボード不可環境では無視 */
  }
}
</script>

<template>
  <div class="backdrop" @click="$emit('close')">
    <div class="account" role="dialog" aria-label="アカウント" @click.stop>
      <div class="head">
        <b>{{ authStore.user?.username }}</b>
        <span class="role">{{ authStore.isAdmin ? "管理者" : "一般ユーザー" }}</span>
      </div>

      <section class="token">
        <div class="title">
          API トークン<small>（MCP / 自動化用）</small>
        </div>
        <p class="state">状態: {{ authStore.hasToken ? "発行済み" : "未発行" }}</p>
        <!-- 失効の警告は発行「前」に出す。押した後では設定済みクライアントが既に止まっている -->
        <p class="warn">⚠ 発行すると、以前のトークンは使えなくなります（1 ユーザー 1 本）。</p>
        <button class="ghost" :disabled="busy" @click="issue">
          {{ busy ? "発行中…" : authStore.hasToken ? "再発行する" : "発行する" }}
        </button>

        <div v-if="issued" class="issued">
          <p class="once">この画面を閉じると二度と表示できません。今すぐコピーしてください。</p>
          <code class="value">{{ issued }}</code>
          <button class="ghost" @click="copy">{{ copied ? "コピーしました" : "コピー" }}</button>
          <p class="hint">
            MCP クライアントの設定に <code>Authorization: Bearer &lt;token&gt;</code> として設定します。
          </p>
        </div>
        <p v-if="error" class="err" role="alert">{{ error }}</p>
      </section>

      <div class="foot">
        <button class="ghost" @click="authStore.logout()">ログアウト</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  z-index: 50;
}
.account {
  margin: 40px 12px 0 0;
  width: min(420px, calc(100vw - 24px));
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}
.role {
  color: var(--muted);
  font-size: 12px;
}
.title {
  font-weight: 600;
}
.title small {
  color: var(--muted);
  font-weight: 400;
}
.state,
.warn,
.hint,
.once {
  margin: 4px 0;
  font-size: 12px;
}
.state {
  color: var(--muted);
}
.warn {
  color: var(--t-amber, #b8860b);
}
.issued {
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed var(--border);
  border-radius: 6px;
}
.once {
  color: var(--t-amber, #b8860b);
}
.value {
  display: block;
  word-break: break-all;
  font-size: 12px;
  margin: 6px 0;
}
.hint {
  color: var(--muted);
}
.err {
  color: var(--t-red, #c00);
  font-size: 12px;
}
.foot {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
</style>
