<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { systemsStore } from "../stores/systems.js";
import LoadingBar from "./LoadingBar.vue";
import PaneSplitter from "./PaneSplitter.vue";
import { usePaneSplit } from "../composables/usePaneSplit.js";
import { useDelayedLoading } from "../composables/useDelayedLoading.js";
import { useColumnWidths } from "../composables/useColumnWidths.js";

/**
 * pull 型スプールのペイン（`spool:files`）。
 *
 * **プリンターペイン（push 型）とは別物**——あちらはプリンターセッションを開いている間に
 * 受信した帳票を見るもので、過去のスプールは持っていない。こちらは任意の出力待ち行列から
 * **既存の**スプールを検索して中身を取る。両者を同じペインに混ぜないのは、
 * 接続要件も取得経路も違うのに「同じもの」と誤解させないため（spec 方針4）。
 *
 * 構成は「一覧 → 選択 → 中身」の 2 段。一覧はコマンドサーバー、中身はネットワーク印刷
 * サーバー経由だが、その非対称はサーバー側（host-spools.ts）が吸収するのでここでは見えない。
 */
defineProps<{ tabId: string }>();

/** 一覧の 1 行（サーバーの SpoolEntry と対） */
interface SpoolRow {
  jobName: string;
  jobUser: string;
  jobNumber: string;
  fileName: string;
  fileNumber: number;
  outputQueue: string;
  outputQueueLibrary: string;
  status: string;
  totalPages: number;
  userData: string;
  formType: string;
  dateOpened: string;
  timeOpened: string;
  size: number;
}
interface LogicalPage {
  rows: number;
  cols: number;
  lines: string[];
}

const rows = ref<SpoolRow[]>([]);
/**
 * 上限で切られたか。**総件数は出せない**——ホスト側（QGYOLSPL）が返す「総件数」は
 * 実際には返した件数と同値で、一致総数ではないため（実機で確認）。
 * よって「1234 件中」ではなく「先頭 N 件のみ」と断る。
 */
const truncated = ref(false);
const { visible: slowLoading, busy: loading, run } = useDelayedLoading();
const error = ref("");

// 選択中スプールの中身
const selected = ref<SpoolRow | undefined>();
const pages = ref<LogicalPage[]>([]);
const { busy: contentLoading, run: runContent } = useDelayedLoading();
const contentError = ref("");

/**
 * 進行中の要求を識別する通し番号。**古い応答に新しい表示を上書きさせないため**。
 *
 * 一覧も中身も毎回ホストへ新規接続する（秒単位かかる）ので、続けて操作すると
 * 応答が逆順で返りうる。素朴に書くと「見出しは B なのに本文は A」という、
 * 別のスプールの中身を別のファイル名で見せる状態になる——しかもエラーが出ないので気づけない。
 */
let listSeq = 0;
let contentSeq = 0;

// 絞り込み（SpoolListFilter の 6 項目に 1:1 で対応）
const fUser = ref("");
const fOutq = ref("");
const fOutqLib = ref("");
const fStatus = ref("");
const fFormType = ref("");
const fUserData = ref("");

const {
  resizing: resizingCol,
  widthStyle,
  onDown: onColDown,
  onMove: onColMove,
  onUp: onColUp,
  reset: resetColWidth,
  clear: clearColWidths
} = useColumnWidths();

const COLUMNS = [
  "ファイル",
  "番号",
  "ジョブ",
  "ユーザー",
  "ジョブ番号",
  "OUTQ",
  "状態",
  "ページ",
  "作成日",
  "時刻",
  "ユーザーデータ"
] as const;

/**
 * 取得元。**選択中システムをそのまま使う**——HostListPane と同じ考え方で、
 * 接続元をこのペインで選び直す必要はない。
 */
function sourceBody(): Record<string, string> {
  return systemsStore.selected ? { system: systemsStore.selected } : {};
}

/** 空欄は送らない。core 側が未指定の項目に *ALL を補うため、空文字を渡すと絞り込んでしまう */
function filterBody(): Record<string, string> {
  const f: Record<string, string> = {};
  if (fUser.value) f["user"] = fUser.value;
  if (fOutq.value) f["outputQueue"] = fOutq.value;
  if (fOutqLib.value) f["outputQueueLibrary"] = fOutqLib.value;
  if (fStatus.value) f["status"] = fStatus.value;
  if (fFormType.value) f["formType"] = fFormType.value;
  if (fUserData.value) f["userData"] = fUserData.value;
  return f;
}

