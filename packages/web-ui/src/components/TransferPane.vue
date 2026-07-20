<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { systemsStore } from "../stores/systems.js";
import { csvBlob, csvFileName, toCsv } from "../csv.js";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import LoadingBar from "./LoadingBar.vue";
import { isFileDrag } from "../dnd.js";
import { useColumnWidths } from "../composables/useColumnWidths.js";
// **root ではなく browser サブパスから取る**——root は pino と node:net/node:tls を巻き込み、
// バンドラが node 組み込みを externalize して実行時に落ちる（AGENTS.md）
import { isValidIdentifier, parseCsv } from "@as400web/core/browser";

/**
 * データ転送（表 ⇄ CSV）。ACS の **Data Transfer** に相当する。
 *
 * SQL ペイン（`sql:query`）は ACS の **Run SQL Scripts** の位置づけで据え置き、
 * こちらは「SQL を書かずに表とファイルをやりとりする」道具にする（`decisions.md` D1）。
 * 取得と取り込みは**同じアプリの 2 方向**として扱う。
 *
 * ⚠ **取り込みは巻き戻せない**（DDM にコミットメント制御が無い）。
 * よって「完了」と「部分完了」を別の状態として見せる——利用者が次に取る行動が違うため。
 */
defineProps<{ tabId: string }>();

/** IBM i のオブジェクト名。**判定の実体は core にあり、サーバーと同じものを使う** */
const validName = isValidIdentifier;

type Direction = "download" | "upload";
const direction = ref<Direction>("upload");

const library = ref("");
const file = ref("");
const where = ref("");
const emptyAsNull = ref(false);

const targetOk = computed(() => validName(library.value) && validName(file.value));

// ---- 取り込みの状態機械（design の状態遷移）----
type UploadPhase = "idle" | "parsing" | "parse-failed" | "preview" | "sending" | "rejected" | "done" | "partial";
const phase = ref<UploadPhase>("idle");

const fileName = ref("");
const header = ref<string[]>([]);
const rows = ref<string[][]>([]);
const parseError = ref("");
const dragging = ref(false);

/**
 * 拒否理由。**core の `UploadRejection` と対応させる**。
 * 種類を足したらここも足すこと——既定値に落ちると理由が消え、
 * 「取り込めませんでした」としか出なくなる（実ブラウザ確認で踏んだ）。
 */
interface Rejection {
  kind: string;
  columns?: string[];
  column?: string;
  row?: number;
  /** 値を詰められなかった理由（型・長さ・文字コード） */
  reason?: string;
  /** 種類が付かない失敗（接続不可など）のメッセージ */
  value?: string;
}
const rejections = ref<Rejection[]>([]);
const rejectTruncated = ref(false);
const result = ref<
  | {
      committedRows: number;
      uncertainRange?: { from: number; to: number };
      error?: string;
      batchSize: number;
      ms: number;
    }
  | undefined
>();

const { visible: slowLoading, busy: loading, run } = useDelayedLoading();

/**
 * 列幅。SQL ペインと**同じ振る舞い**にする（中身に合わせ、上限で打ち切り、ドラッグで変えられる）。
 * 取り込みのプレビューと取得の結果で別々に持つ——列の並びが別物なので、
 * 片方の幅がもう片方に効くと対応が狂う。
 */
const upCols = useColumnWidths();
const dlCols = useColumnWidths();

/**
 * 実際に使った往復数。
 *
 * **バッチ容量（`batchSize`）をそのまま出さない**——2 行の取り込みで
 * 「21844 件/往復」と出ても意味が無く、むしろ何の数字か分からない。
 * 利用者が知りたいのは「何回やりとりしたか」である。
 */
const tripsUsed = computed(() => {
  const r = result.value;
  if (!r || r.batchSize <= 0) return 0;
  return Math.max(1, Math.ceil(r.committedRows / r.batchSize));
});

/**
 * 送る前の想定往復数。**待ち時間の主因は接続（数秒）**なので、往復数だけを強調しない。
 * 実測が出るまでは既定のバッチ容量で見積もる。
 */
const estimatedTrips = computed(() =>
  rows.value.length === 0 ? 0 : Math.ceil(rows.value.length / (result.value?.batchSize ?? 1000))
);

