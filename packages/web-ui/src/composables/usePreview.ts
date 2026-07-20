/**
 * ファイルのプレビュー。
 *
 * **blob URL の寿命をここに閉じ込める。** 既存の `PrinterPane.vue` は
 * `click()` の直後に `revokeObjectURL` しており、これはダウンロードでは正しいが
 * プレビューに転用すると**表示される前に消える**。
 * 解放するのは「次を表示する直前」と「ペインを破棄する時」の 2 箇所だけ。
 */
import { ref, onBeforeUnmount } from "vue";
import { download, readFile, IfsRequestError, type IfsSource } from "../ifsApi.js";

export type PreviewKind = "text" | "pdf" | "image" | "binary";

/** プレビューの状態。`kind` によって見せ方が変わる */
export interface PreviewState {
  path: string;
  kind: PreviewKind;
  /** テキストの中身。復号できなかった場合は null */
  text: string | null;
  /** PDF / 画像の blob URL */
  url: string;
  bytes: number;
  /**
   * 復号できなかった理由。**エラーではない**——
   * 読み取りは成功していて、表示手段が無いだけ（サーバーは 200 で返す）。
   */
  undecodable: boolean;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const TEXT_EXT = new Set([
  "txt", "log", "md", "json", "xml", "csv", "yml", "yaml", "ini", "conf", "properties",
  "sh", "js", "ts", "css", "html", "htm", "sql", "rpgle", "clle", "cbl", "c", "h", "java", "py"
]);

export function kindOf(path: string): PreviewKind {
  const at = path.lastIndexOf(".");
  if (at < 0) return "binary";
  const ext = path.slice(at + 1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

export function usePreview(source: () => IfsSource) {
  const state = ref<PreviewState | undefined>(undefined);
  const loading = ref(false);
  const error = ref("");

  /** 表示中の blob URL を解放する。表示を差し替える前と、破棄時に呼ぶ */
  function revoke(): void {
    if (state.value?.url) URL.revokeObjectURL(state.value.url);
  }

  function clear(): void {
    revoke();
    state.value = undefined;
    error.value = "";
  }

  async function show(path: string, sizeHint?: number): Promise<void> {
    const kind = kindOf(path);
    // 表示できない種別は読みに行かない（100KB/s のホストから無駄に転送しない）
    if (kind === "binary") {
      revoke();
      state.value = { path, kind, text: null, url: "", bytes: sizeHint ?? 0, undecodable: false };
      error.value = "";
      return;
    }

    loading.value = true;
    error.value = "";
    try {
      if (kind === "text") {
        const result = await readFile(source(), path);
        revoke();
        state.value = {
          path,
          kind,
          text: result.content,
          url: "",
          bytes: result.bytes,
          // サーバーは復号できないとき 200 で content: null を返す。失敗ではない
          undecodable: result.content === null
        };
        return;
      }
      const blob = await download(source(), path);
      // **次を表示する直前に解放する**（表示中は生かしておく）
      revoke();
      state.value = {
        path,
        kind,
        text: null,
        url: URL.createObjectURL(blob),
        bytes: blob.size,
        undecodable: false
      };
    } catch (e) {
      error.value =
        e instanceof IfsRequestError ? e.message : e instanceof Error ? e.message : String(e);
      revoke();
      state.value = undefined;
    } finally {
      loading.value = false;
    }
  }

  // ペインを閉じたら解放する（開いたまま残すと、タブを消すたびに漏れる）
  onBeforeUnmount(revoke);

  return { state, loading, error, show, clear };
}
