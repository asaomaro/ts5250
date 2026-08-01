/**
 * ファイルのプレビュー。
 *
 * **blob URL の寿命をここに閉じ込める。** 既存の `PrinterPane.vue` は
 * `click()` の直後に `revokeObjectURL` しており、これはダウンロードでは正しいが
 * プレビューに転用すると**表示される前に消える**。
 * 解放するのは「次を表示する直前」と「ペインを破棄する時」の 2 箇所だけ。
 */
import { ref, onBeforeUnmount } from "vue";
import type { LineEnding } from "@as400web/ebcdic/catalog";
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
  /** 採用した文字コードと、その根拠。保存時にそのまま書き戻すのにも使う */
  ccsid?: number;
  detectedBy?: "content" | "tag" | "manual";
  newline?: LineEnding;
  bom?: boolean;
  /** ファイルに付いていたタグ。採用したものとは限らない（読めなかったときの手掛かり） */
  tagCcsid?: number;
  /**
   * 上限を超えるので**読みに行かなかった**。`kind` は保つ（`binary` に落とさない）——
   * 「バイナリだから見せられない」と「大きすぎるから見せられない」は別の理由で、
   * 利用者の次の一手も違う（前者は諦める / 後者はダウンロードすれば中身が得られる）。
   */
  tooLarge?: boolean;
  /** `tooLarge` のときの上限。文言に出す */
  maxBytes?: number;
  /**
   * 拡張子はテキストだが、復号した中身に**ヌルバイトが混ざっていた**。
   * `undecodable`（文字コード未対応）とは別物——こちらは文字コードの問題ではなく、
   * そもそもテキストではない。案内を取り違えると利用者が文字コードを選び直し続けることになる。
   */
  binaryContent?: boolean;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
/**
 * テキストとして開く拡張子。
 *
 * **IBM i の資産を厚めに入れている**——IFS に置かれるのは一般的なテキストだけでなく、
 * ソース（RPG / CL / SQLRPG）や DDS（表示・印刷・物理・論理ファイル）が普通にある。
 * これらは拡張子だけ見ればテキストなので、バイナリ扱いで「ダウンロードしてください」に
 * 落とすとソースを画面で確認できない。
 *
 * 判定は**拡張子だけ**で、中身は見ていない。文字コードの判定は別（サーバーの決定表）。
 */
const TEXT_EXT = new Set([
  // 一般的なテキスト・設定・データ
  "txt", "log", "md", "ini", "conf", "cfg", "properties", "env",
  "json", "jsonl", "ndjson", "xml", "yml", "yaml", "toml", "csv", "tsv",
  // IBM i のソース・DDS（拡張子だけ見ればテキスト）
  "rpg", "rpgle", "sqlrpg", "sqlrpgle", "clp", "clle", "cl", "cmd", "cbl", "cblle", "sqlcbl",
  "dspf", "prtf", "pf", "lf", "mbr", "dds", "dtaara",
  // スクリプト・プログラム
  "sh", "bash", "zsh", "bat", "ps1", "psm1", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "java", "c", "h", "cpp", "hpp", "cs", "go", "rb", "php", "pl", "sql",
  // マークアップ・スタイル
  "html", "htm", "css", "scss", "svg", "vue", "diff", "patch"
]);

