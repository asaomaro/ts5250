<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { systemsStore } from "../stores/systems.js";
import LoadingBar from "./LoadingBar.vue";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import { useIfsTree } from "../composables/useIfsTree.js";
import { usePreview } from "../composables/usePreview.js";
import {
  IfsRequestError,
  deleteFile,
  download,
  makeDirectory,
  writeFile,
  zipFolder,
  type IfsEntry
} from "../ifsApi.js";
import { isFileDrag } from "../dnd.js";
import { TEXT_CCSIDS, ccsidLabel } from "@as400web/core/browser";

/**
 * IFS のファイルブラウザ。左に階層ツリー、中央に一覧、右にプレビュー。
 *
 * 見える範囲は IBM i の権限が決めるため、アプリ側で追加の制限は掛けない
 * （他のホスト API と同じ方針）。
 *
 * **サーバーの応答をそのまま解釈しない**——ページングの罠（空でも続きがある／
 * 辿れない場所がある）と、復号できないテキスト（エラーではない）は
 * composable が吸収済み。ここでは吸収後の状態だけを見る。
 */
defineProps<{ tabId: string }>();

const ROOT = "/";
const source = () => ({ system: systemsStore.selected });
const tree = useIfsTree(source);
const preview = usePreview(source);
const { visible: slowLoading, busy, run } = useDelayedLoading();
/** 通信中は操作を止める。zip は実機で分単位かかるので、連打・並行実行を許さない */
const disabled = computed(() => busy.value || uploading.value);

const currentPath = ref(ROOT);
const selected = ref<IfsEntry | undefined>(undefined);
const message = ref("");
const actionError = ref("");

const currentNode = computed(() => tree.nodeAt(currentPath.value));
const entries = computed(() => currentNode.value.entries);
/** 続きはあるが辿れない場所（`/QSYS.LIB` など） */
const blocked = computed(() => currentNode.value.blocked === true);
const hasMore = computed(() => currentNode.value.state === "partial" && !blocked.value);

/** パンくず。ルートからのパスを分解する */
const crumbs = computed(() => {
  const parts = currentPath.value.split("/").filter(Boolean);
  const out = [{ label: "/", path: "/" }];
  let at = "";
  for (const p of parts) {
    at += `/${p}`;
    out.push({ label: p, path: at });
  }
  return out;
});

/**
 * ツリーを描画用の一次元の並びに直す。
 *
 * `nodes` は `Map<path, node>` で持っているので、**展開されている経路だけ**を辿って
 * 深さ付きの配列にする。入れ子のコンポーネントにしないのは、
 * 開閉のたびに再帰的な再描画を起こさないため。
 */
interface TreeRow {
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
}

function walk(path: string, depth: number, out: TreeRow[]): void {
  const node = tree.nodes.value.get(path);
  for (const e of node?.entries ?? []) {
    if (!e.isDirectory) continue;
    const child = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
    const childOpen = tree.expanded.value.has(child);
    out.push({
      path: child,
      name: e.name,
      depth,
      expanded: childOpen,
      loading: tree.nodes.value.get(child)?.state === "loading"
    });
    if (childOpen) walk(child, depth + 1, out);
  }
}

const treeRows = computed(() => {
  const out: TreeRow[] = [{ path: "/", name: "/", depth: 0, expanded: true, loading: false }];
  walk("/", 1, out);
  return out;
});

/** ツリーの行を開く。フォルダを開くと同時に一覧もそこへ移す */
/**
 * ツリーの行から移動する。
 *
 * **通信は必ず `run()` を通す。** `tree.toggle` の中で本番の往復が起きるので、
 * ここを外すと待機表示も操作禁止も効かない（`/QSYS.LIB` は実測 20 秒）。
 */
async function openFromTree(row: TreeRow): Promise<void> {
  await run(async () => {
    // 未展開なら開く。既に開いているものを畳まない——畳むと「移動する手段」が無くなる
    if (!tree.expanded.value.has(row.path)) await tree.toggle(row.path);
    await openPath(row.path);
  });
}