function reset(): void {
  phase.value = "idle";
  fileName.value = "";
  header.value = [];
  rows.value = [];
  parseError.value = "";
  upCols.clear();
  rejections.value = [];
  rejectTruncated.value = false;
  result.value = undefined;
  // 取得側も一緒に捨てる。**方向を切り替えたのに前の結果が残っていると取り違える**
  downloadRows.value = [];
  downloadColumns.value = [];
  downloadError.value = "";
  dlCols.clear();
}

watch(direction, reset);

// ---- CSV を受け取る ----
function onDragOver(ev: DragEvent): void {
  // 取得モードでは CSV を受け取らない（落としても見えない状態に取り込まれてしまう）
  if (direction.value !== "upload" || !isFileDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation(); // ペイン分割のドロップゾーンへ伝えない
  dragging.value = true;
}
function onDrop(ev: DragEvent): void {
  if (direction.value !== "upload" || !isFileDrag(ev)) return;
  ev.preventDefault();
  ev.stopPropagation();
  dragging.value = false;
  const f = ev.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
}
function onPick(ev: Event): void {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) void loadFile(f);
}

async function loadFile(f: File): Promise<void> {
  reset();
  phase.value = "parsing";
  fileName.value = f.name;
  try {
    const text = await f.text();
    // 解析は core の実装を使う（web-ui と MCP で行番号の数え方をずらさない）
    const parsed = parseCsv(text);
    header.value = parsed.header;
    rows.value = parsed.rows;
    phase.value = "preview";
  } catch (e) {
    parseError.value = e instanceof Error ? e.message : String(e);
    phase.value = "parse-failed";
  }
}

// ---- 取り込み ----
async function upload(): Promise<void> {
  if (!systemsStore.selected || !targetOk.value || rows.value.length === 0) return;
  phase.value = "sending";
  rejections.value = [];
  result.value = undefined;
  await run(async () => {
    try {
      const res = await fetch("/api/host/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: { system: systemsStore.selected },
          library: library.value.trim().toUpperCase(),
          file: file.value.trim().toUpperCase(),
          columns: header.value,
          rows: rows.value,
          ...(emptyAsNull.value ? { emptyAsNull: true } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) {
        rejections.value = data.rejections ?? [];
        rejectTruncated.value = Boolean(data.truncated);
        // 拒否理由が付かない失敗（接続不可など）も「1 行も書いていない」側に寄せる
        if (rejections.value.length === 0) {
          rejections.value = [{ kind: "other", value: data.error ?? "取り込めませんでした" }];
        }
        phase.value = "rejected";
        return;
      }
      result.value = data;
      phase.value = data.uncertainRange ? "partial" : "done";
    } catch (e) {
      rejections.value = [{ kind: "other", value: e instanceof Error ? e.message : String(e) }];
      phase.value = "rejected";
    }
  });
}

// ---- 取得（SQL ペインを使わずに表を落とす）----
const downloadRows = ref<Record<string, unknown>[]>([]);
const downloadColumns = ref<string[]>([]);
const downloadError = ref("");

async function download(): Promise<void> {
  if (!systemsStore.selected || !targetOk.value) return;
  downloadError.value = "";
  downloadRows.value = [];
  await run(async () => {
    const lib = library.value.trim().toUpperCase();
    const tbl = file.value.trim().toUpperCase();
    // **SQL エディタは出さない**（design）。ここで組み立てるのは固定形だけで、
    // 利用者が書けるのは絞り込み条件のみ
    const cond = where.value.trim();
    const sql = `SELECT * FROM ${lib}.${tbl}${cond ? ` WHERE ${cond}` : ""}`;
    try {
      const res = await fetch("/api/host/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { system: systemsStore.selected }, sql, maxRows: 1000 })
      });
      const data = await res.json();
      if (!res.ok) {
        downloadError.value = data.error ?? "取得に失敗しました";
        return;
      }
      downloadColumns.value = (data.columns ?? []).map((c: { name: string }) => c.name);
      downloadRows.value = data.rows ?? [];
    } catch (e) {
      downloadError.value = e instanceof Error ? e.message : String(e);
    }
  });
}

