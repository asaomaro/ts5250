<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { AidKey, ScreenSnapshot } from "@as400web/tn5250";
import ScreenGrid from "./ScreenGrid.vue";
import StatusBar from "./StatusBar.vue";
import LogPanel from "./LogPanel.vue";
import SysReqLine from "./SysReqLine.vue";
import WatermarkOverlay from "./WatermarkOverlay.vue";
import { viewSettings, resolveSbcsView } from "../stores/viewSettings.js";
import { screenFontStack } from "../composables/screenFonts.js";
import { logStore } from "../stores/log.js";
import { sessionsStore } from "../stores/sessions.js";
import { systemsStore } from "../stores/systems.js";
import { resolveWatermark } from "../composables/watermark.js";
import { makeKeydownHandler, type LocalAction } from "../composables/useKeymap.js";
import { moveCursor, fieldAt, caretInField, roundToDbcsLead, nextWordStart, type Dir, type CursorBounds } from "../composables/useCursor.js";
import { sendKey, selectGuiChoice, submitGuiSelection, noteActivity } from "../session-controller.js";
import { play } from "../macro-engine.js";
import { isKatakanaCcsid } from "../hostCodePages.js";
import { MSG_PROTECTED } from "../composables/opMessages.js";
import type { MandatoryFinding } from "../composables/mandatoryCheck.js";
import { fieldSlices, fieldSpan, posOfOffset } from "../composables/fieldSlices.js";

const props = defineProps<{ sessionId: string; focused: boolean }>();
/** この画面（セッション）の実効表示設定＝セッション上書き ?? アプリ既定 */
const view = computed(() => viewSettings.effective(props.sessionId));
/** 画面フォント: 選択フォントを --screen-mono へインライン上書き（system は上書き無し＝既定スタック）。
 *  トークンなので子(ScreenGrid)のグリッド・入力欄まで一括で追従する。 */
const screenMonoStyle = computed<Record<string, string> | undefined>(() => {
  const stack = screenFontStack(view.value.font);
  return stack ? { "--screen-mono": stack } : undefined;
});
const emit = defineEmits<{ (e: "focus"): void }>();

const paneEl = ref<HTMLElement | null>(null);

const state = computed(() => sessionsStore.get(props.sessionId));
const snapshot = computed(() => state.value?.snapshot);

/**
 * ウォーターマーク（画面に重ねる透かし）。
 *
 * 設定は**セッション設定を直に引く**（接続時にコピーを持ち回らない）。表示だけの設定なので
 * ホストへ渡す必要がなく、設定を保存した瞬間に開いているセッションへも反映される。
 * 直接指定で開いたセッション（`configRef` なし）は設定が無い＝透かしも出ない。
 */
const watermarkConfig = computed(() => {
  const cfgRef = state.value?.configRef;
  return cfgRef ? systemsStore.sessions.find((s) => s.ref === cfgRef)?.watermark : undefined;
});
const watermark = computed(() => {
  const s = state.value;
  if (!s) return undefined;
  // 装置名・ユーザーは**実際に割り当てられた値**（ジョブ）を優先する。
  // ホスト採番や手サインオンでは設定値と食い違い、設定値の方は嘘になる
  return resolveWatermark(watermarkConfig.value, {
    host: s.meta?.host,
    port: s.meta?.port !== undefined ? String(s.meta.port) : undefined,
    system: systemsStore.systems.find((x) => x.ref === s.systemRef)?.name,
    session: s.label,
    device: s.job?.name ?? s.meta?.deviceName,
    user: s.job?.user ?? s.meta?.signonUser
  });
});
// 通信中（ホスト応答待ち）は入力プロテクト。loading は 0.5 秒超でスピナー表示
const busy = computed(() => state.value?.busy ?? false);
const loading = computed(() => state.value?.loading ?? false);
// カタカナ系ホストコードページ（930/5026）は実機同様に英小文字を入力時に大文字化する
const uppercaseInput = computed(() => isKatakanaCcsid(state.value?.ccsid));
/**
 * 画面に渡す実効の表示コード。**ホストの SBCS 表を知っているのはここだけ**なので、
 * 保存値（自動/カナ/英）との突き合わせも親で済ませ、ScreenGrid には結果だけ渡す。
 * ホストと同じ向きなら `host`＝再解釈しない（今までどおりの見た目）。
 */
const sbcsView = computed(() => resolveSbcsView(view.value.kana, isKatakanaCcsid(state.value?.ccsid)));
const insertMode = ref(false);

/**
 * システム要求行（SysReq）を出しているか。
 *
 * SysReq は**押した瞬間には送らない**。実機・ACS と同じく画面下部に入力行を出し、確定して初めて
 * SRQ レコードを送る（打った文字列がレコードのデータになる）。キー設定からの SysReq も
 * フッターの SysReq ボタンも、入口は `onAid` に合流させる。
 * 開いている間は 5250 のキー処理を止め、フォーカスの奪い合いも避ける（下の snapshot watcher）ため、
 * 参照する側より先にここで宣言しておく。
 */
const sysReqOpen = ref(false);

/** 操作ログの開閉。**トグルはフッターに置く**ので、状態はここが持つ */
const logOpen = ref(false);
/** このセッションの記録件数（フッターの表示用） */
const logCount = computed(
  () => logStore.entries.filter((e) => e.sessionId === props.sessionId).length
);
// ユーザーがクリック/フォーカスでカーソルを動かしたときの上書き（未操作ならホスト snapshot.cursor を使う）
const cursorOverride = ref<{ row: number; col: number } | undefined>();
const cursor = computed(() => cursorOverride.value ?? snapshot.value?.cursor ?? { row: 1, col: 1 });

function onEdit(fieldIndex: number, value: string): void {
  state.value?.edits.set(fieldIndex, value);
}
function onCursor(row: number, col: number): void {
  cursorOverride.value = { row, col };
  reconcileFocus({ row, col });
}

/**
 * 有効カーソル位置に応じて表現モードを調停する（field ⇄ free）。
 * - 編集可能フィールド上 → 該当 <input> に focus し native キャレットを桁に合わせる（field モード）。
 * - 非入力/保護セル上 → 入力欄を blur し、キーボード捕捉のためペインへ focus（free モード。オーバーレイ表示）。
 * クリック（ScreenGrid）と矢印セル移動（onLocal）の両経路がここを通り、単一の調停点にする。
 */