/** キャレットだけを押したときは開閉のみ（移動しない）。一般的なツリーの作法に合わせる */
async function toggleFromTree(row: TreeRow): Promise<void> {
  await run(async () => {
    await tree.toggle(row.path);
  });
}

const joined = (name: string): string =>
  currentPath.value === "/" ? `/${name}` : `${currentPath.value}/${name}`;

/**
 * 表示用のファイル名。
 * 実機の `/home` に端末エスケープを含む名前が実在したので、**そのまま流さない**。
 * 制御文字を可視の記号に置き換え、極端に長い名前は省略する。
 */
function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "\u2423");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned;
}

function sizeText(entry: IfsEntry): string {
  if (entry.isDirectory) return "";
  const n = entry.size;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function whenText(entry: IfsEntry): string {
  if (!entry.modifiedAt) return "";
  return new Date(entry.modifiedAt).toLocaleString();
}

/** 現在地までの経路をツリーで開く（要求は増えない。読み込み済みなら再取得しない） */
async function revealInTree(path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let at = "";
  for (const p of parts.slice(0, -1)) {
    at += `/${p}`;
    if (!tree.expanded.value.has(at)) await tree.toggle(at);
  }
}

async function openPath(path: string): Promise<void> {
  // 移動したら前の操作の結果は関係ない。出しっぱなしにしない
  message.value = "";
  actionError.value = "";
  currentPath.value = path;
  selected.value = undefined;
  preview.clear();
  await run(async () => {
    await tree.load(path);
    await revealInTree(path);
  });
}

async function activate(entry: IfsEntry): Promise<void> {
  if (entry.isDirectory) {
    await openPath(joined(entry.name));
    return;
  }
  message.value = "";
  actionError.value = "";
  selected.value = entry;
  await run(async () => {
    await preview.show(joined(entry.name), entry.size);
  });
  // 表示できたテキストを編集の初期値にする。復号できなかったものは編集させない
  editText.value = preview.state.value?.kind === "text" ? (preview.state.value.text ?? "") : "";
}

/**
 * テキストの編集。
 *
 * **復号できたテキストだけ編集・保存できる。** 復号できないファイル（`undecodable`）は
 * 編集の土台が無い——中身を文字列として持てないものを書き戻すと元ファイルを壊す。
 * 復号できても**書き戻せない文字コード**（Shift_JIS 系。core decisions D2）も同じ扱いにする。
 *
 * 保存は**読んだときの文字コード・行末・BOM のまま**書き戻す（UTF-8 に化けさせない）。
 */
const editText = ref("");
/** 採用中の文字コードが保存に使えるか。候補に無いものはサーバーの判断に委ねる */
const writable = computed(() => {
  const ccsid = preview.state.value?.ccsid;
  if (ccsid === undefined) return true;
  return TEXT_CCSIDS.find((c) => c.ccsid === ccsid)?.writable ?? true;
});
const editable = computed(
  () => preview.state.value?.kind === "text" && !preview.state.value.undecodable && writable.value
);

/** 採用した文字コードと、その根拠の表示 */
const encodingNote = computed(() => {
  const st = preview.state.value;
  if (!st || st.kind !== "text") return "";
  if (st.ccsid === undefined) {
    return st.tagCcsid !== undefined
      ? `復号できません（タグは ${ccsidLabel(st.tagCcsid)}）`
      : "復号できません";
  }
  const why =
    st.detectedBy === "manual" ? "手動" : st.detectedBy === "tag" ? "タグ" : "内容から判定";
  const tag =
    st.tagCcsid !== undefined && st.tagCcsid !== st.ccsid ? `／タグ ${st.tagCcsid}` : "";
  return `${ccsidLabel(st.ccsid)}（${why}${tag}）`;
});

/** 選択中の文字コード。手動で変えると読み直す */
const chosenCcsid = ref<number | undefined>(undefined);
watch(
  () => preview.state.value,
  (st) => {
    chosenCcsid.value = st?.ccsid;
  }
);

/**
 * 文字コードを選び直して読み直す。
 *
 * 引数に `<select>` 要素そのものを取るのは、**取り消したときに表示を戻す**ため——
 * `chosenCcsid` が変わらないと再描画が起きず、選択肢の見た目だけが動いたまま残る。
 */
async function changeCcsid(el: HTMLSelectElement): Promise<void> {
  const ccsid = Number(el.value);
  if (!Number.isFinite(ccsid) || ccsid <= 0) return;
  // **編集中なら確認する。** 読み直すと本文が入れ替わる＝編集が消える。
  // 同じペインの削除・上書きアップロードと同じ作法に揃える
  if (dirty.value && !window.confirm("編集中の内容は破棄されます。文字コードを変更しますか？")) {
    el.value = String(preview.state.value?.ccsid ?? "");
    return;
  }
  await withAction("読み直し", async () => {
    await run(async () => {
      await preview.reload(ccsid);
      editText.value = preview.state.value?.text ?? "";
    });
  });
}
/** 編集されていて、保存する意味があるか */
const dirty = computed(
  () => editable.value && editText.value !== (preview.state.value?.text ?? "")
);

async function saveText(): Promise<void> {
  const entry = selected.value;
  // `editable` を直接見る——復号できないものは書き戻さない（`dirty` は editable を含むが、
  // 保存経路そのものにも防御を置く。UI を経由しない呼び出しでも壊さないため）
  if (!entry || !editable.value || !dirty.value) return;
  await withAction("保存", async () => {
    await run(async () => {
      const st = preview.state.value;
      const written = await writeFile(source(), joined(entry.name), editText.value, "utf8", {
        ...(st?.ccsid !== undefined ? { ccsid: st.ccsid } : {}),
        ...(st?.newline !== undefined ? { newline: st.newline } : {}),
        ...(st?.bom !== undefined ? { bom: st.bom } : {})
      });
      // **置換が起きたことを黙らせない**——選んだ文字コードで表せない文字が SUB に落ちている
      message.value =
        written.substituted !== undefined && written.substituted > 0
          ? `${entry.name} を保存しました（${written.substituted} 文字はこの文字コードで表せないため置換しました）`
          : `${entry.name} を保存しました`;
      // 保存後は「これが現在の中身」にする。**手動で選んだ文字コードは保ったまま**読み直す
      // （自動判定に戻すと、利用者が直した選択が保存のたびに巻き戻る）
      if (st?.detectedBy === "manual" && st.ccsid !== undefined) {
        await preview.reload(st.ccsid);
      } else {
        await preview.show(joined(entry.name), editText.value.length);
      }
      editText.value = preview.state.value?.text ?? editText.value;
      await tree.refresh(currentPath.value);
    });
  });
}

/** blob をダウンロードとして落とす。表示用の URL とは寿命が違うのでここで解放する */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // ダウンロードは click 直後で問題ない（表示し続けるわけではない）
  URL.revokeObjectURL(url);
}