function saveCsv(): void {
  const csv = toCsv(downloadColumns.value, downloadRows.value);
  const url = URL.createObjectURL(csvBlob(csv));
  const a = document.createElement("a");
  a.href = url;
  a.download = csvFileName();
  a.click();
  URL.revokeObjectURL(url);
}

/** 拒否理由を日本語にする。**行番号と列名は必ず出す**（どこを直すか分かるように） */
function rejectionText(r: Rejection): string {
  switch (r.kind) {
    case "column-missing":
      return `表にある列が CSV にありません: ${r.columns?.join(", ")}`;
    case "column-unknown":
      return `表に無い列が CSV にあります: ${r.columns?.join(", ")}`;
    case "value-null":
      return `空にできない列です: ${r.column}`;
    case "value-invalid":
      // **理由をそのまま出す**（型・長さ・文字コードのどれかは core が判断済み）
      return `${r.column}: ${r.reason}`;
    default:
      return r.value ?? "取り込めませんでした";
  }
}
function rejectionWhere(r: Rejection): string {
  return r.row !== undefined ? `${r.row} 行目` : "列の対応";
}
</script>

<template>
  <div class="transfer admin" tabindex="0" @dragover="onDragOver" @drop="onDrop" @dragleave="dragging = false">
    <header>
      <h2>データ転送</h2>
      <div class="seg" role="group" aria-label="転送の向き">
        <button
          type="button"
          :aria-pressed="direction === 'download'"
          @click="direction = 'download'"
        >
          ↓ 取得
        </button>
        <button type="button" :aria-pressed="direction === 'upload'" @click="direction = 'upload'">
          ↑ 取り込み
        </button>
      </div>
      <!-- placeholder に具体名を置かない。特定環境のライブラリ名・表名を書くと、
           他の利用者には意味が無く「この名前を入れるもの」と誤解させる -->
      <label>ライブラリ <input v-model="library" size="10" title="英大文字・数字・_$#@ の 1〜10 文字" /></label>
      <label>ファイル <input v-model="file" size="10" title="英大文字・数字・_$#@ の 1〜10 文字" /></label>
      <label v-if="direction === 'download'">絞り込み <input v-model="where" size="18" placeholder="ID < 100" /></label>
      <button
        v-if="direction === 'upload'"
        class="go"
        :disabled="loading || !targetOk || rows.length === 0"
        @click="upload"
      >
        {{ loading ? "取り込み中…" : "取り込む" }}
      </button>
      <button v-else class="go" :disabled="loading || !targetOk" @click="download">
        {{ loading ? "取得中…" : "取得" }}
      </button>
    </header>
    <LoadingBar v-if="slowLoading" label="ホストに接続しています（数秒かかります）…" />

    <div class="scroll">
      <!-- ===== 取り込み ===== -->
      <template v-if="direction === 'upload'">
        <div
          class="drop"
          :class="{ armed: dragging }"
          @click="($refs.picker as HTMLInputElement).click()"
        >
          <input ref="picker" type="file" accept=".csv,text/csv" hidden @change="onPick" />
          <template v-if="phase === 'idle' || phase === 'parsing'">
            <span class="big">CSV をここに落とすか、クリックして選ぶ</span>
            <span class="sub">1 行目を列名として扱います</span>
          </template>
          <template v-else>
            <span class="big">{{ fileName }}</span>
            <span class="sub">{{ rows.length }} 行 · 別のファイルを落とすと差し替わります</span>
          </template>
        </div>

        <p v-if="phase === 'parse-failed'" class="error">CSV を読めません: {{ parseError }}</p>

        <!-- 列の対応（先頭行のプレビュー） -->
        <table v-if="header.length && phase !== 'parse-failed'">
          <thead>
            <tr>
              <th class="rownum">#</th>
              <th v-for="(h, ci) in header" :key="ci" :style="upCols.widthStyle(ci)" :title="h">
                {{ h }}
                <!-- 列の右端を掴んで幅を変える。ダブルクリックで既定へ戻す -->
                <span
                  class="col-grip"
                  :class="{ dragging: upCols.resizing.value === ci }"
                  title="ドラッグで列幅を変えられます（ダブルクリックで戻す）"
                  @pointerdown="upCols.onDown($event, ci)"
                  @pointermove="upCols.onMove"
                  @pointerup="upCols.onUp"
                  @pointercancel="upCols.onUp"
                  @dblclick="upCols.reset(ci)"
                ></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows.slice(0, 5)" :key="i">
              <td class="rownum">{{ i + 1 }}</td>
              <td v-for="(v, j) in r" :key="j" :style="upCols.widthStyle(j)" :title="v ?? ''">{{ v }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="rows.length > 5" class="muted">ほか {{ rows.length - 5 }} 行</p>

        <label v-if="phase === 'preview'" class="opt">
          <input v-model="emptyAsNull" type="checkbox" /> 空欄を NULL として扱う
        </label>

        <!-- 拒否（1 行も書いていない） -->
        <div v-if="phase === 'rejected'" class="result bad">
          <h3>取り込みませんでした — 1 行も書いていません</h3>
          <ul>
            <li v-for="(r, i) in rejections" :key="i">
              <span class="where">{{ rejectionWhere(r) }}</span>
              <span>{{ rejectionText(r) }}</span>
            </li>
          </ul>
          <p v-if="rejectTruncated" class="muted">先頭 100 件まで表示しています</p>
        </div>

        <!-- 完了 -->
        <div v-if="phase === 'done' && result" class="result ok">
          <h3>{{ result.committedRows }} 行を取り込みました</h3>
          <p class="muted">{{ tripsUsed }} 往復 · {{ result.ms }}ms</p>
        </div>

        <!-- 部分完了。**完了と同じ見せ方にしない**（次に取る行動が違う） -->
        <div v-if="phase === 'partial' && result" class="result warn">
          <h3>途中で失敗しました — 書き込みは取り消せません</h3>
          <ul>
            <li>
              <span class="where">確定</span>
              <span v-if="result.committedRows > 0">
                1 〜 {{ result.committedRows }} 行目は書き込まれました
              </span>
              <span v-else>確実に書き込まれた行はありません</span>
            </li>
            <li>
              <span class="where">不明</span>
              <span>
                {{ result.uncertainRange!.from }} 〜 {{ result.uncertainRange!.to }} 行目は
                書けたかどうか分かりません
              </span>
            </li>
          </ul>
          <p v-if="result.error" class="muted">理由: {{ result.error }}</p>
          <p class="muted">再実行する前に、対象の表で該当行を確認してください。</p>
        </div>
      </template>

      <!-- ===== 取得 ===== -->
      <template v-else>
        <p v-if="downloadError" class="error">{{ downloadError }}</p>
        <table v-if="downloadRows.length">
          <thead>
            <tr>
              <th class="rownum">#</th>
              <th v-for="(c, ci) in downloadColumns" :key="ci" :style="dlCols.widthStyle(ci)" :title="c">
                {{ c }}
                <span
                  class="col-grip"
                  :class="{ dragging: dlCols.resizing.value === ci }"
                  title="ドラッグで列幅を変えられます（ダブルクリックで戻す）"
                  @pointerdown="dlCols.onDown($event, ci)"
                  @pointermove="dlCols.onMove"
                  @pointerup="dlCols.onUp"
                  @pointercancel="dlCols.onUp"
                  @dblclick="dlCols.reset(ci)"
                ></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in downloadRows" :key="i">
              <td class="rownum">{{ i + 1 }}</td>
              <td
                v-for="(c, ci) in downloadColumns"
                :key="ci"
                :style="dlCols.widthStyle(ci)"
                :title="String(r[c] ?? '')"
              >
                {{ r[c] }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="!loading" class="muted">
          ライブラリとファイルを指定して「取得」を押してください。取得できる範囲は IBM i の権限によります。
        </p>
      </template>
    </div>

    <footer class="statusbar">
      <span v-if="direction === 'upload' && rows.length">
        {{ rows.length }} 行 · 想定 {{ estimatedTrips }} 往復
      </span>
      <span v-else-if="direction === 'download' && downloadRows.length">
        {{ downloadRows.length }} 行
      </span>
      <span v-else class="muted">未選択</span>
      <span class="spacer"></span>
      <button
        v-if="direction === 'download' && downloadRows.length"
        class="save"
        @click="saveCsv"
      >
        CSV を保存
      </button>
    </footer>
  </div>
</template>

<style scoped>
/* ペイン自体はスクロールさせない。スクロールは .scroll の中だけ（docs/UI-DESIGN.md） */
.transfer {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding: 12px;
  font-size: 13px;
}
.scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; flex: none; }
h2 { margin: 0; font-size: 13px; font-family: var(--mono); font-weight: 700; }
label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }
input[type="text"], input:not([type]) {
  padding: 4px 8px; border: 1px solid var(--line); border-radius: 5px;
  background: var(--bg); color: var(--ink); font-family: var(--mono); font-size: 12px;
}
.go { font-size: 12px; padding: 4px 12px; border: 1px solid var(--accent); border-radius: 5px;
  background: var(--accent); color: #fff; cursor: pointer; font-weight: 650; }
.go:disabled { opacity: 0.5; cursor: default; }

/* 方向切替。**このペインの中心的な操作**なので、他の入力より目立たせる */
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.seg button {
  border: none; background: none; color: var(--muted); cursor: pointer;
  padding: 5px 12px; font-family: var(--mono); font-size: 12px;
}
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }

