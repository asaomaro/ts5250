<script setup lang="ts">
/**
 * **システムの印**（`20260802-tabs-own-system`）。色の点＋名前。
 *
 * ヘッダーのパンくずとメニュー（ランチャー）で使い回す。タブ帯だけは帯の形が違うので
 * `PaneTabs` が自前で描く（色の出どころは同じ `systemsStore.colorOf`）。
 *
 * **文字は着色しない。** パレット色は全テーマで文字色としてのコントラストを保証できず、
 * ここでは名前が本体・色は補助だから——色覚特性で色が読めなくても、名前で区別が付く。
 */
import { computed } from "vue";
import { systemsStore } from "../stores/systems.js";
import { systemColorVar } from "../composables/systemColor.js";

const props = defineProps<{
  /** システム参照（`own:` / `srv:`） */
  systemRef: string;
  /** 名前を出さず点だけにする（場所が狭いとき） */
  dotOnly?: boolean;
}>();

const color = computed(() => systemColorVar(systemsStore.colorOf(props.systemRef)));
const name = computed(() => systemsStore.nameOf(props.systemRef));
</script>

<template>
  <span class="sysdot-wrap">
    <span class="sysdot" :style="{ background: color }" :title="name" aria-hidden="true"></span>
    <span v-if="!dotOnly" class="sysdot-name">{{ name }}</span>
  </span>
</template>

<style scoped>
.sysdot-wrap {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.sysdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  /* 地色と同化しないよう、うっすら縁を置く（明暗どちらのテーマでも輪郭が残る） */
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 18%);
}
.sysdot-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