function reconcileFocus(pos: { row: number; col: number }): void {
  const snap = snapshot.value;
  if (!snap) return;
  let f = fieldAt(pos.row, pos.col, snap.fields, snap.cols, snap.rows);
  const active = document.activeElement;
  // 末尾キャレット: 欄の右端境界（col === f.col+length＝最終文字の後ろ）は独立したセルを持たないが、
  // その欄の <input> が既にフォーカス中なら「欄の末尾」として欄内に留める（満杯欄でも末尾に止まれ、
  // Backspace で最終文字を消せる）。欄外から境界へ入ってきた場合（input 非フォーカス）は自由セル扱い。
  if (!f && active instanceof HTMLInputElement) {
    const cand = editableFields().find((fld) => {
      const end = posOfOffset(fld, fieldSpan(fld, snap.cols, snap.rows), snap.cols, snap.rows);
      return pos.row === end.row && pos.col === end.col;
    });
    if (cand && active.dataset["fieldIndex"] === String(cand.index)) f = cand;
  }
  if (f && !f.protected) {
    // 行またぎ欄では、論理オフセットを含むスライスの input へフォーカスする
    const offset = caretInField(f, pos.row, pos.col, snap.cols, snap.rows);
    const slices = fieldSlices(f, snap.cols, snap.rows);
    let si = slices.findIndex((s) => offset < s.offset + s.width);
    if (si < 0) si = slices.length - 1;
    const el = inputForSlice(f.index, si) ?? editableInputs()[editableFields().indexOf(f)];
    if (el) {
      const wasFocused = active === el;
      if (!wasFocused) el.focus();
      // DBCS 欄は列ビューの caret を ScreenGrid（論理⇔列マッピング）が管理するため、
      // SBCS 用の caretInField（1桁=1文字）で native caret を上書きしない。既にフォーカス中なら
      // ScreenGrid が置いた caret を尊重する（上書きすると欄内の矢印移動が壊れる）。
      // 欄外から矢印で入ってきたとき（!wasFocused）だけ、到達桁へ論理カーソルを合わせる。
      if (!f.dbcsType) {
        const caret = offset - slices[si]!.offset;
        el.setSelectionRange(caret, caret);
      } else if (!wasFocused) {
        gridRef.value?.setDbcsCaretAtColumn(f.index, pos.row, pos.col);
      }
      // el.focus() が onInputFocus を発火し emit("cursor", 欄先頭) で override を巻き戻すため、
      // 目的桁を再確定する（論理カーソルと native キャレットの不一致を防ぐ。review R1-1）。
      cursorOverride.value = pos;
    }
  } else {
    if (active instanceof HTMLInputElement && paneEl.value?.contains(active)) active.blur();
    if (document.activeElement !== paneEl.value) paneEl.value?.focus();
  }
}

/**
 * カーソルキーが動ける範囲。
 *
 * ホストが「カーソルを窓に閉じ込める」と宣言した窓（CREATE WINDOW の flag1 bit0x80 =
 * `restrictCursor`）の**中に居るときだけ**その窓に閉じ込める。外に居るときは画面全体
 * ——窓の外から矢印で入ってくるのは妨げない。
 *
 * 対象は**ホストが宣言した窓だけ**。文字や反転で描かれた窓はこちらの推測で見つけている
 * ものなので、外したときにカーソルが理由もなく閉じ込められる。
 */
function cursorBounds(snap: ScreenSnapshot): CursorBounds {
  const screen = { row1: 1, row2: snap.rows, col1: 1, col2: snap.cols };
  const wins = (snap.gui?.windows ?? []).filter((w) => w.restrictCursor);
  const w = wins[wins.length - 1];
  if (!w) return screen;
  // 窓の中身の範囲（ホストが送る位置は枠の左上で、中身はその 1 行下・3 桁右から）
  const inner = { row1: w.row + 1, row2: w.row + w.height, col1: w.col + 3, col2: w.col + w.width + 2 };
  const { row, col } = cursor.value;
  const inside = row >= inner.row1 && row <= inner.row2 && col >= inner.col1 && col <= inner.col2;
  return inside ? inner : screen;
}

/** 矢印で有効カーソルを 1 セル移動し、着地セルでモード調停する（onCursor 経由） */
function moveCell(dir: Dir): void {
  const snap = snapshot.value;
  if (!snap) return;
  // 端では反対側へ回り込む（5250 端末の矢印。最下行で ↓ は最上行へ）
  const opts = { bounds: cursorBounds(snap), wrap: true };
  let next = moveCursor(cursor.value, dir, snap.rows, snap.cols, opts);
  // DBCS（全角 2 桁）の桁間には止めない。右移動は tail を飛び越え、左/上/下・位置確定は lead へ丸める
  // （一律丸めだと lead で右が tail→lead に戻され進めない。review R1-2）。
  if (snap.cells[next.row - 1]?.[next.col - 1]?.kind === "dbcs-tail") {
    next = dir === "right" ? moveCursor(next, "right", snap.rows, snap.cols, opts) : roundToDbcsLead(next, snap.cells);
  }
  onCursor(next.row, next.col);
}
// ACS の自動送り: 欄が満杯になったら次の入力欄へフォーカスを進める。
// 満杯時は欄外へ論理カーソルが出て input が blur 済み（activeElement がペイン）なので、
// focusByOffset ではなく満杯欄の index から次欄を特定する。
function onFieldFull(fieldIndex: number): void {
  const flds = editableFields();
  const els = editableInputs();
  const cur = flds.findIndex((f) => f.index === fieldIndex);
  if (cur < 0 || els.length === 0) return;
  focusInput(els, (cur + 1) % els.length);
}

/**
 * 欄の**先頭**で Backspace が押された（ScreenGrid）。**前の入力欄の末尾**へ移る。
 *
 * 実機は欄の先頭の Backspace を「前の欄の末尾へカーソルを移す（削除はしない）」として扱う
 * （GNU tn5250 `display.c` の `kf_backspace`）。EDTMSK のように**ホストが 1 つの項目を
 * 複数の入力欄へ分解して送る**画面では、これが無いと欄をまたいで戻れず行き止まりになる。
 * `onFieldFull`（次の欄へ）と対称に、先頭の欄では末尾の欄へ回る。
 */
