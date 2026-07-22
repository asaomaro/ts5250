<script setup lang="ts">
/**
 * システム / セッション設定のカード。**その場でフォームに開く**（専用の設定画面を持たない）。
 *
 * 一覧とフォームを同じ場所に置くのは、編集したい対象の隣から入れば、
 * 開いた時点で対象が確定するため——別画面へ移ると「どれを直すんだったか」を選び直すことになる。
 */
import { computed, reactive, ref, watch } from "vue";
import type { PublicSession, PublicSystem } from "@as400web/server";
import { systemsStore, type SessionConfigForm, type SystemForm } from "../stores/systems.js";
import { sessionsStore } from "../stores/sessions.js";
import InfoPopover from "./InfoPopover.vue";
import { HOST_CODE_PAGES, DEFAULT_CCSID, DEFAULT_SPOOL_CCSID } from "../hostCodePages.js";
import { SCREEN_SIZES, DEFAULT_SCREEN_SIZE } from "../screenSizes.js";

const props = defineProps<{
  kind: "system" | "session";
  system?: PublicSystem;
  session?: PublicSession;
  /** 新規作成のカードか */
  creating?: boolean;
  /** セッション新規作成時の親システム */
  parentSystem?: string;
  /** いま選択中のシステムか（一覧の中で現在地を示す） */
  selected?: boolean;
  /** 一覧表示（横並びの行）にするか。親の表示モードを受け取る */
  dense?: boolean;
  /** このセッションが接続処理中か（接続待ちの表示に使う） */
  connecting?: boolean;
  /**
   * この設定のセッションが既に開いているか。
   * 開いていれば「接続」ではなく「開く」（既存タブへ戻る）を出す。システムを切り替えて戻ると
   * メニューにはこのカードしか出ず、タブが生きていることが見えないため、そのまま「接続」を
   * 押して 2 本目を開いてしまう。装置名を固定しているとホストが弾く。
   */
  opened?: boolean;
}>();

const emit = defineEmits<{
  (e: "done"): void;
  (e: "cancel"): void;
  (e: "select", ref: string): void;
  (e: "open", ref: string): void;
  /** 開いていても**あえて**もう 1 本開く */
  (e: "openNew", ref: string): void;
}>();

/**
 * このシステムで**接続中**のセッション数。カードの「セッション N」は設定の数なので、
 * それだけでは今つながっているのかが分からない（切り替えて戻ったときに一番知りたい情報）。
 */
const connectedCount = computed(() =>
  props.kind === "system" && props.system ? sessionsStore.connectedCount(props.system.ref) : 0
);

const editing = ref(props.creating === true);
const busy = ref(false);
const error = ref("");
const notice = ref("");

/** 保管場所。サーバー設定は編集可能なときだけ選べる */
const source = ref<"server" | "personal">("personal");

// exactOptionalPropertyTypes 下では省略可能プロパティに undefined を代入できないため、
// フォームの型は「undefined を取りうる」ものとして別に定義する
type SysFormState = { [K in keyof SystemForm]: SystemForm[K] | undefined };
type SesFormState = { [K in keyof SessionConfigForm]: SessionConfigForm[K] | undefined };

const sysForm = reactive<SysFormState>({
  name: "",
  host: "",
  tls: true,
  ccsid: DEFAULT_CCSID,
  spoolCcsid: DEFAULT_SPOOL_CCSID
});
const sesForm = reactive<SesFormState>({
  name: "",
  system: "",
  sessionType: "display",
  screenSize: DEFAULT_SCREEN_SIZE,
  deviceName: ""
});
const printerForm = reactive({ autoPdfDir: "", autoPrint: "", pageSize: "", fontSize: undefined as number | undefined });

/** 編集対象がサーバー設定か（信頼設定の欄を出すかの判定に使う） */
const isServer = computed(() => {
  const r = props.system?.ref ?? props.session?.ref;
  return r ? r.startsWith("srv:") : source.value === "server";
});
/**
 * この設定を編集できるか。**サーバー設定は編集権限があるときだけ**——
 * 押しても 403 になるボタンは出さない（認可の実体はサーバー側で、ここは体験のため）。
 */
const canEdit = computed(() => !isServer.value || systemsStore.editable);

/** printer 出力（信頼設定）を編集できるか。**サーバー設定のプリンターセッションかつ編集権限があるときだけ** */
const canEditPrinter = computed(
  () => isServer.value && systemsStore.editable && sesForm.sessionType === "printer"
);