async function withAction(what: string, run2: () => Promise<void>): Promise<void> {
  actionError.value = "";
  message.value = "";
  try {
    await run2();
  } catch (e) {
    actionError.value =
      e instanceof IfsRequestError ? e.message : e instanceof Error ? e.message : String(e);
    if (!actionError.value) actionError.value = `${what}に失敗しました`;
  }
}

async function downloadSelected(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  await withAction("ダウンロード", async () => {
    await run(async () => {
      const blob = await download(source(), joined(entry.name));
      saveBlob(blob, entry.name);
    });
  });
}

async function downloadFolder(): Promise<void> {
  await withAction("一括ダウンロード", async () => {
    await run(async () => {
      const blob = await zipFolder(source(), currentPath.value);
      const name = currentPath.value.split("/").filter(Boolean).pop() ?? "ifs";
      saveBlob(blob, `${name}.zip`);
    });
  });
}

async function createFolder(): Promise<void> {
  const name = window.prompt("新しいフォルダの名前");
  if (!name) return;
  await withAction("フォルダの作成", async () => {
    await makeDirectory(source(), joined(name));
    message.value = `${name} を作成しました`;
    await tree.refresh(currentPath.value);
  });
}

async function removeSelected(): Promise<void> {
  const entry = selected.value;
  if (!entry || entry.isDirectory) return;
  if (!window.confirm(`${entry.name} を削除します。よろしいですか？`)) return;
  await withAction("削除", async () => {
    await deleteFile(source(), joined(entry.name));
    message.value = `${entry.name} を削除しました`;
    selected.value = undefined;
    preview.clear();
    await tree.refresh(currentPath.value);
  });
}