function onFieldPrev(fieldIndex: number): void {
  const flds = editableFields();
  const els = editableInputs();
  const cur = flds.findIndex((f) => f.index === fieldIndex);
  if (cur < 0 || els.length === 0) return;
  const prev = (cur - 1 + els.length) % els.length;
  const el = els[prev];
  if (!el) return;
  el.focus();
  // **末尾へ置く**（`focusInput` は先頭に置くので使えない）。行またぎ欄でも
  // この input（スライス 0）の末尾で十分——続けて Backspace を押せば欄内の削除になる
  const end = el.value.length;
  el.setSelectionRange(end, end);
}
function onGuiSelect(fieldId: number, choiceIndex: number, selected: boolean): void {
  selectGuiChoice(props.sessionId, fieldId, choiceIndex, selected);
}
function onGuiSubmit(fieldId: number): void {
  submitGuiSelection(props.sessionId, fieldId, cursor.value);
}
// 新しいホスト画面が来たらユーザーのカーソル上書きをリセットする
watch(snapshot, (snap) => {
  cursorOverride.value = undefined;
  // 入力欄が 1 つも無い画面では ScreenGrid の欄フォーカス（focusCursorField）が早期 return し、
  // どこも focus されずキー操作できない（見た目はカーソルが出る）。ペインを focus して
  // 自由カーソル・F キーを有効にする（クリックで reconcileFocus がペインを focus するのと同じ状態）。
  // システム要求行を出している間はフォーカスを奪わない（行が自分で取り戻すので、ここで
  // ペインへ移すと取り合いになる）。行が開いている間はキー処理も止めている。
  if (sysReqOpen.value) return;
  if (props.focused && snap && !snap.keyboardLocked && !snap.fields.some((f) => !f.protected)) {
    nextTick(() => paneEl.value?.focus());
  }
});

// 【カーソル／編集モデルの協調（ScreenGrid との役割分担）】
//   有効カーソル `cursor`（override ?? snapshot.cursor）を論理カーソルの単一の真実とし、AID 送信と
//   ScreenGrid（オーバーレイ）へ供給する。矢印は画面全体を 1 セルずつ自由移動し（moveCell）、着地セルが
//   編集可能フィールドなら該当 <input> に focus＋キャレット（field モード）、非入力/保護なら input を blur し
//   ペインに focus してオーバーレイ表示（free モード）。この調停は reconcileFocus に集約する。
//   Tab はフィールド「間」ジャンプ（focusByOffset）で従来どおり。文字編集そのもの（上書き/挿入/バックスペース・
//   欄内桁の追従）は ScreenGrid の edit モデルが担い、欄内で動かせる Left/Right は ScreenGrid が処理して
//   ここへは伝播しない（端・上下・非入力セルだけがセル移動として届く）。両者を繋ぐのは native input の caret。
//
/** ペイン内の編集可能な入力欄（画面順＝DOM 順）。保護フィールドは readonly なので除外。
 *  行またぎ欄は行ごとに input が分かれるため、先頭スライスだけを「欄の代表」として拾い、
 *  editableFields() と 1:1 の対応を保つ（Tab 等の欄間移動はフィールド単位のため）。 */
function editableInputs(): HTMLInputElement[] {
  if (!paneEl.value) return [];
  return Array.from(
    paneEl.value.querySelectorAll<HTMLInputElement>('input.grid-input:not([readonly])[data-slice="0"]')
  );
}

/** 指定フィールド・スライスの input（行またぎ欄のキャレット配置に使う） */
function inputForSlice(fieldIndex: number, sliceIdx: number): HTMLInputElement | undefined {
  return (
    paneEl.value?.querySelector<HTMLInputElement>(
      `input.grid-input[data-field-index="${fieldIndex}"][data-slice="${sliceIdx}"]`
    ) ?? undefined
  );
}

/** editableInputs と同順の非保護フィールド（行情報つき。上下移動の行判定に使う） */
function editableFields() {
  return (snapshot.value?.fields ?? []).filter((f) => !f.protected);
}

function focusInput(inputs: HTMLInputElement[], i: number): void {
  const el = inputs[i];
  if (!el) return;
  el.focus();
  el.setSelectionRange(0, 0);
}

/**
 * Tab で止まる要素（入力欄＋機能キーボタン）を DOM 順で返す。
 * **ボタンもタブ順に含める**——画面上のボタンなら、キーボードだけで到達して押せるべき（decisions D5）。
 * ボタンは意匠「なし」のときは描画されないので、その場合は従来どおり入力欄だけになる。
 */
function tabStops(): HTMLElement[] {
  if (!paneEl.value) return [];
  return Array.from(
    paneEl.value.querySelectorAll<HTMLElement>(
      'input.grid-input:not([readonly])[data-slice="0"], button.fkey-btn'
    )
  );
}

/** タブ停止点へフォーカスする（入力欄なら先頭桁にキャレットを置く） */
function focusStop(el: HTMLElement | undefined): void {
  if (!el) return;
  el.focus();
  if (el instanceof HTMLInputElement) el.setSelectionRange(0, 0);
}

/** タブ停止点の**画面上の位置**。入力欄はフィールド、ボタンは描画時に付けた data 属性から。 */
function stopPos(el: HTMLElement): { row: number; col: number } | undefined {
  if (el instanceof HTMLInputElement) {
    const idx = Number(el.dataset["fieldIndex"]);
    const f = snapshot.value?.fields.find((x) => x.index === idx);
    return f ? { row: f.row, col: f.col } : undefined;
  }
  const row = Number(el.dataset["row"]);
  const col = Number(el.dataset["col"]);
  return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : undefined;
}

