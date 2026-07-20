import { ref, type Ref } from "vue";

/**
 * 表の列幅を「中身に合わせる（上限つき）＋ドラッグで変えられる」ようにする。
 *
 * SQL ペインで作った振る舞いを、データ転送ペインでも同じにするために切り出した。
 * **複製すると片方だけ直す事故になる**——列幅の打ち切り基準（`max-width`）と
 * 手動指定が噛み合っている必要があり、片側だけ直すと「広げても見えない」に戻る。
 *
 * 既定は CSS 側（`th, td { max-width: <上限> }`）が担い、ここは**手で指定したぶん**だけを持つ。
 */
export interface ColumnWidths {
  /** 現在ドラッグ中の列位置（-1 = していない） */
  resizing: Ref<number>;
  /** その列に当てるインラインスタイル。未指定なら undefined（CSS の既定に任せる） */
  widthStyle: (index: number) => Record<string, string> | undefined;
  onDown: (e: PointerEvent, index: number) => void;
  onMove: (e: PointerEvent) => void;
  onUp: (e: PointerEvent) => void;
  /** 既定（中身に合わせた幅）へ戻す */
  reset: (index: number) => void;
  /** すべて捨てる。**列の並びが変わるとき**に呼ぶ */
  clear: () => void;
}

/** これ以上狭めない。掴めなくなるため */
const MIN_COL = 40;

export function useColumnWidths(): ColumnWidths {
  /**
   * 列名は重複しうる（結合した SELECT など）ので**位置で持つ**。
   * 並びが変わったら `clear()` すること——前の幅が残ると対応が狂う。
   */
  const widths = ref<Record<number, number>>({});
  const resizing = ref(-1);
  let startX = 0;
  let startW = 0;

  function widthStyle(index: number): Record<string, string> | undefined {
    const w = widths.value[index];
    if (w === undefined) return undefined;
    // width だけでは table-layout: auto が中身を優先して広げてしまう。
    // **max-width も動かさないと打ち切りが既定のままで、広げても隠れた文字が見えない**
    return { width: `${w}px`, minWidth: `${w}px`, maxWidth: `${w}px` };
  }

  function onDown(e: PointerEvent, index: number): void {
    const th = (e.currentTarget as HTMLElement).parentElement;
    if (!th) return;
    resizing.value = index;
    startX = e.clientX;
    startW = th.getBoundingClientRect().width;
    // jsdom には無いので存在確認する（テストから経路を通せるように）
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    // 掴んだ列の見出しの title が出っぱなしになるのを防ぐ
    e.stopPropagation();
  }

  function onMove(e: PointerEvent): void {
    if (resizing.value < 0) return;
    const w = Math.max(MIN_COL, Math.round(startW + (e.clientX - startX)));
    widths.value = { ...widths.value, [resizing.value]: w };
  }

  function onUp(e: PointerEvent): void {
    if (resizing.value < 0) return;
    resizing.value = -1;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  function reset(index: number): void {
    const next = { ...widths.value };
    delete next[index];
    widths.value = next;
  }

  function clear(): void {
    widths.value = {};
  }

  return { resizing, widthStyle, onDown, onMove, onUp, reset, clear };
}