const uploading = ref(false);
const fileInput = ref<HTMLInputElement | undefined>(undefined);

/**
 * `<input>` から拾ったら値を戻す。戻さないと同じファイルを続けて選んでも change が来ない。
 *
 * **先に配列へ写す。** `input.value = ""` は `FileList` をその場で空にするので、
 * 参照だけ持っていると空を渡すことになる（実際にこれで一度壊した）。
 */
function onPick(input: HTMLInputElement): void {
  const files = Array.from(input.files ?? []);
  input.value = "";
  void uploadFiles(files);
}

/**
 * バイト列を base64 に。
 *
 * `String.fromCharCode(...buf)` は spread がスタックを溢れさせるので 1 バイトずつ連結する。
 * ただしこの実装は**大きなファイルで時間とメモリを食う**（20MB なら 20MB の文字列 +
 * 約 27MB の base64 + JSON 本文が同時に載る）。サーバー側の読み書き上限に守られているが、
 * クライアント側にサイズ上限を設ける余地は残っている（decisions D11・backlog）。
 */
function toBase64(buf: Uint8Array): string {
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 一覧を最後まで読めているか。
 *
 * `entries` は**読み込み済みのページ**しか持たない。1000 件を超えるフォルダでは
 * 未取得ページに同名があっても気づけないので、上書き確認の判断に使えない。
 */
const listingComplete = computed(() => currentNode.value.state === "loaded");

/** 既に同名があるか。一覧が読み切れていないときは呼ばないこと（判断できない） */
function existsHere(name: string): boolean {
  return currentNode.value.entries.some((e) => e.name === name);
}

async function uploadFiles(files: readonly File[] | FileList | null): Promise<void> {
  if (!files || files.length === 0) return;
  if (uploading.value) return; // 二重起動を入口で止める（ドロップの連打）
  // **開始時のコンテキストを固定する。** ループは 1 件ごとに await するので、
  // 途中でシステムを切り替えられると、残りが**新システムのルート**に書かれる。
  // watch は「見えているものを捨てる」だけで進行中の操作は止めない
  const src = source();
  const dir = currentPath.value;
  const at = (name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);
  uploading.value = true;
  actionError.value = "";
  message.value = "";
  const done: string[] = [];
  const failed: string[] = [];
  const list = Array.from(files);
  // 一覧が読み切れていないときは、ファイルごとではなく **1 回だけ**まとめて聞く
  if (!listingComplete.value && list.length > 0) {
    const ok = window.confirm(
      `このフォルダは一覧を最後まで読めていません。既存の同名ファイルを上書きする可能性があります。${list.length} 件を置きますか？`
    );
    if (!ok) {
      uploading.value = false;
      return;
    }
  }
  try {
    for (const file of list) {
      // フォルダをドロップすると size 0 の File が来る。空ファイルとして書き込まない
      if (file.size === 0 && file.type === "") {
        failed.push(`${file.name}（フォルダは置けません）`);
        continue;
      }
      // 一覧が読めているときだけ、個別に上書き確認する
      if (listingComplete.value && existsHere(file.name)) {
        if (!window.confirm(`${file.name} は既にあります。上書きしますか？`)) continue;
      }
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        await writeFile(src, at(file.name), toBase64(buf), "base64");
        done.push(file.name);
      } catch (e) {
        // **1 件の失敗を後続の成功で消さない。** まとめて最後に伝える
        failed.push(`${file.name}（${e instanceof IfsRequestError ? e.message : String(e)}）`);
      }
    }
    // 切り替えられていたら、その旨を伝えて今の画面は触らない
    if (source().system !== src.system) {
      actionError.value = "システムを切り替えたため、アップロードの結果は反映していません";
      return;
    }
    if (done.length > 0) message.value = `${done.length} 件置きました: ${done.join(", ")}`;
    if (failed.length > 0) actionError.value = `${failed.length} 件失敗: ${failed.join(" / ")}`;
    await tree.refresh(dir);
  } finally {
    uploading.value = false;
  }
}

