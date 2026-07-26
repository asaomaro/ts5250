<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from "vue";
import { useSkin, SKIN_META, type Skin } from "../composables/useSkin.js";
import { useTheme, type ThemeMode } from "../composables/useTheme.js";
import { openHeaderMenu, toggleHeaderMenu, closeHeaderMenu } from "../composables/headerMenu.js";

/**
 * デザイン切替メニュー。5250 端末 と Web アプリ風スキンを選び、
 * 端末なら表示モード（通常/ダーク/システム）、Web スキンならコントロール表現（リッチ/プレーン）を選べる。
 */
const { skin, setSkin } = useSkin();
const { mode, setMode } = useTheme();

// ヘッダーのポップオーバーは同時に 1 つだけ（共有状態）。画面設定と排他になる。
const MENU_ID = "design";
const open = computed(() => openHeaderMenu.value === MENU_ID);
const current = computed(() => SKIN_META.find((s) => s.id === skin.value) ?? SKIN_META[0]!);
const isTerminal = computed(() => skin.value === "t5250");
const terms = SKIN_META.filter((s) => s.group === "term");
const webs = SKIN_META.filter((s) => s.group === "web");
const THEMES: { m: ThemeMode; label: string }[] = [
  { m: "light", label: "通常" },
  { m: "dark", label: "ダーク" },
  { m: "system", label: "システム" },
];

function pick(id: Skin): void {
  setSkin(id);
}
function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement).closest?.(".designer")) closeHeaderMenu(MENU_ID);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeHeaderMenu(MENU_ID);
}
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="designer">
    <button class="dz-btn" :aria-expanded="open" aria-haspopup="menu" title="デザイン" @click.stop="toggleHeaderMenu(MENU_ID)">
      <span class="swatch" :style="{ background: current.swatch }"></span>
      <span class="dz-name">{{ current.name }}</span>
      <span class="chev">▾</span>
    </button>
    <div v-if="open" class="dz-menu" role="menu">
      <div class="dz-sec">端末</div>
      <button
        v-for="s in terms"
        :key="s.id"
        class="dz-opt"
        role="menuitemradio"
        :aria-checked="skin === s.id"
        @click="pick(s.id)"
      >
        <span class="swatch" :style="{ background: s.swatch }"></span>{{ s.name }}
        <span class="tag">{{ s.tag }}</span><span class="ck">✓</span>
      </button>
      <div class="dz-sec">Web アプリ</div>
      <button
        v-for="s in webs"
        :key="s.id"
        class="dz-opt"
        role="menuitemradio"
        :aria-checked="skin === s.id"
        @click="pick(s.id)"
      >
        <span class="swatch" :style="{ background: s.swatch }"></span>{{ s.name }}
        <span class="tag">{{ s.tag }}</span><span class="ck">✓</span>
      </button>
      <template v-if="isTerminal">
        <div class="dz-div"></div>
        <div class="dz-sub">
          <span class="dz-sublabel">表示モード</span>
          <div class="seg" role="group" aria-label="表示モード">
            <button v-for="t in THEMES" :key="t.m" :class="{ on: mode === t.m }" @click="setMode(t.m)">
              {{ t.label }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.designer {
  position: relative;
}
.dz-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 12px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
  cursor: pointer;
}
.dz-btn:hover {
  border-color: var(--accent);
}
.swatch {
  width: 13px;
  height: 13px;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.35);
  flex: none;
}
.chev {
  color: var(--muted);
  font-size: 9px;
}
.dz-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 80;
  width: 260px;
  max-height: 74vh;
  overflow-y: auto;
  padding: 6px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 16px 44px -14px rgba(0, 0, 0, 0.45);
}
.dz-sec {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  padding: 6px 8px 3px;
}
.dz-opt {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  font-family: var(--sans);
  font-size: 12.5px;
  color: var(--ink);
  border: none;
  background: transparent;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.dz-opt:hover {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  border-color: transparent;
  color: var(--ink);
}
.dz-opt .tag {
  color: var(--muted);
  font-size: 10.5px;
}
.dz-opt .ck {
  margin-left: auto;
  color: var(--accent);
  opacity: 0;
}
.dz-opt[aria-checked="true"] {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.dz-opt[aria-checked="true"] .ck {
  opacity: 1;
}
.dz-div {
  height: 1px;
  background: var(--line);
  margin: 6px 4px;
}
.dz-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px 6px;
}
.dz-sublabel {
  font-family: var(--sans);
  font-size: 12px;
  color: var(--ink);
}
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 7px;
  overflow: hidden;
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.seg button {
  font-family: var(--sans);
  font-size: 11px;
  font-weight: 600;
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 4px 9px;
  border-radius: 0;
  cursor: pointer;
}
.seg button:hover {
  color: var(--ink);
  border-color: transparent;
}
.seg button.on {
  background: var(--accent);
  color: var(--card);
}
</style>