function loadSystem(): void {
  const s = props.system;
  if (!s) return;
  sysForm.name = s.name;
  sysForm.host = s.host;
  sysForm.port = s.port;
  sysForm.tls = s.tls ?? false;
  sysForm.ccsid = s.ccsid ?? DEFAULT_CCSID;
  sysForm.spoolCcsid = s.spoolCcsid ?? DEFAULT_SPOOL_CCSID;
  sysForm.autoSignon = s.autoSignon;
  sysForm.signonUser = s.signonUser ?? "";
  // パスワードは返らない。**空のまま送れば既存が保たれる**（サーバー側でそう扱う）
  sysForm.password = "";
}

function loadSession(): void {
  const s = props.session;
  if (!s) {
    sesForm.system = props.parentSystem ?? systemsStore.selected ?? "";
    return;
  }
  sesForm.name = s.name;
  sesForm.system = s.system;
  sesForm.sessionType = s.sessionType;
  sesForm.deviceName = s.deviceName ?? "";
  sesForm.screenSize = s.screenSize ?? DEFAULT_SCREEN_SIZE;
  sesForm.ccsid = s.ccsid;
  sesForm.enhanced = s.enhanced;
}

watch(
  () => [props.system, props.session, editing.value],
  () => {
    if (!editing.value) return;
    if (props.kind === "system") loadSystem();
    else loadSession();
  },
  { immediate: true }
);

function startEdit(): void {
  error.value = "";
  notice.value = "";
  editing.value = true;
}

function cancel(): void {
  editing.value = false;
  error.value = "";
  if (props.creating) emit("cancel");
}

function validate(): string | undefined {
  if (props.kind === "system") {
    if (!sysForm.name?.trim()) return "名前を入力してください";
    if (!sysForm.host?.trim()) return "ホストを入力してください";
    if (sysForm.port !== undefined && (sysForm.port < 1 || sysForm.port > 65535)) {
      return "ポートは 1〜65535 の範囲で指定してください";
    }
    if (sysForm.autoSignon && !sysForm.signonUser?.trim()) {
      return "自動サインオンにはユーザー名が必要です";
    }
    return undefined;
  }
  if (!sesForm.name?.trim()) return "名前を入力してください";
  if (!sesForm.system) return "システムを選んでください";
  return undefined;
}