const dragging = ref(false);
function onDragOver(ev: DragEvent): void {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  dragging.value = true;
}
function onDrop(ev: DragEvent): void {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  dragging.value = false;
  if (disabled.value) return; // 通信中は受け付けない（uploadFiles 側でも二重起動は止まる）
  void uploadFiles(Array.from(ev.dataTransfer?.files ?? []));
}

/**
 * システムを切り替えたら、いま見えているものを捨てる。
 *
 * 捨てないと、ヘッダーは新しいシステムを指しているのに並んでいるのは前のシステムの一覧、
 * という状態になる。**次の削除や上書きが別システムのファイルに飛ぶ**（HostListPane と同じ理由だが、
 * こちらは対象がファイルなので取り返しがつかない）。
 * 自動で取り直さないのは、切り替えただけで意図しない問い合わせを飛ばさないため。
 */
watch(
  () => systemsStore.selected,
  () => {
    tree.reset();
    message.value = "システムを切り替えました。フォルダを選ぶと読み込みます";
    currentPath.value = ROOT;
    selected.value = undefined;
    preview.clear();
    actionError.value = "";
  }
);

/**
 * テストから直接叩くための口。
 *
 * `<input>` 経由だと、jsdom が `input.value = ""` で `FileList` が空になる挙動を再現せず、
 * **符号化の検証ができない**（実際、その退行を単体テストで捕まえられなかった）。
 */
defineExpose({ uploadFiles });

void (async () => {
  await openPath(ROOT);
  // ルートは常に開いた状態で見せる（ツリーが空から始まると何も操作できない）
  if (!tree.expanded.value.has(ROOT)) await tree.toggle(ROOT);
})();
</script>