async function load(): Promise<void> {
  if (!systemsStore.selected) {
    error.value = "システムを選んでください";
    return;
  }
  error.value = "";
  selected.value = undefined;
  pages.value = [];
  contentError.value = "";
  // 列の並びは固定だが、取り直しのたびに手動幅を捨てて中身に合わせ直す
  clearColWidths();
  const seq = ++listSeq;
  await run(async () => {
    try {
      const res = await fetch("/api/host/spools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: sourceBody(), filter: filterBody() })
      });
      const data = await res.json();
      // 追い越されていたら捨てる。書き戻すと、切り替えたはずの旧システムの行が復活し、
      // その行を押すと**新しいシステムに旧システムの id を送る**ことになる
      if (seq !== listSeq) return;
      if (!res.ok) {
        error.value = data.error ?? "取得に失敗しました";
        rows.value = [];
        truncated.value = false;
        return;
      }
      rows.value = data.items ?? [];
      truncated.value = Boolean(data.truncated);
    } catch (e) {
      if (seq !== listSeq) return;
      // 失敗したら行も捨てる。残すとエラー帯の下に前回の結果が並び、
      // どちらが今の内容か分からなくなる
      rows.value = [];
      truncated.value = false;
      error.value = `取得に失敗しました: ${String(e)}`;
    }
  });
}

/**
 * 1 行のセル値。**COLUMNS と同じ並び**にすること——列幅は位置で持っているため、
 * 片方だけ足すと見出しと中身がずれる。
 */
function cellsOf(r: SpoolRow): (string | number)[] {
  return [
    r.fileName,
    r.fileNumber,
    r.jobName,
    r.jobUser,
    r.jobNumber,
    `${r.outputQueueLibrary}/${r.outputQueue}`,
    r.status,
    r.totalPages,
    r.dateOpened,
    r.timeOpened,
    r.userData
  ];
}

/** 一覧の行から、中身取得に渡す識別子（5 要素の複合キー）を作る */
function idOf(r: SpoolRow): Record<string, unknown> {
  return {
    jobName: r.jobName,
    jobUser: r.jobUser,
    jobNumber: r.jobNumber,
    fileName: r.fileName,
    fileNumber: r.fileNumber
  };
}

async function select(r: SpoolRow): Promise<void> {
  selected.value = r;
  contentError.value = "";
  pages.value = [];
  const seq = ++contentSeq;
  await runContent(async () => {
    try {
      const res = await fetch("/api/host/spool/content", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: sourceBody(), id: idOf(r) })
      });
      const data = await res.json();
      // 別の行が選ばれていたら捨てる（応答は選んだ順に返るとは限らない）
      if (seq !== contentSeq) return;
      if (!res.ok) {
        contentError.value = data.error ?? "中身を取得できませんでした";
        return;
      }
      pages.value = data.pages ?? [];
    } catch (e) {
      if (seq !== contentSeq) return;
      contentError.value = `中身を取得できませんでした: ${String(e)}`;
    }
  });
}

/**
 * 論理ページを 1 枚のテキストにする。
 * 改ページの区切りは**プリンターペインと同じ**にする——経路が違うだけで中身は同じものなので、
 * 見え方まで変えると別物に見えてしまう。
 */
const selectedText = computed(() =>
  pages.value
    .map((p) => p.lines.join("\n"))
    .join("\n" + "─".repeat(20) + " (改ページ) " + "─".repeat(20) + "\n")
);

async function downloadPdf(): Promise<void> {
  const r = selected.value;
  if (!r) return;
  contentError.value = "";
  try {
    const res = await fetch("/api/host/spool/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: sourceBody(), id: idOf(r) })
    });
    if (!res.ok) {
      // **黙って諦めない**——プリンターペインは !res.ok で無言 return しており、
      // 失敗したのかボタンが効いていないのかを利用者が区別できない
      const data = await res.json().catch(() => ({}));
      contentError.value = data.error ?? "PDF を作成できませんでした";
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${r.fileName}-${r.jobName}-${r.fileNumber}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    contentError.value = `PDF を作成できませんでした: ${String(e)}`;
  }
}