/** 順次移動（Tab / Shift+Tab / 欄外での左右）。末尾↔先頭でラップ */
function focusByOffset(delta: number): void {
  const stops = tabStops();
  if (stops.length === 0) {
    // 行き先が 1 つも無い画面（確認画面等）。原点へ置く。
    onCursor(1, 1);
    return;
  }
  const cur = stops.indexOf(document.activeElement as HTMLElement);
  if (cur !== -1) {
    focusStop(stops[(cur + delta + stops.length) % stops.length]);
    return;
  }

  /**
   * 停止点にフォーカスが無い（保護欄・非入力セルにカーソルがある free モード）。
   * **並びに現在地が無いので、そこから探すと必ず先頭／末尾へ飛ぶ。**
   * 代わりに画面上のカーソル位置と各停止点の位置を比べ、その位置から見て
   * 次（Tab）／前（Shift+Tab）へ移す。**入力欄だけでなく有効化したボタンも移動先にする**
   * （ボタンなのに Tab で辿り着けないのは不自然なため）。
   */
  const at = cursor.value;
  const positioned = stops
    .map((el) => ({ el, pos: stopPos(el) }))
    .filter((x): x is { el: HTMLElement; pos: { row: number; col: number } } => x.pos !== undefined);
  if (positioned.length === 0) {
    focusStop(delta > 0 ? stops[0] : stops[stops.length - 1]);
    return;
  }
  const isAfter = (p: { row: number; col: number }): boolean =>
    p.row > at.row || (p.row === at.row && p.col > at.col);
  if (delta > 0) {
    const next = positioned.find((x) => isAfter(x.pos));
    focusStop((next ?? positioned[0]!).el); // 後ろに無ければ先頭へラップ
    return;
  }
  let prev: HTMLElement | undefined;
  for (const x of positioned) if (!isAfter(x.pos) && (x.pos.row !== at.row || x.pos.col !== at.col)) prev = x.el;
  focusStop(prev ?? positioned[positioned.length - 1]!.el); // 前に無ければ末尾へラップ
}

function onLocal(action: LocalAction): void {
  const inputs = editableInputs();
  switch (action) {
    // Tab はフィールド「間」ジャンプ（従来どおり）。矢印は画面全体を 1 セルずつ自由移動。
    case "tab":
      focusByOffset(1);
      break;
    case "shift-tab":
      focusByOffset(-1);
      break;
    case "left":
    case "right":
    case "up":
    case "down":
      // 欄内でキャレットが動かせる Left/Right は ScreenGrid が処理して伝播しない。
      // ここに来るのは欄の端／非入力セル／上下。いずれも 1 セル移動＋モード調停。
      moveCell(action);
      break;
    case "word-left":
    case "word-right":
    case "word-up":
    case "word-down": {
      // ACS の Ctrl+矢印 頭出し: 画面上の語頭へ自由カーソルを飛ばす（欄内外を問わない）。
      const snap = snapshot.value;
      if (!snap) break;
      const dir = action.slice("word-".length) as Dir;
      const grid = gridRef.value;
      if (!grid) break;
      // 語の判定は ScreenGrid の桁アクセサで行う（**未送信の入力値込み**。cells だけ見ると
      // 欄に打った文字が語として見えず飛び越される）。コピー・ダブルクリック選択と同じ文字。
      const next = nextWordStart(
        (r, c) => grid.screenCharAt(r, c),
        cursor.value,
        dir,
        snap.rows,
        snap.cols
      );
      onCursor(next.row, next.col);
      // **DBCS 欄はここで caret を明示的に置く。** reconcileFocus は「既にフォーカス中の DBCS 欄」の
      // caret を触らない（欄内の矢印移動は ScreenGrid が持つため）。頭出しは ScreenGrid が動かさない
      // ので、そのままだと同じ欄の中では caret が居残ってしまう。
      const land = fieldAt(next.row, next.col, snap.fields, snap.cols, snap.rows);
      if (land && !land.protected && land.dbcsType) {
        gridRef.value?.setDbcsCaretAtColumn(land.index, next.row, next.col);
      }
      break;
    }
    case "home":
      focusInput(inputs, 0);
      break;
    case "end":
      focusInput(inputs, inputs.length - 1);
      break;
    // ローカル編集キー（ホストへ送らない）。値の編集は ScreenGrid、欄の移動はここ、の分担。
    case "field-exit":
      // 次の欄への移動は ScreenGrid が出す field-full → onFieldFull が担う
      gridRef.value?.fieldExit();
      break;
    case "erase-eof":
      gridRef.value?.eraseEof();
      break;
    // 符号確定と Dup。欄の移動は Field Exit と同じく field-full → onFieldFull が担う
    case "field-minus":
      gridRef.value?.fieldMinus();
      break;
    case "field-plus":
      gridRef.value?.fieldPlus();
      break;
    case "dup":
      gridRef.value?.dup();
      break;
    case "erase-input":
      gridRef.value?.eraseInput();
      // 全欄クリア後は先頭の入力欄へ（実機の Erase Input と同じ着地）
      focusInput(inputs, 0);
      break;
  }
}

/** キー設定で割り当てた表示設定の順送り。切り替わった内容を OIA に通知する（次のキー操作で消える）。 */
function onViewCycle(key: string): void {
  const r = viewSettings.cycle(key);
  if (r) notice.value = `${r.label}: ${r.valueLabel}`;
}

// ---- システム要求行（SysReq） ----
function onAid(key: AidKey): void {
  // ボタン経由（マウス）ではペインの keydown を通らずローカル通知が残る。残したままだと
  // 応答が無かったときのサーバー発の通知（effectiveNotice）を覆い隠すので、ここで消す。
  notice.value = "";
  if (key === "SysReq") {
    sysReqOpen.value = true;
    return;
  }
  focusMandatoryViolation(sendKey(props.sessionId, key, cursor.value));
}

/**
 * 必須検証（FFW の `MANDATORY_ENTER` / `MANDATORY_FILL`）で止められたら、**直せる場所へ連れて行く**。
 *
 * 判定と通知そのものは `sendKey` が行う（OIA の「⏎ 実行」ボタンなど、ここを通らない送信経路が
 * あるため。`session-controller.ts` のコメント参照）。ここはフォーカス移動だけを足す。
 */
function focusMandatoryViolation(hit: MandatoryFinding | undefined): void {
  if (!hit) return;
  const els = editableInputs();
  const idx = editableFields().findIndex((f) => f.index === hit.field.index);
  if (idx >= 0 && els.length > 0) focusInput(els, idx);
}

function onSysReqSubmit(text: string): void {
  sysReqOpen.value = false;
  sendKey(props.sessionId, "SysReq", cursor.value, text);
  void nextTick(() => paneEl.value?.focus());
}

function onSysReqCancel(): void {
  // 取り消しでは**レコードを 1 本も送らない**（ホストは押されたことすら知らない）
  sysReqOpen.value = false;
  void nextTick(() => paneEl.value?.focus());
}

// 切断されたら行を畳む（送り先が無い入力欄を残さない）
watch(
  () => state.value?.connected,
  (connected) => {
    if (connected === false) sysReqOpen.value = false;
  }
);