<template>
  <div class="ifs admin" @dragover="onDragOver" @dragleave="dragging = false" @drop="onDrop">
    <header>
      <h2>IFS</h2>
      <nav class="crumbs">
        <button
          v-for="c in crumbs"
          :key="c.path"
          class="crumb"
          :disabled="disabled"
          @click="openPath(c.path)"
        >
          {{ c.label }}
        </button>
      </nav>
      <button :disabled="disabled" @click="createFolder">新規フォルダ</button>
      <button :disabled="disabled" @click="downloadFolder">まとめてダウンロード</button>
      <!-- label ではなく button から input を叩く。hidden な input はキーボードで到達できない -->
      <button :disabled="disabled" @click="fileInput?.click()">アップロード</button>
      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden-input"
        @change="onPick(($event.target as HTMLInputElement))"
      />
    </header>

    <LoadingBar v-if="slowLoading || uploading" label="IFS と通信しています" />
    <p v-if="actionError" class="error">{{ actionError }}</p>
    <p v-if="message" class="note">{{ message }}</p>
    <p v-if="currentNode.state === 'error'" class="error">{{ currentNode.error }}</p>

    <div class="body" :class="{ dragging }">
      <!-- 左: 階層ツリー。展開されている経路だけを平坦化して並べる -->
      <nav class="tree" aria-label="フォルダ">
        <div
          v-for="r in treeRows"
          :key="r.path"
          class="tree-row"
          :data-path="r.path"
          :class="{ sel: r.path === currentPath }"
          :style="{ paddingLeft: `${4 + r.depth * 12}px` }"
        >
          <!-- キャレットは開閉のみ。ルートは畳めないので押せない -->
          <button
            class="caret"
            :disabled="disabled || r.path === '/'"
            :aria-expanded="r.path === '/' ? undefined : r.expanded"
            :aria-label="`${r.name} を開閉`"
            @click="toggleFromTree(r)"
          >
            {{ r.loading ? "…" : r.expanded ? "▾" : "▸" }}
          </button>
          <!-- 名前は移動。既に開いていても畳まない -->
          <button class="tree-name" :disabled="disabled" @click="openFromTree(r)">
            {{ displayName(r.name) }}
          </button>
        </div>
      </nav>

      <ul class="entries" role="listbox">
        <li
          v-for="e in entries"
          :key="e.name"
          role="option"
          tabindex="0"
          :aria-selected="selected?.name === e.name"
          :class="{ dir: e.isDirectory, sel: selected?.name === e.name }"
          @click="activate(e)"
          @keydown.enter.prevent="activate(e)"
          @keydown.space.prevent="activate(e)"
        >
          <span class="icon">{{ e.isDirectory ? "📁" : e.isSymlink ? "🔗" : "📄" }}</span>
          <span class="name">{{ displayName(e.name) }}</span>
          <span class="size">{{ sizeText(e) }}</span>
          <span class="when">{{ whenText(e) }}</span>
        </li>
        <li v-if="entries.length === 0 && currentNode.state === 'loaded'" class="empty">
          （空のフォルダ）
        </li>
      </ul>

      <section class="preview">
        <template v-if="preview.state.value">
          <p class="path">{{ displayName(preview.state.value.path) }}</p>

          <!--
            採用した文字コードと根拠を常に見せる。**推定が外れたときに直せることが要**——
            タグは中身を説明していないことがある（UTF-8 の内容に CCSID 850）ので、
            復号できたときも・できなかったときも選び直せるようにする
          -->
          <p v-if="preview.state.value.kind === 'text'" class="encoding">
            <span class="tv">{{ encodingNote }}</span>
            <select
              :value="chosenCcsid ?? ''"
              :disabled="disabled"
              aria-label="文字コード"
              @change="changeCcsid($event.target as HTMLSelectElement)"
            >
              <option value="" disabled>文字コードを選ぶ</option>
              <option v-for="c in TEXT_CCSIDS" :key="c.ccsid" :value="c.ccsid">
                {{ c.label }}{{ c.writable ? "" : "（読み取りのみ）" }}
              </option>
            </select>
          </p>

          <!--
            読み直しの失敗はここに出す。**本文を消さずにエラーだけ足す**——
            下の `v-else-if` は「表示するものが何も無い」場合の枠なので、
            選び直しに失敗しただけのときは通らない
          -->
          <p v-if="preview.error.value" class="error">{{ preview.error.value }}</p>

          <!-- 復号できないのはエラーではない。読み取りは成功していて表示手段が無いだけ -->
          <p v-if="preview.state.value.undecodable" class="note">
            この文字コードでは読めませんでした。上の一覧から選び直すか、ダウンロードして開いてください。
          </p>
          <p v-else-if="!writable" class="note">
            この文字コードは読み取り専用です（保存はできません）。
          </p>
          <!-- UTF-8 で読めたテキストは編集できる。読めなかったものは上の undecodable 分岐 -->
          <textarea
            v-if="preview.state.value.kind === 'text' && !preview.state.value.undecodable"
            v-model="editText"
            class="editor"
            spellcheck="false"
            :readonly="!writable"
            :aria-label="`${selected?.name ?? 'ファイル'} の内容`"
          />
          <p v-if="preview.state.value.kind === 'text' && dirty" class="note">
            編集中（保存すると上書きします）
          </p>
          <!--
            **この 3 つは `kind` だけで分岐させる。** 直前の「編集中」の note に
            v-else で繋ぐと、テキストを編集していないときに最後の v-else が真になり、
            表示できているテキストの下に「プレビューできません」が出る
          -->
          <iframe
            v-if="preview.state.value.kind === 'pdf'"
            :src="preview.state.value.url"
            title="PDF プレビュー"
          />
          <img
            v-else-if="preview.state.value.kind === 'image'"
            :src="preview.state.value.url"
            alt="画像プレビュー"
          />
          <p v-else-if="preview.state.value.kind === 'binary'" class="note">
            この形式はプレビューできません。ダウンロードしてください。
          </p>

        </template>
        <p v-else-if="preview.error.value" class="error">{{ preview.error.value }}</p>
        <p v-else class="note">ファイルを選ぶと内容を表示します。</p>

        <!--
          操作は**選択**に紐づける。プレビューに失敗しても消してはいけない——
          「大きすぎるのでダウンロードしてください」と言われた直後に
          ダウンロード手段が消えるのは筋が通らない
        -->
        <div v-if="selected" class="actions">
          <button v-if="dirty" :disabled="disabled" @click="saveText">保存</button>
          <button :disabled="disabled" @click="downloadSelected">ダウンロード</button>
          <button class="danger" :disabled="disabled" @click="removeSelected">削除</button>
        </div>
      </section>
    </div>

    <footer>
      <button v-if="hasMore" :disabled="disabled" @click="tree.loadMore(currentPath)">
        続きを読み込む
      </button>
      <!-- 辿る手段が無い場所。「まだあるが取れない」ことを隠さない -->
      <span v-else-if="blocked" class="note">
        この場所は先頭 {{ entries.length }} 件までしか取得できません
      </span>
    </footer>
  </div>