/**
 * 一覧と表示領域の分割。**SQL ペインと同じ操作**にする（境界を掴む・上下キー・最大化）。
 * 帳票は横にも縦にも長いので、表示だけを広げたい場面が多い。
 */
const split = usePaneSplit({ initial: 220, min: 80, max: 700 });

/**
 * 一覧の高さ。**v-show と :style を同じ要素へ併用しない**——v-show が付けた
 * `display: none` と :style の再適用がぶつかり、最大化を戻しても消えたままになる。
 * 表示/非表示も高さもこの 1 つの束で決める。
 */
const listStyle = computed(() => {
  if (!selected.value) return undefined;
  if (split.maximized.value) return { display: "none" };
  return { height: `${split.topHeight.value ?? 0}px`, flex: "none" };
});

onMounted(() => {
  if (systemsStore.systems.length === 0) void systemsStore.refresh();
});

/**
 * 接続先が変わったら結果を捨てる。**自動で取り直さない**——
 * 別システムに同じ条件を投げ直すのが正しいとは限らないため（HostListPane と同じ判断）。
 */
watch(
  () => systemsStore.selected,
  () => {
    // **進行中の要求を無効化してから**捨てる。番号を進めないと、
    // 飛んでいる応答が後から旧システムの行を書き戻してしまう
    listSeq++;
    contentSeq++;
    rows.value = [];
    selected.value = undefined;
    pages.value = [];
    truncated.value = false;
    error.value = "";
    contentError.value = "";
  }
);
</script>