/**
 * ペインがフォーカスを失ったら行を畳む＝**取り消し扱い**（まだ何も送っていないので副作用は無い）。
 *
 * 畳まないと、行の `@focusout` によるフォーカス保持が**タブ・ペイン切替と喧嘩する**。
 * Alt+PageUp/Down（タブ切替）と Alt+矢印（ペイン移動）はペインではなく App のグローバルハンドラが
 * 担うため、行を開いていて `onKeydown` が早期 return していても発火する。そのとき離れたペインの行が
 * フォーカスを引き戻すと、切替先のペインがキーボードを取れなくなる。
 */
watch(
  () => props.focused,
  (focused) => {
    if (!focused) sysReqOpen.value = false;
  }
);

/** キー設定で割り当てたマクロを再生する（ホストへは送らない。spec D10） */
function onPlayMacro(macroId: string): void {
  notice.value = "";
  play(props.sessionId, macroId);
}

const rawKeydown = makeKeydownHandler({
  sendAid: onAid,
  local: onLocal,
  viewCycle: onViewCycle,
  playMacro: onPlayMacro,
  isFocused: () => props.focused
});

// ---- キーボードによる矩形（ブロック）選択（free モードで Shift+矢印） ----
const gridRef = ref<InstanceType<typeof ScreenGrid> | null>(null);
let selAnchor: { row: number; col: number } | null = null;
/** 選択の移動端（アンカーの反対角）。ACS はカーソルを始点に置いたまま動かさないため、
 *  「次にどこから広げるか」をカーソルとは別に持つ必要がある。 */
let selFocus: { row: number; col: number } | null = null;
/**
 * その矩形選択が**入力欄の caret から始まったか**。
 *
 * 選択中は free モード（欄を blur してペインへ focus）なので、そのままだと文字入力が
 * 「保護領域への入力」になり、ペーストもカーソル桁への欄外ペーストになる。caret 発の選択では
 * 文字入力・ペースト・コピーのあとに選択を解除して caret へ戻し、通常の入力状態に復帰させる。
 */
let selFromCaret = false;
const ARROW_DIRS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

function clearBlockSel(): void {
  selAnchor = null;
  selFocus = null;
  selFromCaret = false;
  gridRef.value?.clearBlockSelection();
}
/** ScreenGrid 側で選択が解除された（コピー後・画面更新等）とき、キーボード選択アンカーもリセット。 */
function onSelectionCleared(): void {
  selAnchor = null;
  selFocus = null;
  selFromCaret = false;
}

/** 矩形選択を解除し、選択を始めたときの caret（＝カーソル桁の入力欄）へ戻す。
 *  カーソルは選択中も始点から動かないので、その桁で reconcileFocus すれば元の状態に戻る。 */
function restoreCaretFromBlockSel(): void {
  const pos = { ...cursor.value };
  clearBlockSel();
  reconcileFocus(pos);
}
/** マウスドラッグで矩形選択が始まった（ScreenGrid）。ACS 同様、押下したセルにカーソルを置く。
 *  入力欄は ScreenGrid が blur 済みなので、reconcileFocus は通さない（通すと欄へ再フォーカスして選択が壊れる）。 */
/** クライアント側の操作員メッセージ（ACS の OIA 相当）。次のキー操作・画面更新で消える。 */
const notice = ref("");
function onNotice(text: string): void {
  notice.value = text;
}
/**
 * StatusBar へ渡す操作員メッセージ。ローカル発（欄の型違反・保護領域への入力）を優先し、
 * 無ければサーバー応答由来（ホスト無応答の通知。`SessionState.notice`）を出す。
 * ローカル発はキー操作で消え、サーバー発は次の送信で消える（session-controller）。
 */
const effectiveNotice = computed(() => notice.value || state.value?.notice || "");

/** ScreenGrid 発の AID。キーボードの F キーと同じ扱いで送る。
 *  ボタン側で mousedown を preventDefault しているので、入力欄のフォーカス＝カーソルは動かない。
 *
 *  経路は 2 つある: **機能キー凡例のボタン**（利用者の操作）と、
 *  **AUTO_ENTER 欄が満杯になったときの自動 Enter**（FFW 0x0080。`advanceIfFull` / `fieldExitKey`）。
 *  後者も `busy` / `keyboardLocked` のプロテクトに乗せたいので、同じ入口へ合流させている。 */
function onFkeyAid(key: AidKey): void {
  if (busy.value || snapshot.value?.keyboardLocked) return;
  emit("focus");
  focusMandatoryViolation(sendKey(props.sessionId, key, cursor.value));
}

/**
 * 欄外（保護領域・非入力セル）でのペースト。
 * **このアプリは保護欄に focus を留めない**（reconcileFocus が blur してペインへ移す）ため、
 * ScreenGrid の @paste は届かない。ペインで拾い、カーソル位置を起点に委譲する。
 */
/** 編集可能な入力欄にフォーカスがあるか。
 *  **入力欄の keydown / paste はペインまでバブルする**ため、ペイン側の欄外処理は
 *  必ずこれで弾く（弾かないと入力できているのにメッセージが出る）。 */
function editableFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && !!paneEl.value?.contains(active) && !active.readOnly;
}

function onPanePaste(ev: ClipboardEvent): void {
  if (busy.value || snapshot.value?.keyboardLocked) return;
  if (editableFocused()) return; // 入力欄にフォーカスがある → ScreenGrid 側で処理する
  const text = ev.clipboardData?.getData("text") ?? "";
  if (!text) return;
  ev.preventDefault();
  gridRef.value?.pasteAt(cursor.value.row, cursor.value.col, text);
  // caret 発の矩形選択中なら、貼り付けたあと選択を解除して caret へ戻す（＝通常のペースト後と同じ状態）。
  // 先に貼ってから戻すこと: 先に focus すると ScreenGrid の編集モデルが貼る前の値のまま残る
  if (selFromCaret) restoreCaretFromBlockSel();
}

/**
 * 矩形選択中の Ctrl+C。コピー自体と選択解除は ScreenGrid（document の copy リスナー）が行うので、
 * ここではそのあと caret へ戻すだけ。イベントは止めない（順序: ペイン → document）。
 */
function onPaneCopy(): void {
  if (!selFromCaret) return;
  const pos = { ...cursor.value };
  selFromCaret = false;
  // ScreenGrid が矩形をクリップボードへ載せ終えてから戻す（同じイベント配送中に focus を触らない）
  queueMicrotask(() => reconcileFocus(pos));
}