async function save(): Promise<void> {
  const invalid = validate();
  if (invalid) {
    error.value = invalid;
    return;
  }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (props.kind === "system") {
      const form = { ...sysForm, name: sysForm.name!.trim(), host: sysForm.host!.trim() } as SystemForm;
      if (!form.autoSignon) {
        // 明示オフ。サーバーは autoSignon:false を「解除」として扱う
        form.autoSignon = false;
        delete form.signonUser;
        delete form.password;
      } else if (!form.password) {
        // 空なら送らない＝既存のパスワードを保つ
        delete form.password;
      }
      if (props.creating) {
        form.source = source.value;
        await systemsStore.createSystem(form);
      } else {
        await systemsStore.updateSystem(props.system!.ref, form);
      }
    } else {
      const form = { ...sesForm, name: sesForm.name!.trim() } as SessionConfigForm;
      if (form.sessionType === "printer") {
        delete form.screenSize;
        delete form.enhanced;
      }
      if (canEditPrinter.value) {
        const p: NonNullable<SessionConfigForm["printer"]> = {};
        if (printerForm.autoPdfDir.trim()) p.autoPdfDir = printerForm.autoPdfDir.trim();
        if (printerForm.autoPrint.trim()) p.autoPrint = printerForm.autoPrint.trim();
        if (printerForm.pageSize.trim()) p.pageSize = printerForm.pageSize.trim();
        if (printerForm.fontSize !== undefined) p.fontSize = printerForm.fontSize;
        if (Object.keys(p).length > 0) form.printer = p;
      }
      if (props.creating) {
        form.source = isServer.value ? "server" : "personal";
        const created = await systemsStore.createSession(form);
        notice.value = `${created.name} を作成しました`;
      } else {
        await systemsStore.updateSession(props.session!.ref, form);
      }
    }
    // 新規作成のカードは表示用の実体（system / session）を持たない。
    // ここで編集を閉じると「実体なしの表示」を一瞬描いて落ちるため、閉じるのは親に任せる
    if (!props.creating) editing.value = false;
    emit("done");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  const name = props.system?.name ?? props.session?.name ?? "";
  if (!globalThis.confirm(`${name} を削除しますか？`)) return;
  busy.value = true;
  error.value = "";
  try {
    if (props.kind === "system") await systemsStore.removeSystem(props.system!.ref);
    else await systemsStore.removeSession(props.session!.ref);
    emit("done");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** セッション種別のアイコンと表記。旧 UI にあった見分けを引き継ぐ */
const typeIcon = computed(() => (props.session?.sessionType === "printer" ? "🖨" : "🖥"));
const typeLabel = computed(() =>
  props.session?.sessionType === "printer" ? "プリンター" : "5250 端末"
);

/** 詳細（ⓘ）の開閉。旧 UI にあった接続設定の詳細表示を引き継ぐ */
const showInfo = ref(false);

/**
 * 詳細の行。**セッションは親システムの接続情報も併せて出す**——
 * 分離したことで「このセッションがどこへ繋ぐか」が 1 枚のカードからは読めなくなったため、
 * ここで辿って見せる。
 */
const infoRows = computed(() => {
  const rows: { label: string; value: string }[] = [];
  if (props.kind === "system") {
    const o = props.system;
    if (!o) return rows;
    rows.push({ label: "名称", value: o.name });
    rows.push({ label: "区分", value: o.ref.startsWith("srv:") ? "サーバー設定" : "自分の設定" });
    rows.push({ label: "ホスト", value: `${o.host}${o.port ? ":" + o.port : ""}` });
    if (o.tls) rows.push({ label: "TLS", value: "有効" });
    if (o.ccsid !== undefined) rows.push({ label: "既定 CCSID", value: String(o.ccsid) });
    rows.push({
      label: "自動サインオン",
      value: o.autoSignon ? (o.signonUser ? `有効（${o.signonUser}）` : "有効") : "無効"
    });
    rows.push({ label: "セッション設定", value: `${systemsStore.sessionCount(o.ref)} 件` });
    return rows;
  }
  const o = props.session;
  if (!o) return rows;
  const parent = systemsStore.systems.find((x) => x.ref === o.system);
  rows.push({ label: "名称", value: o.name });
  rows.push({ label: "区分", value: o.ref.startsWith("srv:") ? "サーバー設定" : "自分の設定" });
  rows.push({ label: "種別", value: o.sessionType === "printer" ? "プリンター" : "5250 端末" });
  rows.push({ label: "システム", value: parent?.name ?? o.system });
  // 接続先と資格情報はシステム側が持つ。辿った結果をここに出す
  if (parent) {
    rows.push({ label: "ホスト", value: `${parent.host}${parent.port ? ":" + parent.port : ""}` });
    if (parent.tls) rows.push({ label: "TLS", value: "有効" });
    rows.push({
      label: "自動サインオン",
      value: parent.autoSignon ? (parent.signonUser ? `有効（${parent.signonUser}）` : "有効") : "無効"
    });
  }
  if (o.deviceName) rows.push({ label: "デバイス名", value: o.deviceName });
  if (o.screenSize) rows.push({ label: "画面サイズ", value: o.screenSize });
  rows.push({
    label: "CCSID",
    value: o.ccsid !== undefined ? String(o.ccsid) : `システムの既定${parent?.ccsid ? `（${parent.ccsid}）` : ""}`
  });
  return rows;
});
</script>

<template>
  <div class="card" :class="{ editing, current: selected && !editing, dense: dense && !editing }">
    <!-- 表示 -->
    <template v-if="!editing">
      <div class="nm">
        <span v-if="kind === 'session'" class="ticon" :title="typeLabel" aria-hidden="true">{{ typeIcon }}</span>
        {{ kind === "system" ? system?.name : session?.name }}
        <span v-if="kind === 'system' && system?.ref.startsWith('srv:')" class="chip">サーバー設定</span>
        <span v-if="kind === 'session'" class="chip type">{{ typeLabel }}</span>
      </div>
      <div v-if="kind === 'system'" class="meta">
        {{ system?.host }}<span v-if="system?.port">:{{ system.port }}</span>
        <span v-if="system?.tls"> TLS</span><br />
        {{ system?.autoSignon ? (system.signonUser ?? "自動サインオン") : "サインオンなし" }}
        <span v-if="system?.ccsid"> ccsid {{ system.ccsid }}</span>
      </div>
      <div v-else class="meta">
        <span v-if="session?.screenSize">{{ session.screenSize }}</span
        ><br />
        {{ session?.deviceName || "装置名なし" }}
        <span v-if="session?.ccsid"> ccsid {{ session.ccsid }}</span>
      </div>
      <div class="foot">
        <div class="actions">
          <button v-if="kind === 'system'" class="btn" @click="emit('select', system!.ref)">
            {{ selected ? "メニューへ" : "選択" }}
          </button>
          <button v-else class="btn" :disabled="connecting" @click="emit('open', session!.ref)">
            <span v-if="connecting" class="dot" aria-hidden="true"></span>{{
              connecting ? "接続中…" : opened ? "開く" : "接続"
            }}
          </button>
          <button
            v-if="kind === 'session' && opened && !connecting"
            class="btn ghost"
            title="この設定でもう 1 本セッションを開く"
            @click="emit('openNew', session!.ref)"
          >
            ＋新規
          </button>
          <button v-if="canEdit" class="btn ghost" @click="startEdit">編集</button>
          <button class="info" title="詳細" @click.stop="showInfo = !showInfo">ⓘ</button>
          <InfoPopover v-if="showInfo" :rows="infoRows" @close="showInfo = false" />
        </div>
        <span v-if="kind === 'system'" class="count" title="このシステムのセッション設定と接続中の数">
          セッション {{ systemsStore.sessionCount(system!.ref) }}
          <span v-if="connectedCount > 0" class="live" title="接続中のセッション数"
            >接続 {{ connectedCount }}</span
          >
        </span>
      </div>
    </template>

    <!-- その場編集 -->
    <template v-else>
      <div class="nm">{{ kind === "system" ? "システム" : "セッション" }}{{ creating ? "を追加" : "を編集" }}</div>

      <div v-if="kind === 'system'" class="fgrid">
        <label v-if="creating && systemsStore.editable" class="row">
          <span class="cap">保管場所</span>
          <select v-model="source">
            <option value="personal">自分の設定</option>
            <option value="server">サーバー設定（全員が使える）</option>
          </select>
        </label>
        <label class="row"><span class="cap">名前</span><input v-model="sysForm.name" /></label>
        <label class="row"><span class="cap">ホスト</span><input v-model="sysForm.host" /></label>
        <label class="row"
          ><span class="cap">ポート</span><input v-model.number="sysForm.port" type="number" placeholder="既定"
        /></label>
        <label class="row"
          ><span class="cap">TLS</span><input v-model="sysForm.tls" type="checkbox" />
          <span class="hint">証明書を検証して接続</span></label
        >
        <label class="row">
          <span class="cap">既定 CCSID</span>
          <select v-model.number="sysForm.ccsid">
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
        </label>
        <label class="row">
          <span class="cap">スプール CCSID</span>
          <select v-model.number="sysForm.spoolCcsid">
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
          <span class="hint">スプールの SCS 用。上の 5250 画面用とは別</span>
        </label>
        <label class="row"
          ><span class="cap">自動サインオン</span><input v-model="sysForm.autoSignon" type="checkbox"
        /></label>
        <template v-if="sysForm.autoSignon">
          <label class="row"><span class="cap">ユーザー</span><input v-model="sysForm.signonUser" /></label>
          <label class="row">
            <span class="cap">パスワード</span>
            <input v-model="sysForm.password" type="password" :placeholder="system?.autoSignon ? '変更しない' : ''" />
          </label>
        </template>
      </div>

      <div v-else class="fgrid">
        <label class="row">
          <span class="cap">システム</span>
          <select v-model="sesForm.system">
            <option v-for="s in systemsStore.systems" :key="s.ref" :value="s.ref">{{ s.name }}</option>
          </select>
        </label>
        <label class="row"><span class="cap">名前</span><input v-model="sesForm.name" /></label>
        <label class="row">
          <span class="cap">種類</span>
          <select v-model="sesForm.sessionType" :disabled="!creating">
            <option value="display">5250 表示</option>
            <option value="printer">プリンター</option>
          </select>
        </label>
        <label class="row"><span class="cap">装置名</span><input v-model="sesForm.deviceName" /></label>
        <label v-if="sesForm.sessionType === 'display'" class="row">
          <span class="cap">画面サイズ</span>
          <select v-model="sesForm.screenSize">
            <option v-for="s in SCREEN_SIZES" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <label class="row">
          <span class="cap">CCSID</span>
          <select v-model.number="sesForm.ccsid">
            <option :value="undefined">システムの既定</option>
            <option v-for="p in HOST_CODE_PAGES" :key="p.ccsid" :value="p.ccsid">{{ p.label }}</option>
          </select>
        </label>
      </div>

      <!-- 信頼設定。サーバー設定のプリンターセッションで、編集権限があるときだけ -->
      <div v-if="canEditPrinter" class="trusted">
        <div class="tlabel">サーバー側の出力（信頼設定）</div>
        <label class="row"
          ><span class="cap">PDF 保存先</span><input v-model="printerForm.autoPdfDir" placeholder="/var/spool/out"
        /></label>
        <label class="row"
          ><span class="cap">自動印刷</span><input v-model="printerForm.autoPrint" placeholder="プリンター名"
        /></label>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <p v-if="notice" class="ok">{{ notice }}</p>

      <div class="editfoot">
        <button class="btn" :disabled="busy" @click="save">保存</button>
        <button class="btn ghost" :disabled="busy" @click="cancel">取消</button>
        <button v-if="!creating" class="btn danger" :disabled="busy" @click="remove">削除</button>
        <span v-if="kind === 'session'" class="rest">ホスト・ユーザー・パスワードはシステムが持つ</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 12px 13px;
  background: var(--card);
  display: flex;
  flex-direction: column;
  /* InfoPopover を絶対配置する基準 */
  position: relative;
}
.info {
  border: none;
  background: none;
  color: var(--muted);
  padding: 2px 4px;
  font-size: 0.9rem;
  line-height: 1;
}
.info:hover {
  color: var(--accent);
  border-color: transparent;
}
/* 一覧表示: 横並びの 1 行にして高さを詰める（件数が多いときに見渡すため） */
.card.dense {
  flex-direction: row;
  align-items: center;
  gap: 14px;
  padding: 6px 12px;
}
.card.dense .nm {
  margin-bottom: 0;
  flex: 0 0 auto;
  min-width: 12ch;
}
.card.dense .meta {
  flex: 1;
  /* 2 行の情報を 1 行に畳む。<br> は改行しない扱いにする */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card.dense .meta :deep(br) {
  display: none;
}
.card.dense .meta :deep(br)::after {
  content: " ";
}
.card.dense .foot {
  margin-top: 0;
  padding-top: 0;
  flex: 0 0 auto;
  /* リスト表示は 1 行に戻す（ボタンの右にセッション数） */
  flex-direction: row;
  align-items: center;
}
.card.dense .count {
  margin-left: 6px;
}

/* 選択中のシステム。一覧の中で現在地が分かるようにする */
.card.current {
  border-color: var(--accent);
}
.card.editing {
  grid-column: 1 / -1;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.nm {
  font-weight: 700;
  font-size: 0.88rem;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.ticon {
  font-size: 0.95rem;
  line-height: 1;
}
.chip {
  font-size: 0.66rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
}
/* 種別は色を変えて、サーバー設定のバッジと区別する */
.chip.type {
  background: var(--line);
  color: var(--muted);
}
/* 接続待ちの回転。押した直後から反応が見えるようにする */
.dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 6px;
  border: 2px solid color-mix(in srgb, currentColor 35%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  vertical-align: -1px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dot {
    animation-duration: 2.5s;
  }
}
.meta {
  font-family: var(--mono);
  font-size: 0.73rem;
  color: var(--muted);
  line-height: 1.55;
}
.foot {
  margin-top: auto;
  padding-top: 10px;
  display: flex;
  /* グリッド表示ではセッション数をボタンの上の行に出す（狭い幅で折り返さないように） */
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 6px;
}
.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.count {
  font-size: 0.72rem;
  color: var(--muted);
  white-space: nowrap;
}
/* 接続中の数。設定の数と区別できるよう色を変える（0 のときは出さない） */
.live {
  margin-left: 6px;
  color: var(--t-green);
  font-weight: 600;
}
.btn {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
  padding: 4px 12px;
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.btn.ghost {
  background: transparent;
  color: var(--accent);
}
.btn.danger {
  background: transparent;
  border-color: var(--line);
  color: var(--muted);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.fgrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 6px 20px;
  margin-top: 8px;
}
.row {
  display: grid;
  grid-template-columns: 104px 1fr;
  gap: 8px;
  align-items: center;
  font-size: 0.8rem;
}
.cap {
  color: var(--muted);
  font-size: 0.76rem;
}
.row input[type="text"],
.row input:not([type]),
.row input[type="number"],
.row input[type="password"],
.row select {
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 3px 8px;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.76rem;
  width: 100%;
  box-sizing: border-box;
}
.row input[type="checkbox"] {
  justify-self: start;
}
.hint {
  grid-column: 2;
  font-size: 0.7rem;
  color: var(--muted);
}
.trusted {
  margin-top: 12px;
  padding: 10px 12px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 0 7px 7px 0;
  display: grid;
  gap: 6px;
}
.tlabel {
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--accent);
}
.editfoot {
  margin-top: 14px;
  display: flex;
  gap: 7px;
  align-items: center;
}
.rest {
  margin-left: auto;
  color: var(--muted);
  font-size: 0.73rem;
}
.err {
  color: #c62828;
  font-size: 0.78rem;
  margin: 8px 0 0;
}
.ok {
  color: var(--accent);
  font-size: 0.78rem;
  margin: 8px 0 0;
}
</style>