</template>

<style scoped>
.ifs {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  color: var(--ink);
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}
.crumbs {
  display: flex;
  gap: 2px;
  flex: 1;
  overflow-x: auto;
}
.hidden-input {
  /* display:none だとフォーカスも当たらないので、視覚的にだけ隠す */
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.crumb {
  border: none;
  background: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0 2px;
}
.tree {
  width: 220px;
  min-width: 140px;
  overflow: auto;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}
.tree-row {
  display: flex;
  gap: 2px;
  align-items: center;
  padding: 2px 4px;
  white-space: nowrap;
}
.tree-row .caret,
.tree-row .tree-name {
  border: none;
  background: none;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  padding: 0;
}
.tree-row .caret:disabled {
  cursor: default;
}
.tree-row .tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-row:hover {
  background: var(--accent-soft);
}
.tree-row.sel {
  background: var(--accent-soft);
  font-weight: 600;
}
.tree-row .caret {
  color: var(--muted);
  width: 1.2em;
  flex: none;
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.body.dragging {
  outline: 2px dashed var(--accent);
  outline-offset: -4px;
}
.entries {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: auto;
  border-right: 1px solid var(--line);
}
.entries li {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 8px;
  cursor: pointer;
  /* 端末エスケープ入りの長い名前でも行を壊さない */
  white-space: nowrap;
}
.entries li:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.entries li:hover {
  background: var(--accent-soft);
}
.entries li.sel {
  background: var(--accent-soft);
  outline: 1px solid var(--accent);
}
.entries .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.entries .size,
.entries .when {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.entries .empty {
  color: var(--muted);
  cursor: default;
}
.preview {
  flex: 1;
  min-width: 0;
  padding: 8px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview .path {
  color: var(--muted);
  margin: 0;
  word-break: break-all;
}
.preview .editor {
  flex: 1;
  margin: 0;
  min-height: 200px;
  resize: none;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  font-family: ui-monospace, monospace;
  font-size: 13px;
  padding: 6px;
  white-space: pre;
  overflow: auto;
}
.preview iframe,
.preview img {
  flex: 1;
  width: 100%;
  border: 1px solid var(--line);
  background: var(--card);
  object-fit: contain;
}
.actions {
  display: flex;
  gap: 6px;
}
footer {
  padding: 4px 8px;
  border-top: 1px solid var(--line);
  min-height: 22px;
}
.note {
  color: var(--muted);
  margin: 4px 8px;
}
.error {
  color: var(--t-red);
  margin: 4px 8px;
}
</style>