.drop {
  border: 1px dashed var(--line); border-radius: 8px; padding: 22px 16px;
  text-align: center; color: var(--muted); display: flex; flex-direction: column; gap: 5px;
  cursor: pointer; margin-bottom: 10px;
}
.drop.armed { border-color: var(--accent); border-style: solid; background: var(--accent-soft); color: var(--accent); }
.drop .big { font-size: 14px; color: var(--ink); font-weight: 620; }
.drop.armed .big { color: var(--accent); }
.drop .sub { font-size: 12px; }

/* **中身の幅にする**（`100%` だと列が引き伸ばされ、上限も打ち切りも意味を失う）。
   SQL ペインと同じ */
table { border-collapse: collapse; width: auto; table-layout: auto; }
/* **中身に合わせた幅＋上限で打ち切り**（SQL ペインと同じ）。
   手でドラッグしたぶんは widthStyle が max-width ごと上書きするので、
   広げれば隠れていた文字が見える */
th, td {
  border-bottom: 1px solid var(--line);
  padding: 5px 8px;
  text-align: left;
  font-size: 12.5px;
  white-space: nowrap;
  /* **際限なく伸ばさない**。長い値の 1 列で表が使えなくなるため、
     40 文字ぶんで打ち切って「…」を出す（全文は title で読める） */
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 列見出しは固定する（docs/UI-DESIGN.md）。border-collapse では罫線が流れるので box-shadow */
th {
  color: var(--muted); font-weight: 600; font-size: 11px; font-family: var(--mono);
  position: sticky; top: 0; z-index: 1; background: var(--card);
  border-bottom: none; box-shadow: inset 0 -1px 0 var(--line);
}
/* 列の右端の掴み手。**sticky な th 自体が絶対配置の基準になる**ので追加指定は要らない。
   見出しは overflow: hidden なので、はみ出させると掴み手が切れる */
.col-grip {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  z-index: 2;
}
.col-grip::after {
  content: "";
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: 2px;
  background: transparent;
}
.col-grip.dragging::after { background: var(--accent); }
.rownum { color: var(--muted); font-family: var(--mono); text-align: right; }

.opt { margin: 8px 0; }
.muted { color: var(--muted); font-size: 12px; }
.error { color: #c62828; }

.result {
  border: 1px solid var(--line); border-left-width: 3px; border-radius: 6px;
  padding: 10px 12px; margin-top: 10px; display: flex; flex-direction: column; gap: 6px;
}
.result.bad { border-left-color: #c62828; }
.result.warn { border-left-color: var(--t-yellow, #9a6b00); }
.result.ok { border-left-color: var(--accent); }
.result h3 { margin: 0; font-size: 13px; }
.result ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.result li { display: flex; gap: 8px; font-family: var(--mono); font-size: 12px; }
.result .where { color: var(--muted); min-width: 9ch; }

.statusbar {
  flex: none; display: flex; gap: 8px; align-items: center; padding: 4px 8px;
  border-top: 1px solid var(--line); font-size: 12px; font-family: var(--mono); color: var(--muted);
}
.statusbar .spacer { flex: 1; }
.save { font-size: 12px; padding: 2px 10px; border: 1px solid var(--line); border-radius: 5px;
  background: none; color: var(--ink); cursor: pointer; font-family: inherit; }
</style>