<template>
  <div class="spool-pane admin">
    <header>
      <h2>スプール</h2>
      <label>
        ユーザー
        <input v-model="fUser" placeholder="空欄＝自分" size="10" @keyup.enter="load" />
      </label>
      <label>
        OUTQ
        <input v-model="fOutq" placeholder="*ALL" size="10" @keyup.enter="load" />
      </label>
      <label>
        ライブラリー
        <input v-model="fOutqLib" placeholder="*ALL" size="10" @keyup.enter="load" />
      </label>
      <label>
        状態
        <select v-model="fStatus">
          <option value="">すべて</option>
          <option value="*READY">READY</option>
          <option value="*HELD">HELD</option>
          <option value="*OPEN">OPEN</option>
          <option value="*CLOSED">CLOSED</option>
          <option value="*MESSAGE">MESSAGE_WAIT</option>
          <option value="*PRINTER">PRINTING</option>
        </select>
      </label>
      <label>
        帳票
        <input v-model="fFormType" placeholder="*ALL" size="8" @keyup.enter="load" />
      </label>
      <label>
        ユーザーデータ
        <input v-model="fUserData" placeholder="*ALL" size="8" @keyup.enter="load" />
      </label>
      <button :disabled="loading" @click="load">{{ loading ? "取得中…" : "取得" }}</button>
    </header>

    <LoadingBar v-if="slowLoading" label="取得しています…" />
    <p v-if="error" class="error">{{ error }}</p>
    <!-- 打ち切りは黙って隠さない。全件見たと誤解させないため必ず断る -->
    <p v-if="truncated" class="truncated">
      先頭 {{ rows.length }} 件のみ表示しています（条件を絞り込んでください）
    </p>

    <div class="scroll" :style="listStyle">
      <table v-if="rows.length > 0">
        <thead>
          <tr>
            <th v-for="(c, ci) in COLUMNS" :key="c" :style="widthStyle(ci)">
              {{ c }}
              <span
                class="col-grip"
                :class="{ dragging: resizingCol === ci }"
                title="ドラッグで列幅を変えられます（ダブルクリックで戻す）"
                @pointerdown="onColDown($event, ci)"
                @pointermove="onColMove"
                @pointerup="onColUp"
                @pointercancel="onColUp"
                @dblclick="resetColWidth(ci)"
              ></span>
            </th>
          </tr>
        </thead>
        <tbody>
          <!-- 行を選ぶと中身を取る。キーボードでも操作できるようにする（マウス専用にしない） -->
          <tr
            v-for="r in rows"
            :key="`${r.jobName}/${r.jobUser}/${r.jobNumber}/${r.fileName}/${r.fileNumber}`"
            :class="{ sel: selected === r }"
            tabindex="0"
            role="button"
            :aria-pressed="selected === r"
            @click="select(r)"
            @keydown.enter.prevent="select(r)"
            @keydown.space.prevent="select(r)"
          >
            <!-- 幅は th と td の**両方**に当てる。th だけだと max-width が既定のままで、
                 広げても隠れた文字が出てこない（useColumnWidths.ts:42-44） -->
            <td v-for="(v, ci) in cellsOf(r)" :key="ci" :style="widthStyle(ci)" :title="String(v)">
              {{ v }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!loading && !error" class="empty">
        接続を選んで「取得」を押してください（空欄の条件は絞り込みません）
      </p>
    </div>

    <PaneSplitter
      v-if="selected && !split.maximized.value"
      :split="split"
      label="一覧の高さ"
    />

    <section v-if="selected" class="viewer">
      <div class="viewer-bar">
        <strong>{{ selected.fileName }}</strong>
        <span class="muted">
          {{ selected.jobName }}/{{ selected.jobUser }}/{{ selected.jobNumber }} ・
          {{ selected.totalPages }} ページ
        </span>
        <button class="max" :title="split.maximized.value ? '一覧を出す' : '表示を最大化する'"
          @click="split.toggleMaximize()">
          {{ split.maximized.value ? "◱ 元に戻す" : "⛶ 最大化" }}
        </button>
        <button :disabled="contentLoading || pages.length === 0" @click="downloadPdf">PDF</button>
      </div>
      <p v-if="contentError" class="error">{{ contentError }}</p>
      <pre v-else-if="contentLoading" class="muted">読み込んでいます…</pre>
      <pre v-else>{{ selectedText }}</pre>
    </section>
  </div>
</template>

<style scoped>
/* ペイン自体はスクロールさせない。スクロールは .scroll と .viewer の中だけに閉じ込め、
   絞り込みの帯と列見出しが常に見えるようにする（UI-DESIGN「一覧表の列見出し」） */
.spool-pane {
  padding: 12px;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
header { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; flex: none; }
h2 { margin: 0; font-size: 13px; font-family: var(--mono); font-weight: 700; }
label { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }

/* 列幅は中身に合わせる（SqlPane と同じ）。width: 100% だと値の間が間延びする */
table { border-collapse: collapse; width: auto; table-layout: auto; }
th, td { border-bottom: 1px solid var(--line); padding: 5px 8px; text-align: left; font-size: 13px; }
th, td { max-width: 40ch; overflow: hidden; text-overflow: ellipsis; }
td { font-family: var(--mono); white-space: pre; }
/* 列見出しはスクロールしても残す。
   border-collapse: collapse では sticky にした th の罫線が一緒にスクロールして消えるため、
   罫線は border ではなく box-shadow で描く。背景色も必須——行に背景が無いので、
   無いと本文が透けて重なる（UI-DESIGN） */
th {
  color: var(--muted);
  font-weight: 600;
  font-size: 12px;
  font-family: var(--mono);
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--card);
  border-bottom: none;
  box-shadow: inset 0 -1px 0 var(--line);
}
/* 列の右端の掴み手。掴める幅は 8px 取る（1px の罫線ちょうどでは掴めない） */
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
thead th:hover .col-grip::after,
.col-grip.dragging::after { background: var(--accent); }

tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--accent-soft); }
tbody tr.sel { background: var(--accent-soft); }

/* 中身の表示。一覧と同じくここだけをスクロールさせる */
.viewer { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); margin-top: 8px; }
.viewer-bar { display: flex; gap: 10px; align-items: center; padding: 6px 0; flex: none; }
/* 右寄せは最大化ボタンから。PDF はその隣に並べる */
.viewer-bar .max { margin-left: auto; }
.viewer pre {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin: 0;
  /* 帳票は桁揃えが命。日本語対応の等幅（半角:全角=1:2）で桁を保つ（--screen-mono） */
  font-family: var(--screen-mono);
  font-size: 12px;
  white-space: pre;
}
.muted { color: var(--muted); font-size: 12px; }
.truncated { color: var(--muted); font-size: 12px; margin: 0 0 6px; }
.error { color: #c62828; }
.empty { color: var(--muted); text-align: center; }
</style>