/** 欄外で文字入力・Backspace・Delete が押されたか（ACS のメッセージ対象） */
function isProtectedEdit(ev: KeyboardEvent): boolean {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  return ev.key.length === 1 || ev.key === "Backspace" || ev.key === "Delete";
}
function onSelectionStart(row: number, col: number): void {
  cursorOverride.value = { row, col };
  // ScreenGrid は入力欄を blur しただけなので、そのままだとフォーカスが body に落ちてキーが
  // どこにも届かない（Escape や矢印での解除が効かなくなる）。キーボード選択と同じく free モードへ。
  if (document.activeElement !== paneEl.value) paneEl.value?.focus();
}
/** ブロック選択の反対角を pos へ拡張する。入力欄にフォーカスがあれば外して free モードにする
 *  （マウス・欄外操作と同一の画面矩形選択）。開始点は最初の呼び出し時のカーソル位置に固定。
 *  ACS 同様、範囲を広げてもカーソルは始点から動かさない（動く端は selFocus が持つ）。 */
function blockSelExtendTo(pos: { row: number; col: number }): void {
  if (!selAnchor) selAnchor = { ...cursor.value };
  selFocus = pos;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && paneEl.value?.contains(active)) active.blur();
  if (document.activeElement !== paneEl.value) paneEl.value?.focus();
  gridRef.value?.setBlockSelection({
    r1: Math.min(selAnchor.row, pos.row),
    r2: Math.max(selAnchor.row, pos.row),
    c1: Math.min(selAnchor.col, pos.col),
    c2: Math.max(selAnchor.col, pos.col)
  });
}
/** 入力欄に caret があるか（保護欄の readonly input も含む）。
 *  caret は桁そのものではなく**桁と桁の境界**に立つため、選択の始点計算が欄外と異なる。 */
function caretFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && !!paneEl.value?.contains(active);
}

/**
 * 入力欄の caret から矩形選択を始めるときの 1 押し目。
 *
 * **欄外のブロックカーソルは「桁」を指すが、入力欄の caret は「桁の境界」に立つ。**
 * 境界のどちら側を選ぶかは矢印の向きで決まる——左なら caret の左隣の桁、右なら右隣の桁
 * （＝報告しているカーソル桁）。カーソル桁を無条件に始点にすると、"12345" の 4 の右に
 * caret がある状態の Shift+← で 5 まで選ばれてしまう。
 *
 * 1 押し目は端を動かさず、境界に接する 1 桁だけを選ぶ（2 押し目からは通常どおり伸びる）。
 * 上下は境界と無関係なので従来どおりカーソル桁の列で 1 桁幅のまま行を伸ばす。
 */
function blockSelectFromCaret(ev: KeyboardEvent, rows: number, cols: number): boolean {
  const { row, col } = cursor.value;
  const leftward = ev.key === "ArrowLeft" || ev.key === "Home";
  const start = { row, col: leftward ? Math.max(1, col - 1) : col };
  selAnchor = start;
  selFromCaret = true;
  if (ev.key === "Home") blockSelExtendTo({ row, col: 1 });
  else if (ev.key === "End") blockSelExtendTo({ row, col: cols });
  else if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
    blockSelExtendTo(moveCursor(start, ARROW_DIRS[ev.key]!, rows, cols));
  } else blockSelExtendTo(start);
  return true;
}

/** Shift+矢印/Home/End によるブロック選択の拡張先を計算して適用する。 */
function keyboardBlockSelect(ev: KeyboardEvent): boolean {
  const snap = snapshot.value;
  if (!snap) return false;
  if (selAnchor === null && caretFocused()) return blockSelectFromCaret(ev, snap.rows, snap.cols);
  // 広げる基点は「前回の移動端」。カーソルは始点に固定されるので基点には使えない
  // （使うと Shift+→ を 2 回押しても常に始点の隣までしか伸びない）。
  const cur = selFocus ?? cursor.value;
  if (ARROW_DIRS[ev.key]) {
    blockSelExtendTo(moveCursor(cur, ARROW_DIRS[ev.key]!, snap.rows, snap.cols));
    return true;
  }
  if (ev.key === "Home") {
    blockSelExtendTo({ row: cur.row, col: 1 });
    return true;
  }
  if (ev.key === "End") {
    blockSelExtendTo({ row: cur.row, col: snap.cols });
    return true;
  }
  return false;
}

/**
 * **在席の合図は DOM の生イベント（capture）から出す**（`noteActivity` は 15 秒に間引く）。
 * 出所は `.pane` の `@keydown.capture` と `@pointerdown.capture` の 2 つ。
 *
 * 打った文字は AID キーまで送らないので、これが無いとサーバーからは打鍵中が無操作に見え、
 * アイドルタイムアウトに有限値を設定したときに打ち込み途中で切られる（spec 方針4）。
 *
 * **合成イベント（`cursor` / `edit`）を使ってはならない。** `ScreenGrid.onInputFocus` が
 * `cursor` を emit するため、**ホスト発の画面更新でも飛ぶ**（新画面 → `reconcileFocus` → focus）。
 * それを在席と数えると「閉じ忘れたタブが永久に生き残る」＝仕様が禁じている状態になる。
 * capture にしているのは、子（入力欄・ボタン）が伝播を止めても必ず通るため。
 */
function noteUserActivity(): void {
  noteActivity(props.sessionId);
}

/** 次のキー操作でメッセージを消す（ACS 相当。キーボードはロックしない）。
 *  capture で拾うこと: 入力欄は Home/End/矢印などで stopPropagation するため、bubble の
 *  onKeydown では欄内のキーを取りこぼす（メッセージが出るのはまさに欄内なので消えなくなる）。 */
