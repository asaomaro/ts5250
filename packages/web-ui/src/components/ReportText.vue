<script setup lang="ts">
/**
 * **帳票の本文**（`20260802-view-menu-refine`）。プリンターセッションとスプールで共用する。
 *
 * `⚙ 表示` の設定のうち、**この経路で実際に効くもの**だけを適用する:
 *
 * - `linkify`——本文中の URL・メールをリンクにする
 * - `font`——`--screen-mono` を上書きする（`EmulatorPane` と同じやり方）
 *
 * **SO/SI 表示と表示コードは適用できない。** 帳票の本文は SCS の復号を通った
 * Unicode 文字列として届き、`packages/scs` の `ScsParser` が SO/SI（0x0E/0x0F）を
 * シフト状態の切替として**消費**するので、印を付ける位置も、対の表で読み直す生バイトも、
 * ここには残っていない（帳票の復号コードページはシステム設定の `spoolCcsid` で選ぶ）。
 * だから `⚙ 表示` にもその 2 つは出していない——効かないものを並べない。
 */
import { computed } from "vue";
import { viewSettings } from "../stores/viewSettings.js";
import { screenFontStack } from "../composables/screenFonts.js";
import { splitLinks } from "../composables/linkify.js";

const props = defineProps<{
  /** カスケードの鍵（プリンターはセッション ID、スプールはタブ ID） */
  sessionId: string;
  text: string;
}>();

const view = computed(() => viewSettings.effective(props.sessionId));
const fontStyle = computed<Record<string, string> | undefined>(() => {
  const stack = screenFontStack(view.value.font);
  return stack ? { "--screen-mono": stack } : undefined;
});

/**
 * 行ごとの描画部品。**行で分けてから**リンクを探す——1 本の文字列のまま `splitLinks` に
 * 渡すと、改行をまたいだ並びを 1 つの URL と見なしかねない。
 */
const lines = computed(() =>
  props.text.split("\n").map((line) => (view.value.linkify ? splitLinks(line) : [{ text: line }]))
);
</script>

<template>
  <pre class="report" :style="fontStyle"><template v-for="(parts, i) in lines" :key="i"><template
    v-for="(p, j) in parts"
    :key="j"
  ><a v-if="p.href" :href="p.href" target="_blank" rel="noopener noreferrer">{{ p.text }}</a><template
    v-else
  >{{ p.text }}</template></template>{{ i < lines.length - 1 ? "\n" : "" }}</template></pre>
</template>

<style scoped>
.report {
  margin: 0;
  font-family: var(--screen-mono);
  white-space: pre;
}
.report a {
  color: var(--t-turquoise, var(--accent));
}
</style>
