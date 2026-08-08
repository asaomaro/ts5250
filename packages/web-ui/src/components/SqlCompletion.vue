<script setup lang="ts">
/**
 * 補完の候補一覧（SQL 欄の `.` で出る。列 or 表）。
 *
 * **入力欄そのものは `textarea` のまま**。候補は入力欄に重ねた別の箱で、
 * キーの取り回しは親（`SqlPane`）が持つ——`textarea` からフォーカスを移すと
 * 変換中の文字が確定してしまうので、**ここは絶対にフォーカスを取らない**
 * （選ぶのは親のキー操作か、マウスの `mousedown` を止めてのクリック）。
 */
import { nextTick, ref, watch } from "vue";
import { scrollToShow } from "../keepVisible.js";
import type { Candidate, CandidateKind } from "../sqlColumns.js";

const props = defineProps<{
  items: readonly Candidate[];
  /** 出しているものの種類（読み上げの見出しに使う） */
  kind: CandidateKind;
  /** 選択中の位置（親がキーで動かす） */
  index: number;
  /** 入力欄の左上を原点とした表示位置 */
  left: number;
  top: number;
}>();

const emit = defineEmits<{ pick: [item: Candidate] }>();

/**
 * 選んでいる項目を見える位置に保つ。
 *
 * 一覧は 220px で頭打ちにしてスクロールするので、**↑↓ で枠の外へ出ると
 * どれを選んでいるか分からなくなる**（利用者の指摘）。
 * `scrollIntoView` は祖先まで動かしてページごとスクロールしうるので、
 * ここだけを自分で動かす。計算は純関数（`keepVisible.ts`）。
 */
const list = ref<HTMLUListElement | undefined>();

watch(
  // 候補が入れ替わったときも見直す（選択が 0 に戻るので先頭へ）
  () => [props.index, props.items] as const,
  async () => {
    await nextTick();
    const ul = list.value;
    const li = ul?.children[props.index];
    if (!ul || !(li instanceof HTMLElement)) return;
    ul.scrollTop = scrollToShow(
      { scrollTop: ul.scrollTop, height: ul.clientHeight },
      { top: li.offsetTop, height: li.offsetHeight }
    );
  },
  { immediate: true }
);
</script>

<template>
  <ul
    ref="list"
    class="sqlc"
    role="listbox"
    :aria-label="props.kind === 'table' ? '表の候補' : '列の候補'"
    :style="{ left: `${props.left}px`, top: `${props.top}px` }"
  >
    <li
      v-for="(c, i) in props.items"
      :key="c.name"
      class="sqlc-item"
      :class="{ on: i === props.index }"
      role="option"
      :aria-selected="i === props.index"
      :title="c.text ?? c.name"
      @mousedown.prevent="emit('pick', c)"
    >
      <span class="sqlc-name">{{ c.name }}</span>
      <span v-if="c.type" class="sqlc-type">{{ c.type }}</span>
      <span v-if="c.text" class="sqlc-text">{{ c.text }}</span>
    </li>
  </ul>
</template>

<style scoped>
.sqlc {
  position: absolute;
  z-index: 30;
  margin: 0;
  padding: 2px;
  list-style: none;
  min-width: 220px;
  max-width: 420px;
  max-height: 220px;
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--accent);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgb(0 0 0 / 25%);
}
.sqlc-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.sqlc-item:hover {
  background: var(--accent-soft);
}
.sqlc-item.on {
  background: var(--accent-soft);
  outline: 1px solid var(--accent);
}
.sqlc-name {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--ink);
}
.sqlc-type {
  font-size: 11px;
  color: var(--muted);
}
/* 説明は伸びるので、はみ出したら切る（`title` で全文が読める） */
.sqlc-text {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