function onKeydownCapture(): void {
  notice.value = "";
  noteUserActivity();
}
function onKeydown(ev: KeyboardEvent): void {
  if (busy.value) {
    ev.preventDefault(); // 通信中は入力プロテクト（キー操作を無効化）
    return;
  }
  // システム要求行が開いている間は 5250 のキー処理を止める。**入力欄は .pane の子なので
  // keydown がここまでバブルしてくる**——素通しすると実行キーが「行の確定」と「5250 の Enter 送信」の
  // 両方に解釈され、二重に送ってしまう。
  //
  // 行の中で起きたキーは**行が閉じた後でも**触らない（`.sysreq` 由来かで判定する）。
  // 確定・取り消しのハンドラが先に走って sysReqOpen を false にしてから、同じイベントが
  // ここへバブルしてくるため。Esc を SysReq に割り当てていると（利用者の想定用途そのもの）、
  // 取り消しの Esc がそのまま再び行を開いてしまい、二度と閉じられなくなる。
  if (sysReqOpen.value || (ev.target instanceof HTMLElement && ev.target.closest(".sysreq"))) return;
  // 機能キーボタン・オプション選択肢のボタンにフォーカスがあるときの Space は
  // 「そのボタンを押す」（普通のボタンと同じ）。
  // 明示的に処理するのは、下の isProtectedEdit が Space を preventDefault してしまい
  // native の Space 起動が効かなくなるため。**Enter は 5250 の AID として残す**——端末で最も
  // 重要なキーを、たまたまボタンにフォーカスがあるという理由で奪わない（decisions D5）。
  // **オプション選択肢のリストが開いている間は、リスト内のキー操作を優先する。**
  // Esc（矩形選択の解除等）や矢印がリストより先に発火すると、閉じる前に別の動作が起きる
  // ——「ドロップダウンリストが閉じるまで発火しないように」という利用者指示。
  if (
    gridRef.value?.optHintsOpen?.() &&
    ev.target instanceof HTMLElement &&
    ev.target.closest(".opt-hints")
  ) {
    return;
  }
  // **Alt+↓ でオプション欄のドロップダウンを開く**（コンボボックスの慣用キー）。
  // フォーカスしただけでは開かない——一覧を移動するたびにリストが視界を塞ぐため。
  // `Alt+矢印` はペイン移動から `Alt+Shift+矢印` へ移してここを空けた（App.vue）。
  if (ev.altKey && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && ev.key === "ArrowDown") {
    if (gridRef.value?.openOptHints()) {
      ev.preventDefault();
      return;
    }
  }
  const focusedBtn = document.activeElement;
  if (
    ev.key === " " &&
    focusedBtn instanceof HTMLButtonElement &&
    (focusedBtn.classList.contains("fkey-btn") ||
      focusedBtn.classList.contains("opt-btn") ||
      focusedBtn.classList.contains("opt-hint")) &&
    paneEl.value?.contains(focusedBtn)
  ) {
    ev.preventDefault();
    focusedBtn.click();
    return;
  }
  // Shift+矢印/Home/End は入力欄フォーカスの有無に関わらず画面の矩形（ブロック）選択を拡張する
  // （マウス・欄外操作と同一）。ScreenGrid は欄内 Shift 移動を preventDefault してここへ委譲する。
  if (ev.shiftKey && (ARROW_DIRS[ev.key] || ev.key === "Home" || ev.key === "End")) {
    if (keyboardBlockSelect(ev)) {
      ev.preventDefault();
      return;
    }
  }
  // Escape・カーソル移動でブロック選択を解除（ACS 相当）。
  // selAnchor で条件付けないこと: あれはキーボード選択のアンカーで、マウスで選択した場合は
  // null のまま（矩形の実体は ScreenGrid 側）。見るとマウス選択が解除されずに残る。
  // clearBlockSel は冪等なので、選択が無いときに呼んでも害はない。
  // Shift+矢印/Home/End は上で選択の拡張として処理済み（ここには来ない）。Shift+Tab は
  // 前の入力欄への移動なので、Tab は修飾に関わらず解除する。
  const cursorMove = ARROW_DIRS[ev.key] !== undefined || ev.key === "Home" || ev.key === "End";
  if (ev.key === "Escape" || ev.key === "Tab" || (!ev.shiftKey && cursorMove)) clearBlockSel();
  // caret 発の矩形選択中の文字入力・Backspace・Delete は「カーソル位置での通常の入力」。
  // 選択を解除して欄へ戻し、そのキーを欄へ渡す（欄の keydown が型検証・上書き/挿入を行う）。
  // 合成イベントは bubbles:false——欄の @keydown は直接リスナーなので届き、ペインへは戻らない。
  if (selFromCaret && isProtectedEdit(ev)) {
    ev.preventDefault();
    restoreCaretFromBlockSel();
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && !el.readOnly) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ev.key, cancelable: true }));
    } else {
      notice.value = MSG_PROTECTED; // カーソルが欄上に無いなら従来どおり操作員メッセージ
    }
    return;
  }
  // 欄外（保護領域・非入力セル）での文字入力・Backspace・Delete は ACS 同様に
  // 操作員メッセージを出す。入力欄にフォーカスがあるときは ScreenGrid が出す。
  if (!editableFocused() && isProtectedEdit(ev)) {
    ev.preventDefault();
    notice.value = MSG_PROTECTED;
    return;
  }
  rawKeydown(ev);
}

// ACS 同様、マウスホイールで PageUp/PageDown を送る。連続発火はクールダウンで 1 ページ/ジェスチャに抑制
let wheelCooldownUntil = 0;
function onWheel(ev: WheelEvent): void {
  if (Math.abs(ev.deltaY) < 4) return; // 微小ジッタは無視
  // **オプション選択肢のリスト上ではリスト自身をスクロールさせる。**
  // ここで preventDefault すると native スクロールが死に、さらにホストへ Roll（PageUp/Down）が
  // 飛んでしまう——リストを送っただけで画面が送られるのは明らかに誤り。
  if (ev.target instanceof HTMLElement && ev.target.closest(".opt-hints")) return;
  ev.preventDefault(); // 端末はスクロールせずページ送りに割り当てる（ACS 準拠）
  if (busy.value || snapshot.value?.keyboardLocked) return; // 通信中・ロック中は送らない
  const now = Date.now();
  if (now < wheelCooldownUntil) return;
  wheelCooldownUntil = now + 120;
  emit("focus");
  sendKey(props.sessionId, ev.deltaY > 0 ? "PageDown" : "PageUp", cursor.value);
}
</script>

