import { ref, type Ref } from "vue";

/**
 * 読み込み中の表示を**遅らせて**出す。
 *
 * すぐ返る問い合わせで一瞬だけスピナーが出ると、画面がちらついて
 * かえって遅く感じる。既定 500ms を超えたときだけ出す。
 */
export function useDelayedLoading(delayMs = 500): {
  /** 表示すべきか（遅延を超えた読み込み中のみ true） */
  visible: Ref<boolean>;
  /** 実際に読み込み中か（ボタンの二重押し防止などに使う） */
  busy: Ref<boolean>;
  /** 非同期処理を包む。開始・終了の管理を任せる */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  const visible = ref(false);
  const busy = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    busy.value = true;
    timer = setTimeout(() => {
      if (busy.value) visible.value = true;
    }, delayMs);
    try {
      return await fn();
    } finally {
      busy.value = false;
      visible.value = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  }

  return { visible, busy, run };
}
