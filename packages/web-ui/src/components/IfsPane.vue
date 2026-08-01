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
  deletePlan,
  download,
  fetchLimits,
  makeDirectory,
  renamePath,
  uploadTree,
  writeFile,
  zipFolder,
  type IfsEntry,
  type IfsLimits,
  type IfsUploadEntry
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
/**
 * サーバーの実効上限。**取れなくても機能は落とさない**——
 * 先回り判定（読む前に大きすぎると断る）が効かなくなるだけで、
 * サーバーの 413 が最後の砦として残る。付随機能の失敗で主機能を止めない。
 */
const limits = ref<IfsLimits | undefined>(undefined);
void fetchLimits().then(
  (l) => {
    limits.value = l;
  },
  () => {
    // 握る。エラー表示もしない（利用者に打つ手が無く、実害も無い）
  }
);
const preview = usePreview(source, () => limits.value);
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

/**
 * 1 つ上のフォルダ。ルートでは `undefined`（＝一覧に「上位へ」を出さない）。
 *
 * ホストの一覧に来る `..` は core が落としている（`ifs-connection.ts` の `.`/`..` 除外）ので、
 * **ここで UI の行として足す**。追加の往復は発生しない。
 */
const parentPath = computed(() => {
  if (currentPath.value === ROOT) return undefined;
  const at = currentPath.value.lastIndexOf("/");
  return at <= 0 ? ROOT : currentPath.value.slice(0, at);
});

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
/** バイト数を MB 表記に。`ifsApi` のエラー文言と同じ書き方に揃える */
function mbOf(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 中身を見せられる状態のプレビューだけを返す。
 *
 * **上限超過で読みに行かなかったとき（`tooLarge`）は本文の枠を出さない**——
 * `kind` は保ってあるので、素直に描くと空の編集欄や `src=""` の iframe が出る。
 * 「大きすぎて読んでいない」と「読んだが空だった」を見た目で区別できなくなる。
 */
const body = computed(() =>
  preview.state.value && !preview.state.value.tooLarge ? preview.state.value : undefined
);

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

/**
 * フォルダを**開かずに選ぶ**（行の「…」から）。
 *
 * クリック＝開く、は日常の移動で使うので変えない。一方でフォルダの削除・改名には
 * 「選択されたフォルダ」が要る——そこだけを別の入口（行末の小さなボタン）で満たす。
 */
function selectEntry(entry: IfsEntry): void {
  message.value = "";
  actionError.value = "";
  selected.value = entry;
  // フォルダの中身はプレビューの対象ではない。前のファイルの表示を残さない
  preview.clear();
}

/**
 * 削除。**フォルダも消せる**（種別の判定はサーバー側。research F4）。
 *
 * フォルダは**消える件数を先に数えてから**確認する——「中身ごと」を押す前に規模が分からないと、
 * 取り返しのつかない操作を目をつぶって押すことになる。上限超過・辿り切れない場合は
 * サーバーが 1 件も消さないので、ここでは案内だけ出す。
 */
async function removeSelected(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  const path = joined(entry.name);

  if (!entry.isDirectory) {
    if (!window.confirm(`${entry.name} を削除します。よろしいですか？`)) return;
    await withAction("削除", async () => {
      await deleteFile(source(), path);
      await afterDelete(entry.name);
    });
    return;
  }

  // フォルダ: まず数える（この呼び出しでは何も消えない）
  let plan;
  try {
    plan = await run(async () => await deletePlan(source(), path));
  } catch (e) {
    actionError.value = e instanceof IfsRequestError ? e.message : `削除に失敗しました: ${String(e)}`;
    return;
  }
  if (plan.blocked !== undefined) {
    actionError.value =
      plan.blocked === "too-many"
        ? `${entry.name} の中身が多すぎます（${plan.entries ?? "?"} 件以上 / 上限 ${plan.max ?? "?"} 件）。中を分けて削除してください。`
        : `${entry.name} のフォルダ数が多すぎます（上限 ${plan.max ?? "?"}）。中を分けて削除してください。`;
    return;
  }
  const inside = (plan.files ?? 0) + Math.max((plan.directories ?? 1) - 1, 0);
  const ask =
    inside === 0
      ? `${entry.name}（空のフォルダ）を削除します。よろしいですか？`
      : `${entry.name} を中身ごと削除します。ファイル ${plan.files ?? 0} 件・フォルダ ${Math.max((plan.directories ?? 1) - 1, 0)} 件が消えます。よろしいですか？`;
  if (!window.confirm(ask)) return;
  await withAction("削除", async () => {
    const done = await deleteFile(source(), path, { recursive: inside > 0 });
    await afterDelete(entry.name, done);
  });
}

/** 消した後の後始末。選択・プレビュー・一覧・ツリーが消えたものを指したままにしない */
async function afterDelete(
  name: string,
  done?: { files: number; directories: number }
): Promise<void> {
  message.value =
    done && done.files + done.directories > 1
      ? `${name} を削除しました（ファイル ${done.files} 件・フォルダ ${done.directories} 件）`
      : `${name} を削除しました`;
  selected.value = undefined;
  preview.clear();
  await tree.refresh(currentPath.value);
}

/**
 * 改名。**同じフォルダ内の名前だけ**を変える（移動は対象外）。
 * `/` を含む入力はサーバーも 400 で断るが、往復させる前にここで弾く。
 */
async function renameSelected(): Promise<void> {
  const entry = selected.value;
  if (!entry) return;
  const input = window.prompt(`${entry.name} の新しい名前`, entry.name);
  if (input === null) return;
  const newName = input.trim();
  if (newName === "" || newName === entry.name) return;
  if (newName.includes("/")) {
    actionError.value = "名前にパス区切り（/）は使えません。";
    return;
  }
  await withAction("名前の変更", async () => {
    await renamePath(source(), joined(entry.name), newName);
    message.value = `${entry.name} を ${newName} に変更しました`;
    // 表示中のものが指す先を新しい名前に付け替える（古い名前を選んだままにしない）
    selected.value = undefined;
    preview.clear();
    await tree.refresh(currentPath.value);
  });
}

const uploading = ref(false);
const fileInput = ref<HTMLInputElement | undefined>(undefined);
const folderInput = ref<HTMLInputElement | undefined>(undefined);

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
 * フォルダを選んだとき。**ファイル用の `<input>` と共用できない**——
 * `webkitdirectory` を付けた入力はフォルダしか選べなくなるので、入口を 2 つ持つ。
 *
 * ブラウザは選んだフォルダ配下のファイルを平坦に渡し、階層は `webkitRelativePath`
 * （`TOPDIR/sub/a.txt`）で表す。**空のフォルダは 1 件も来ない**ので、この経路では作られない
 * （ドラッグ＆ドロップは `webkitGetAsEntry` で辿るため空でも作れる）。
 */
function onPickFolder(input: HTMLInputElement): void {
  const files = Array.from(input.files ?? []);
  input.value = "";
  void uploadPicked(
    files.map((file) => ({ path: file.webkitRelativePath || file.name, file })),
    []
  );
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

/** 置くもの 1 件。`path` は置き先からの相対（フォルダなら `TOP/sub/a.txt`） */
interface PickedFile {
  path: string;
  file: File;
}

/**
 * ファイルだけを現在地へ置く（従来の入口）。テストからも直接叩かれる。
 *
 * フォルダの階層は付かないので、相対パス＝ファイル名になる。
 */
async function uploadFiles(files: readonly File[] | FileList | null): Promise<void> {
  if (!files) return;
  await uploadPicked(
    Array.from(files).map((file) => ({ path: file.name, file })),
    []
  );
}

/**
 * まとめて置く。**ファイルもフォルダもここに集約する。**
 *
 * サーバーへは 1 要求で渡す（`uploadTree`）——IFS は要求ごとに接続・認証するので、
 * ファイルごとに投げると実機で 1 件 4.5 秒かかり、フォルダの投入が終わらない。
 *
 * @param picked 置くファイル（相対パス付き）
 * @param dirs 空でも作りたいフォルダの相対パス（ドロップで辿ったときだけ埋まる）
 */
async function uploadPicked(picked: readonly PickedFile[], dirs: readonly string[]): Promise<void> {
  if (picked.length === 0 && dirs.length === 0) return;
  if (uploading.value) return; // 二重起動を入口で止める（ドロップの連打）
  // **開始時のコンテキストを固定する。** 送信中にシステムを切り替えられても、
  // 結果を今の画面へ反映しないため。watch は「見えているものを捨てる」だけで操作は止めない
  const src = source();
  const dir = currentPath.value;
  uploading.value = true;
  actionError.value = "";
  message.value = "";
  try {
    // フォルダを含むか。含むなら**まとめて 1 回だけ確認する**——
    // 木の中の同名ファイルを 1 つずつ聞くと、深い木で確認が止まらなくなる
    const tree1 = dirs.length > 0 || picked.some((p) => p.path.includes("/"));
    let files = [...picked];
    if (tree1) {
      const tops = new Set(
        [...picked.map((p) => p.path), ...dirs].map((p) => p.split("/")[0] ?? p)
      );
      const ok = window.confirm(
        `${[...tops].join("・")} を ${files.length} ファイル置きます。同じ名前のファイルは上書きされます。よろしいですか？`
      );
      if (!ok) return;
    } else if (!listingComplete.value) {
      // 一覧が読み切れていないときは、ファイルごとではなく **1 回だけ**まとめて聞く
      const ok = window.confirm(
        `このフォルダは一覧を最後まで読めていません。既存の同名ファイルを上書きする可能性があります。${files.length} 件を置きますか？`
      );
      if (!ok) return;
    } else {
      // 一覧が読めているときだけ、個別に上書き確認する
      files = files.filter(
        (p) => !existsHere(p.path) || window.confirm(`${p.path} は既にあります。上書きしますか？`)
      );
      if (files.length === 0) return;
    }

    // フォルダは**中間も含めて**作る。`a/b/c.txt` は a と a/b が要る
    const needDirs = new Set<string>(dirs);
    for (const p of files) {
      const parts = p.path.split("/");
      for (let i = 1; i < parts.length; i++) needDirs.add(parts.slice(0, i).join("/"));
    }

    const entries: IfsUploadEntry[] = [...needDirs].map((path) => ({ kind: "directory", path }));
    for (const p of files) {
      const buf = new Uint8Array(await p.file.arrayBuffer());
      entries.push({ kind: "file", path: p.path, content: toBase64(buf) });
    }

    const result = await uploadTree(src, dir, entries);
    // 切り替えられていたら、その旨を伝えて今の画面は触らない
    if (source().system !== src.system) {
      actionError.value = "システムを切り替えたため、アップロードの結果は反映していません";
      return;
    }
    if (result.files > 0 || result.directories > 0) {
      message.value =
        result.directories > 0
          ? `${result.files} 件置きました（フォルダ ${result.directories} 件）`
          : `${result.files} 件置きました: ${files.map((p) => p.path).join(", ")}`;
    }
    // **1 件の失敗を全体の成功で消さない。** どれが落ちたかまで伝える
    if (result.failed.length > 0) {
      actionError.value = `${result.failed.length} 件失敗: ${result.failed
        .map((f) => `${f.path}（${f.error}）`)
        .join(" / ")}`;
    }
    await tree.refresh(dir);
  } catch (e) {
    actionError.value =
      e instanceof IfsRequestError ? e.message : `アップロードに失敗しました: ${String(e)}`;
  } finally {
    uploading.value = false;
  }
}

/**
 * ドロップされた項目を辿って、ファイルと（空も含む）フォルダを集める。
 *
 * **`readEntries` は一度に最大 100 件しか返さない**（仕様）。空が返るまで繰り返さないと、
 * 100 件を超えるフォルダが静かに途中までしか上がらない。
 */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { files: PickedFile[]; dirs: string[] }
): Promise<void> {
  const path = `${prefix}${entry.name}`;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    }).catch(() => undefined);
    if (file) out.files.push({ path, file });
    return;
  }
  if (!entry.isDirectory) return;
  out.dirs.push(path);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    }).catch(() => [] as FileSystemEntry[]);
    if (batch.length === 0) break;
    for (const child of batch) await walkEntry(child, `${path}/`, out);
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
  if (disabled.value) return; // 通信中は受け付けない（uploadPicked 側でも二重起動は止まる）
  // **`items` は同期で読み切る。** await を挟むと DataTransfer が無効化され、
  // `webkitGetAsEntry()` が null を返す（フォルダのドロップが静かにファイル 0 件になる）
  const roots = Array.from(ev.dataTransfer?.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  const plain = Array.from(ev.dataTransfer?.files ?? []);
  if (roots.length === 0) {
    // `webkitGetAsEntry` が無い環境。**フォルダかどうか見分けられない**ので、
    // 従来どおり size 0 / 種別なしを「フォルダ」として断る（空ファイルも巻き込むが、
    // 中身の無い木を黙って作るよりまし）
    const files = plain.filter((f) => !(f.size === 0 && f.type === ""));
    if (files.length < plain.length) {
      actionError.value = "この環境ではフォルダをドロップできません。「フォルダ」から選んでください";
    }
    void uploadFiles(files);
    return;
  }
  void (async () => {
    const out: { files: PickedFile[]; dirs: string[] } = { files: [], dirs: [] };
    for (const root of roots) await walkEntry(root, "", out);
    await uploadPicked(out.files, out.dirs);
  })();
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
defineExpose({ uploadFiles, uploadPicked });

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
      <!--
        フォルダは**別の入力**が要る。`webkitdirectory` を付けた input は
        フォルダしか選べなくなるので、ファイル用と共用できない
      -->
      <button :disabled="disabled" @click="folderInput?.click()">フォルダをアップロード</button>
      <input
        ref="folderInput"
        type="file"
        webkitdirectory
        multiple
        class="hidden-input"
        aria-label="フォルダを選ぶ"
        @change="onPickFolder(($event.target as HTMLInputElement))"
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

      <!--
        **listbox ではなく list**。行は「開く / プレビューする」というコマンドで、
        フォルダ行には操作ボタン（…）が入る——ARIA の option は操作可能な子孫を持てないため、
        option のままだとボタンが支援技術に伝わらない。選択中は `aria-current` で示す
      -->
      <ul class="entries" role="list">
        <!--
          先頭の「上位フォルダへ」。**ルートでは出さない**（押せない行を残さない）。
          フォルダ行と同じ操作（クリック / Enter / Space）で動くが、
          **選択状態にはしない**——プレビューや削除の対象ではないため
        -->
        <li
          v-if="parentPath !== undefined"
          class="up"
          role="listitem"
          tabindex="0"
          @click="openPath(parentPath)"
          @keydown.enter.prevent="openPath(parentPath)"
          @keydown.space.prevent="openPath(parentPath)"
        >
          <span class="icon">↩</span>
          <span class="name">.. 上位フォルダへ</span>
          <span class="size"></span>
          <span class="when"></span>
        </li>
        <li
          v-for="e in entries"
          :key="e.name"
          role="listitem"
          tabindex="0"
          :aria-current="selected?.name === e.name ? 'true' : undefined"
          :class="{ dir: e.isDirectory, sel: selected?.name === e.name }"
          @click="activate(e)"
          @keydown.enter.prevent="activate(e)"
          @keydown.space.prevent="activate(e)"
        >
          <span class="icon">{{ e.isDirectory ? "📁" : e.isSymlink ? "🔗" : "📄" }}</span>
          <span class="name">{{ displayName(e.name) }}</span>
          <span class="size">{{ sizeText(e) }}</span>
          <span class="when">{{ whenText(e) }}</span>
          <!--
            フォルダを**開かずに選ぶ**入口。クリック＝開く（移動）は毎日使う操作なので変えず、
            削除・改名に要る「選択」だけをここで足す。`@click.stop` が無いと行の移動が同時に走る
          -->
          <button
            v-if="e.isDirectory"
            class="pick"
            :aria-label="`${e.name} を選択`"
            :title="`${e.name} を選択（削除・名前の変更）`"
            @click.stop="selectEntry(e)"
            @keydown.enter.stop.prevent="selectEntry(e)"
            @keydown.space.stop.prevent="selectEntry(e)"
          >
            …
          </button>
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
          <!--
            読みに行かずに断ったとき。**上限も一緒に出す**——超過値だけでは
            「どこまでなら通るか」が分からず、対象を分ける当てが付かない。
            ダウンロード（右の操作）は使えるので、中身を得る道は残っている
          -->
          <p v-if="preview.state.value.tooLarge" class="note">
            大きすぎるため表示していません（{{ mbOf(preview.state.value.bytes) }} / 上限
            {{ mbOf(preview.state.value.maxBytes ?? 0) }}）。ダウンロードして開いてください。
          </p>

          <p v-if="body?.kind === 'text'" class="encoding">
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
          <p v-if="body?.undecodable" class="note">
            この文字コードでは読めませんでした。上の一覧から選び直すか、ダウンロードして開いてください。
          </p>
          <p v-else-if="body && !writable" class="note">
            この文字コードは読み取り専用です（保存はできません）。
          </p>
          <!--
            **文字コードの問題と混同させない。** 拡張子はテキストでも中身にヌルバイトがあれば
            そもそもテキストではない。`undecodable` の案内を出すと、利用者は当たらない
            文字コードを選び直し続けることになる
          -->
          <p v-if="body?.binaryContent" class="note">
            テキストとして開きましたが、中身にバイナリが含まれています。ダウンロードして開いてください。
          </p>
          <!-- UTF-8 で読めたテキストは編集できる。読めなかったものは上の undecodable 分岐 -->
          <textarea
            v-if="body?.kind === 'text' && !body.undecodable"
            v-model="editText"
            class="editor"
            spellcheck="false"
            :readonly="!writable"
            :aria-label="`${selected?.name ?? 'ファイル'} の内容`"
          />
          <p v-if="body?.kind === 'text' && dirty" class="note">
            編集中（保存すると上書きします）
          </p>
          <!--
            **この 3 つは `kind` だけで分岐させる。** 直前の「編集中」の note に
            v-else で繋ぐと、テキストを編集していないときに最後の v-else が真になり、
            表示できているテキストの下に「プレビューできません」が出る
          -->
          <iframe v-if="body?.kind === 'pdf'" :src="body.url" title="PDF プレビュー" />
          <img v-else-if="body?.kind === 'image'" :src="body.url" alt="画像プレビュー" />
          <p v-else-if="body?.kind === 'binary'" class="note">
            この形式はプレビューできません。ダウンロードしてください。
          </p>

        </template>
        <p v-else-if="preview.error.value" class="error">{{ preview.error.value }}</p>
        <template v-else-if="selected?.isDirectory">
          <p class="path">{{ displayName(selected.name) }}</p>
          <p class="note">フォルダを選択中です。名前の変更・削除ができます。</p>
        </template>
        <p v-else class="note">ファイルを選ぶと内容を表示します。</p>

        <!--
          操作は**選択**に紐づける。プレビューに失敗しても消してはいけない——
          「大きすぎるのでダウンロードしてください」と言われた直後に
          ダウンロード手段が消えるのは筋が通らない
        -->
        <div v-if="selected" class="actions">
          <button v-if="dirty" :disabled="disabled" @click="saveText">保存</button>
          <button v-if="!selected.isDirectory" :disabled="disabled" @click="downloadSelected">
            ダウンロード
          </button>
          <button :disabled="disabled" @click="renameSelected">名前の変更</button>
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
/* 行末の「選択」ボタン。**行を開く操作の邪魔をしない**よう、幅も色も控えめにする */
.entries .pick {
  border: 1px solid transparent;
  background: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 6px;
  line-height: 1;
  border-radius: 4px;
}
.entries li:hover .pick,
.entries .pick:focus-visible {
  border-color: var(--border);
  color: var(--fg);
}
/* 上位フォルダへの行。中身の一覧とは種類が違うので控えめにする */
.entries li.up .name {
  color: var(--muted);
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
