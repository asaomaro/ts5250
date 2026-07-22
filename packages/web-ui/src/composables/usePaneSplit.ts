import { ref } from "vue";

/**
 * 上下 2 段のペインの境界をドラッグして高さを変える。加えて下段の最大化を持つ。
 *
 * SQL ペイン（クエリ欄／結果）とスプールペイン（一覧／表示）で**同じ操作**にするための共通化。
 * 元は SqlPane に直書きしていたが、スプールでも同じことをしたいという要望で切り出した。
 *
 * 掴むのは境界の罫線そのもの（textarea の右下のつまみは出さない）。
 * **どこを掴めば動くのか分からない**という指摘への答えなので、当たり判定は罫線より広く取る
 * （見た目 1px でも掴める幅は 9px。`PaneSplitter.vue` 側）。
 */
export interface PaneSplit {
  /** 上段の高さ（px） */
  topHeight: ReturnType<typeof ref<number>>;
  dragging: ReturnType<typeof ref<boolean>>;
  /** 下段を最大化しているか（上段と境界を隠す） */
  maximized: ReturnType<typeof ref<boolean>>;
  onDown: (e: PointerEvent) => void;
  onMove: (e: PointerEvent) => void;
  onUp: (e: PointerEvent) => void;
  onKeydown: (e: KeyboardEvent) => void;
  toggleMaximize: () => void;
}

export function usePaneSplit(opts: { initial: number; min?: number; max?: number }): PaneSplit {
  const min = opts.min ?? 60;
  const max = opts.max ?? 600;
  const topHeight = ref(opts.initial);
  const dragging = ref(false);
  const maximized = ref(false);
  let startY = 0;
  let startHeight = 0;

  const clamp = (h: number): number => Math.min(max, Math.max(min, h));

  function onDown(e: PointerEvent): void {
    dragging.value = true;
    startY = e.clientY;
    startHeight = topHeight.value ?? opts.initial;
    // capture しないと、速く動かしたときにポインタが罫線から外れて追従が切れる
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onMove(e: PointerEvent): void {
    if (!dragging.value) return;
    topHeight.value = clamp(startHeight + (e.clientY - startY));
  }

  function onUp(e: PointerEvent): void {
    if (!dragging.value) return;
    dragging.value = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  /** キーボードでも動かせるように（罫線は separator として focus できる） */
  function onKeydown(e: KeyboardEvent): void {
    const step = e.shiftKey ? 40 : 10;
    const h = topHeight.value ?? opts.initial;
    if (e.key === "ArrowUp") topHeight.value = clamp(h - step);
    else if (e.key === "ArrowDown") topHeight.value = clamp(h + step);
    else return;
    e.preventDefault();
  }

  /** 下段の最大化を切り替える。**高さは覚えたまま**なので戻すと元の配分に戻る */
  function toggleMaximize(): void {
    maximized.value = !maximized.value;
  }

  return { topHeight, dragging, maximized, onDown, onMove, onUp, onKeydown, toggleMaximize };
}
