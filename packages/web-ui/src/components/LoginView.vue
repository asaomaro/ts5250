<script setup lang="ts">
import { ref } from "vue";
import { authStore } from "../stores/auth.js";

const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit(): Promise<void> {
  error.value = "";
  busy.value = true;
  try {
    const ok = await authStore.login(username.value, password.value);
    if (!ok) error.value = "ユーザー名またはパスワードが違います";
    else password.value = "";
  } catch {
    error.value = "ログインに失敗しました";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form class="card" @submit.prevent="submit">
      <h2>サインイン</h2>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <input v-model="username" placeholder="ユーザー名" autocomplete="username" required />
      <input v-model="password" type="password" placeholder="パスワード" autocomplete="current-password" required />
      <button type="submit" :disabled="busy">{{ busy ? "…" : "ログイン" }}</button>
    </form>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 60vh;
  padding: 24px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 320px;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
}
h2 {
  margin: 0 0 4px;
  font-family: var(--mono);
}
.card input {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--ink);
}
.card button {
  padding: 8px 12px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
.err {
  margin: 0;
  color: #c62828;
  font-size: 13px;
}
</style>
