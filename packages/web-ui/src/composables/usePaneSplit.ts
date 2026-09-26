import { ref } from "vue";

/**
 * 2 つのペインの境界をドラッグして、前側（上段／左列）の大きさを変える。加えて後側の最大化を持つ。
 *
 * **`axis` で向きを選ぶ**——既定の `"y"` は上下 2 段（高さ）、`"x"` は左右（幅）。
 * 左右は IFS ペインの「フォルダ一覧｜ファイル一覧｜表示」の境界で使う（利用者の要望。
 * `20260924-vscode-extension` D18）。同じ掴み方・同じキー操作にするため、別実装にしない。
 *
 * SQL ペイン（クエリ欄／結果）とスプールペイン（一覧／表示）で**同じ操作**にするための共通化。
 * 元は SqlPane に直書きしていたが、スプールでも同じことをしたいという要望で切り出した。
 *
 * 掴むのは境界の罫線そのもの（textarea の右下のつまみは出さない）。
 * **どこを掴めば動くのか分からない**という指摘への答えなので、当たり判定は罫線より広く取る
 * （見た目 1px でも掴める幅は 9px。`PaneSplitter.vue` 側）。
 */
export interface PaneSplit {
  /** 前側（`axis:"y"` なら上段の高さ、`"x"` なら左列の幅。px） */
  size: ReturnType<typeof ref<number>>;
  dragging: ReturnType<typeof ref<boolean>>;
  /** 下段を最大化しているか（上段と境界を隠す） */
  maximized: ReturnType<typeof ref<boolean>>;
  onDown: (e: PointerEvent) => void;
  onMove: (e: PointerEvent) => void;
  onUp: (e: PointerEvent) => void;
  onKeydown: (e: KeyboardEvent) => void;
  toggleMaximize: () => void;
}

export function usePaneSplit(opts: { initial: number; min?: number; max?: number; axis?: "x" | "y" }): PaneSplit {
  const min = opts.min ?? 60;
  const max = opts.max ?? 600;
  const horizontal = opts.axis === "x";
  const size = ref(opts.initial);
  const dragging = ref(false);
  const maximized = ref(false);
  let startPos = 0;
  let startSize = 0;
  const pos = (e: PointerEvent): number => (horizontal ? e.clientX : e.clientY);

  const clamp = (h: number): number => Math.min(max, Math.max(min, h));

  function onDown(e: PointerEvent): void {
    dragging.value = true;
    startPos = pos(e);
    startSize = size.value ?? opts.initial;
    // capture しないと、速く動かしたときにポインタが罫線から外れて追従が切れる
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onMove(e: PointerEvent): void {
    if (!dragging.value) return;
    size.value = clamp(startSize + (pos(e) - startPos));
  }

  function onUp(e: PointerEvent): void {
    if (!dragging.value) return;
    dragging.value = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  /** キーボードでも動かせるように（罫線は separator として focus できる） */
  function onKeydown(e: KeyboardEvent): void {
    const step = e.shiftKey ? 40 : 10;
    const h = size.value ?? opts.initial;
    const [less, more] = horizontal ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (e.key === less) size.value = clamp(h - step);
    else if (e.key === more) size.value = clamp(h + step);
    else return;
    e.preventDefault();
  }

  /** 下段の最大化を切り替える。**高さは覚えたまま**なので戻すと元の配分に戻る */
  function toggleMaximize(): void {
    maximized.value = !maximized.value;
  }

  return { size, dragging, maximized, onDown, onMove, onUp, onKeydown, toggleMaximize };
}