/** パスの最後の要素。拡張子の判定は**ファイル名だけ**を見る（`/a.b/noext` に引きずられない） */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function kindOf(path: string): PreviewKind {
  const name = baseName(path);
  const at = name.lastIndexOf(".");
  // `.bashrc` `.gitignore` のような**ドットで始まる拡張子なしのファイル**はテキストとして扱う。
  // この形は設定ファイルであることがほとんどで、バイナリで置かれることはまず無い
  if (at === 0) return "text";
  if (at < 0) return "binary";
  const ext = name.slice(at + 1).toLowerCase();
  if (ext === "pdf") return "pdf";
  // `.svg` は画像として描ける（テキストでもある）。**画像の判定を先に置く**——
  // 拡張子の集合が重なる唯一の例なので、順序が意味を持つ
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

/**
 * @param limits サーバーの実効上限を返す関数。**関数で受ける**のは `source` と同じ理由——
 *   `IfsPane` が非同期に取得するので、値渡しだと取得前の `undefined` で固定される。
 *   省略・未取得の間は**先回り判定をしない**（上限を知らないうちに読めるものを断らない）。
 */
export function usePreview(
  source: () => IfsSource,
  limits?: () => { readMaxBytes: number } | undefined
) {
  const state = ref<PreviewState | undefined>(undefined);
  const loading = ref(false);
  const error = ref("");
  /**
   * 発行した要求の世代。**遅い応答が後から勝つのを防ぐ**ための単調増加カウンタ。
   *
   * IFS は実効 100KB/s なので、大きい A を選んだ直後に小さい B を選ぶと B が先に返る。
   * 門番を置かないと、後から届いた A が B を上書きして**選んでいないファイルが表示される**。
   *
   * `AbortController` で中断する案は採らなかった——`ifsApi` の `post()` に `signal` を通す
   * 配管が全 API に要るうえ、**サーバーは既にホストから読み切っている**ので節約できるのは
   * ブラウザ側の受信だけ。中断は `AbortError` を投げるので門番が 2 種類になる。
   * ここでは「応答は待つが、使わない」に徹する。
   */
  let latest = 0;

  /** 表示中の blob URL を解放する。表示を差し替える前と、破棄時に呼ぶ */
  function revoke(): void {
    if (state.value?.url) URL.revokeObjectURL(state.value.url);
  }

  function clear(): void {
    revoke();
    state.value = undefined;
    error.value = "";
  }

  /**
   * テキストを指定の文字コードで読み直す。
   * 自動判定（中身 → タグ）が外れたときに利用者が選ぶ道（サーバーの `detectedBy: "manual"`）。
   *
   * **失敗しても直前の表示を消さない。** 選び直しは「当たるまで試す」操作なので、
   * 1 回外しただけで本文も選択 UI も消えると、次の 1 手が打てなくなる
   * （IfsPane が「プレビューに失敗しても操作は消さない」としているのと同じ理屈）。
   */
  async function reload(ccsid: number): Promise<void> {
    const current = state.value;
    if (!current || current.kind !== "text") return;
    // `show` が採る世代を先に押さえる。**巻き戻しも門番の対象**——
    // 待っている間に別のファイルが選ばれていたら、その表示を古い状態で潰してはいけない
    const token = latest + 1;
    await show(current.path, current.bytes, ccsid);
    // テキストは blob URL を持たないので、そのまま戻して問題ない
    if (token === latest && state.value === undefined) state.value = current;
  }

  async function show(path: string, sizeHint?: number, ccsid?: number): Promise<void> {
    const token = ++latest;
    /** 自分より新しい要求が出ていれば、この応答は捨てる */
    const isStale = (): boolean => token !== latest;

    const kind = kindOf(path);
    // 表示できない種別は読みに行かない（100KB/s のホストから無駄に転送しない）
    if (kind === "binary") {
      revoke();
      state.value = { path, kind, text: null, url: "", bytes: sizeHint ?? 0, undecodable: false };
      error.value = "";
      // **読まずに終わる分岐でもローディングは落とす。** 先行する遅い要求が居ると、
      // その `finally` は `isStale()` で握られる＝誰も落とさなくなり true に張り付く
      loading.value = false;
      return;
    }

    // **読みに行く前に断る。** 一覧が持っているサイズで上限超過と分かるなら、
    // サーバーが 413 を返すまで待たせる理由が無い。
    // 断るのは「サイズが分かっていて、上限も分かっていて、超えている」ときだけ——
    // どちらかが不明なまま断ると、読めるファイルを見せられなくなる（従来より劣化する）。
    const max = limits?.()?.readMaxBytes;
    if (sizeHint !== undefined && max !== undefined && sizeHint > max) {
      revoke();
      state.value = {
        path,
        kind,
        text: null,
        url: "",
        bytes: sizeHint,
        undecodable: false,
        tooLarge: true,
        maxBytes: max
      };
      error.value = "";
      // binary 分岐と同じ理由。読まずに終わってもここが終着点なので落とす
      loading.value = false;
      return;
    }

    loading.value = true;
    error.value = "";
    try {
      if (kind === "text") {
        const result = await readFile(source(), path, "utf8", ccsid);
        if (isStale()) return;
        revoke();
        state.value = {
          path,
          kind,
          text: result.content,
          url: "",
          bytes: result.bytes,
          // サーバーは復号できないとき 200 で content: null を返す。失敗ではない
          undecodable: result.content === null,
          // 復号できた中身にヌルバイトがあれば、拡張子がテキストでも中身はバイナリ。
          // 追加の往復はしない（base64 で読み直して生バイトを見る価値は文言の精度だけ）
          ...(result.content !== null && result.content.includes("\u0000")
            ? { binaryContent: true }
            : {}),
          ...(result.ccsid !== undefined ? { ccsid: result.ccsid } : {}),
          ...(result.detectedBy !== undefined ? { detectedBy: result.detectedBy } : {}),
          ...(result.newline !== undefined ? { newline: result.newline } : {}),
          ...(result.bom !== undefined ? { bom: result.bom } : {}),
          ...(result.tagCcsid !== undefined ? { tagCcsid: result.tagCcsid } : {})
        };
        return;
      }
      const blob = await download(source(), path);
      // **URL を作る前に捨てる。** `revoke()` は `state.value?.url` しか見ないので、
      // 作ってから捨てると解放する当てが無くなる（作らなければ漏れようがない）
      if (isStale()) return;
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
      // 古い要求の失敗で、新しい要求の表示を消さない
      if (isStale()) return;
      error.value =
        e instanceof IfsRequestError ? e.message : e instanceof Error ? e.message : String(e);
      revoke();
      state.value = undefined;
    } finally {
      // **ここも門番が要る。** 守らないと、新しい要求の実行中に古い応答が
      // ローディング表示を消す（読み込み中なのに何も起きていないように見える）
      if (!isStale()) loading.value = false;
    }
  }

  // ペインを閉じたら解放する（開いたまま残すと、タブを消すたびに漏れる）
  onBeforeUnmount(revoke);

  return { state, loading, error, show, reload, clear };
}