<template>
  <div
    ref="paneEl"
    class="pane"
    :data-focused="focused"
    :data-controls="view.controls"
    :data-color-mode="view.colorMode"
    :data-surface="view.surface"
    :data-buttons="view.buttons"
    :data-window-frame="view.windowFrame"
    :data-window-backdrop="view.windowBackdrop"
    :style="screenMonoStyle"
    tabindex="0"
    @keydown.capture="onKeydownCapture"
    @pointerdown.capture="noteUserActivity"
    @keydown="onKeydown"
    @paste="onPanePaste"
    @copy="onPaneCopy"
    @mousedown="emit('focus')"
    @wheel="onWheel"
  >
    <!-- ログを開いているときは、画面をクリックすると閉じる -->
    <div class="screen-wrap" @click="logOpen && (logOpen = false)">
      <ScreenGrid
        v-if="snapshot"
        ref="gridRef"
        v-model:insert-mode="insertMode"
        :snapshot="snapshot"
        :edits="state!.edits"
        :focused="focused"
        :busy="busy"
        :cursor="cursor"
        :show-shift-marks="view.sosi"
        :sbcs-view="sbcsView"
        :uppercase-input="uppercaseInput"
        :linkify="view.linkify"
        :buttons="view.buttons"
        :window-frame="view.windowFrame"
        :window-backdrop="view.windowBackdrop"
        :opt-hints="view.optHints"
        @edit="onEdit"
        @cursor="onCursor"
        @field-full="onFieldFull"
        @field-prev="onFieldPrev"
        @gui-select="onGuiSelect"
        @gui-submit="onGuiSubmit"
        @selection-cleared="onSelectionCleared"
        @selection-start="onSelectionStart"
        @notice="onNotice"
        @aid="onFkeyAid"
      />
      <div v-else class="pane-empty">接続待ち…</div>
      <!--
        ウォーターマーク（セッション設定）。**重ねるだけ**で文字・桁・ホスト色に触れない。
        画面領域いっぱいに敷くため .screen-wrap の中に置く（フッターは覆わない）。
      -->
      <WatermarkOverlay v-if="watermark" :watermark="watermark" />
      <!-- 通信中プロテクト（0.5 秒超で loading クラス＝スピナー表示） -->
      <div v-if="busy" class="busy-overlay" :class="{ loading }" aria-busy="true">
        <div v-if="loading" class="spinner" role="status" aria-label="通信中"></div>
      </div>
      <!--
        このセッションの操作ログ。**画面領域の中**に重ねる。
        .pane 直下に置くとフッター（StatusBar）を覆ってしまう。
      -->
      <LogPanel :session-id="sessionId" :open="logOpen" @close="logOpen = false" @click.stop />
      <!--
        システム要求行。**画面領域の中**の最下部に重ねる（実機・ACS の見え方に合わせる）。
        LogPanel と同じく .pane 直下ではなく .screen-wrap の中に置き、フッターを覆わないようにする。
      -->
      <SysReqLine :open="sysReqOpen" @submit="onSysReqSubmit" @cancel="onSysReqCancel" />
    </div>
    <StatusBar
      v-if="state"
      :state="state"
      :insert-mode="insertMode"
      :cursor="cursor"
      :notice="effectiveNotice"
      :log-count="logCount"
      :log-open="logOpen"
      @toggle-log="logOpen = !logOpen"
      @sysreq="onAid('SysReq')"
    />
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid var(--crt-line);
  border-radius: 6px;
  overflow: hidden;
  background: var(--crt);
}
.pane[data-focused="true"] {
  border-color: var(--t-green);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--t-green) 35%, transparent);
}
.pane:focus {
  outline: none;
}

/* ============================================================
 * 画面設定（セッションごと）: 配色 と 画面の質感
 *
 * どちらも .pane にカスタムプロパティを上書きするだけで、子の ScreenGrid（別 scope）の
 * セル色・グローまで一括で変わる——カスタムプロパティは scope をまたいで DOM を継承するため。
 * .c-* / .a-reverse(--cell) / .grid-span(text-shadow: --t-glow) はいずれもトークンを参照
 * しているので、ルール自体を複製せずに追従する。
 * ============================================================ */

/* --- 配色=意味色: 5250 の 7 色を役割ベースへ再マップ ---
 *  端末の高コントラスト前景(--t-white)・画面地色(--crt)・アプリのアクセント(--accent) から
 *  組むため、どのテーマ/スキンでも画面と整合する（明暗が破綻しない）。
 *   通常(green) → 前景を少し和らげた色  / 値・リンク(turquoise) → アクセント
 *   装飾(pink)  → アクセント寄り        / 強調(white)・エラー(red)・注意(yellow)・青(blue) は据え置き
 *   （青は情報色として区別が要る場面が多いので意味色でも残す） */
.pane[data-color-mode="semantic"] {
  --t-green: color-mix(in srgb, var(--t-white) 76%, var(--crt));
  --t-turquoise: var(--accent);
  --t-pink: color-mix(in srgb, var(--accent) 62%, var(--t-white));
}

/* --- 画面の質感=フラット: CRT のにじみ(グロー)とベゼル枠を外し、やわらかい影のカードにする ---
 *  グロー除去は --t-glow を 0 にして .grid-span（子 scope）へ継承させる（light テーマと同じ挙動）。 */
.pane[data-surface="flat"] {
  --t-glow: 0 0 0;
  border-color: var(--line);
  border-radius: 12px;
  box-shadow:
    0 14px 34px -20px rgba(0, 0, 0, 0.55),
    0 2px 6px -3px rgba(0, 0, 0, 0.2);
}
.pane[data-surface="flat"][data-focused="true"] {
  border-color: var(--accent);
  box-shadow:
    0 0 0 3px var(--accent-soft),
    0 14px 34px -20px rgba(0, 0, 0, 0.55);
}
/* フッター(OIA)のベゼル感も抑える（枠線をクロームの線色に寄せる） */
.pane[data-surface="flat"] :deep(.oia) {
  border-top-color: var(--line);
}
/* 画面フォント(--screen-mono)は script 側でインライン上書き（screenFonts.ts の全フォントを動的に扱うため）。 */

.pane-empty {
  color: var(--muted);
  padding: 20px;
  font-family: var(--mono);
}
/* ScreenGrid とオーバーレイを重ねるためのラッパ（grid の flex:1 を維持） */
.screen-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  /* グリッドをコンテンツサイズに縮めたうえで中央寄せ（余白を上下・左右均等に） */
  align-items: center;
  justify-content: center;
}
/* 通信中プロテクト: ポインタ操作をブロック。0.5 秒までは透明、loading で薄く覆う */
.busy-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  cursor: progress;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  transition: background 0.2s ease;
}
.busy-overlay.loading {
  background: color-mix(in srgb, var(--crt) 55%, transparent);
}
.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid color-mix(in srgb, var(--t-green) 30%, transparent);
  border-top-color: var(--t-green);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2s;
  }
}
</style>
