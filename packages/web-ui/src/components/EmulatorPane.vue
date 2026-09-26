<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { AidKey, Field, ScreenSnapshot } from "@ts5250/tn5250";
import ScreenGrid from "./ScreenGrid.vue";
import StatusBar from "./StatusBar.vue";
import LogPanel from "./LogPanel.vue";
import SysReqLine from "./SysReqLine.vue";
import WatermarkOverlay from "./WatermarkOverlay.vue";
import { viewSettings, resolveSbcsView } from "../stores/viewSettings.js";
import { screenFontStack } from "../composables/screenFonts.js";
import { logStore } from "../stores/log.js";
import { sessionsStore, type HeldKey } from "../stores/sessions.js";
import { systemsStore } from "../stores/systems.js";
import { resolveWatermark } from "../composables/watermark.js";
import {
  isEscapeAidEvent,
  localEditActionOf,
  makeKeydownHandler,
  numpadFieldSign,
  typeAheadKind,
  type LocalAction
} from "../composables/useKeymap.js";
import { moveCursor, fieldAt, fieldAtCaret, caretInField, roundToDbcsLead, nextWordStart, endInProtectedField, type Dir, type CursorBounds } from "../composables/useCursor.js";
import {
  sendKey,
  selectGuiChoice,
  submitGuiSelection,
  noteActivity,
  retryReconnect,
  breakReservation as breakReservationFor
} from "../session-controller.js";
import { play } from "../macro-engine.js";
import { blocksManualInput } from "../macro-record.js";
import { isKatakanaCcsid } from "../hostCodePages.js";
import { isDbcsCcsid, progressionTarget, progressionNumberOf } from "@ts5250/tn5250/browser";
import { OVERLAY_SELECTOR } from "../composables/focusTrap.js";
import { MSG_PROTECTED, MSG_RESERVE_BREAK, msgReserved, isOperatorError, MSG_MANDATORY_FILL, MSG_SELF_CHECK } from "../composables/opMessages.js";
import { findFieldViolation, needsFieldExit, type MandatoryFinding } from "../composables/mandatoryCheck.js";
import { fieldSlices, fieldSpan, posOfOffset } from "../composables/fieldSlices.js";
import { continuedRunOf, isTabStopField } from "../composables/continuedRun.js";

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
 *
 * **直接指定で開いたセッション（`configRef` なし。VSCode拡張の`.ts5250`等）は
 * `meta.watermark` へ持ち回る**（`20260924-vscode-extension` D16）。保存済みセッション設定と
 * 違い、設定を保存し直しても既に開いているセッションへは反映されない
 * （`meta` は接続時点のコピーのため）——次に開き直したときに反映される。
 */
const watermarkConfig = computed(() => {
  const cfgRef = state.value?.configRef;
  const fromConfig = cfgRef ? systemsStore.sessions.find((s) => s.ref === cfgRef)?.watermark : undefined;
  return fromConfig ?? state.value?.meta?.watermark;
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
/**
 * 予約（HLLAPI の `Reserve`）で自動操作に締め出されているか。
 *
 * `busy`（ホスト応答待ち）と分ける理由: busy は一瞬で解けるので黙って待たせてよいが、
 * 予約は分単位で続きうる。**なぜ打てないかを出し、解除の口も出す**必要がある。
 */
const reservedBy = computed(() => state.value?.reservedBy);
// 通信中（ホスト応答待ち）は入力プロテクト。loading は 0.5 秒超でスピナー表示
const busy = computed(() => state.value?.busy ?? false);
/** 入力を止める条件。**打鍵の入口すべてがここを見る**（経路ごとに書くと足し忘れる） */
const inputBlocked = computed(() => busy.value || reservedBy.value !== undefined);
const breakReservation = (): void => breakReservationFor(props.sessionId);
const loading = computed(() => state.value?.loading ?? false);
// ACS の「930 — 日本語（カタカナ）」（290 扱い・CHARSET 332）を選んでいるときだけ、
// 実機同様に英小文字を大文字化し、コードページに無い 8 記号を拒否する
// （`20260922-katakana-variant-setting`・`20260922-katakana-selector-merge`）。
// 未指定・`"katakana-ex"`・930 以外は「930 — 日本（拡張カタカナ）」と同じ（現状どおり）。
// 5026 は対象外——ACS はこの CCSID の存在自体を知らない（`hostCodePages.ts` 参照）。
const katakanaRestricted = computed(
  () => state.value?.ccsid === 930 && state.value?.katakanaVariant === "katakana"
);
const uppercaseInput = katakanaRestricted;
// SBCS だけのセッションか（CCSID が分かっているときだけ。分からなければ従来どおり DBCS と同じ扱い）
const sbcsSession = computed(() => state.value?.ccsid !== undefined && !isDbcsCcsid(state.value.ccsid));
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
/**
 * **5250 のセッションか**（3270 も同じペインで描く。`meta.terminal` 未指定は 5250）。
 * Home の Record Backspace・テンキーの Field± は 5250 だけの操作なので、3270 では従来の動きに留める（節目の独立点検の指摘）
 */
const is5250 = computed(() => (state.value?.meta?.terminal ?? "5250") === "5250");
/** IBM i の 3270 でだけ割り当てのあるキー（サーバーの `tn3270-adapt.ts` の `IBMI_ONLY` と同じ集合） */
const IBMI_ONLY_3270: ReadonlySet<string> = new Set(["Attn", "SysReq", "Help", "Print"]);

function onEdit(fieldIndex: number, value: string): void {
  state.value?.edits.set(fieldIndex, value);
  noteFieldTyped(fieldIndex);
}

/*
 * **欄を出るまで AID を送らない欄の付け外し**（ACS のエラー 0020。`20260921-aid-without-field-exit`）。
 *
 * ACS は欄ごとに `fieldExitReqFlag` を持つ。**打鍵で下り**（`setMDT`）、**欄を出る操作で立つ**
 * （Tab・Backtab・Home・Newline・カーソル移動・Field Exit / Field± / Dup）。欄の中の矢印では立たない。
 * AID の時点で、カーソル下の欄が右寄せ・符号付き数値でフラグが下りていれば送らない（実機で確認。research F2）。
 * 見るのはカーソル下の 1 欄だけなので、ここでは「いまカーソルがいる欄に打った」ことを 1 つだけ持ち、
 * **カーソルが欄を出たら外す**。判定は送信の合流点（`sendKey`）が行う。
 */
/** 打鍵で値が変わった。カーソルがいるその欄が右寄せ・符号付き数値なら待ちを付ける */
function noteFieldTyped(fieldIndex: number): void {
  const st = state.value, snap = snapshot.value;
  if (!st || !snap) return;
  // **右端の境界も欄の中**（`fieldAtCaret`）。`edit` は `cursor` より先に届くので、ここで見るカーソルは
  // 動く前の位置——右矢印で境界へ出てから Backspace を押すと、境界で値が変わる。欄の外と数えると
  // 待ちが付かず、そのまま Enter が左詰めで送られていた（独立点検の指摘。ACS は Backspace の `setMDT` で
  // `fieldExitReqFlag` を下ろすので 0020。実機でも満杯→Backspace→Enter は 0020。場合 D）
  const here = fieldAtCaret(cursor.value.row, cursor.value.col, snap.fields, snap.cols, snap.rows);
  // カーソルのいない欄への書き込み（Erase Input 等）は打鍵ではない
  if (here?.index !== fieldIndex) return;
  if (needsFieldExit(here)) st.awaitingFieldExit = fieldIndex;
  else delete st.awaitingFieldExit;
}
/** 欄を出た（Field Exit / Field± / Dup / 満杯の自動送り / 最終桁まで打った）。ACS はこれらでフラグを立てる */
function noteFieldExited(): void {
  if (state.value) delete state.value.awaitingFieldExit;
}
// **カーソルが待ちの欄を出たら外す**。Tab・矢印・クリック・欄頭の Backspace など経路を問わない
// ——どれもカーソル位置の変化として現れる。欄の中での移動では外さない（ACS も欄の中の矢印では
// フラグを立てない。実機で右矢印のあとも 0020 だった。research F2 の場合 5）
/**
 * **欄を出るときの MF・自己点検**（ACS `PS5250.moveCursorWithMandFillCheck`。Tab・Backtab・Home・Newline・
 * カーソル移動・Dup・満杯の自動送り・マウスでの移動が通る。`20260921-mandatory-check-acs`）。~~Field Exit も通る~~ は実機と食い違っていた——
 * ACS の Field Exit・Field± は MF を出る前に自分で見るだけで、この検査も自己点検も呼ばない〔`onFieldFull` の注記。`20260921-field-exit-checks` の節目 10 の独立点検 B-S5〕。
 * 出た欄が部分入力の MF か検査桁の合わない自己点検なら、操作員エラーにして**その欄の先頭へ戻す**
 * （実機の ACS: MF に `AB` と打って Tab → 欄の先頭でエラー。research F2 の場合 6）。
 * 経路ではなくカーソル位置の変化で見る（0020 の待ちと同じ考え方）。**新しい画面での移動は対象外**
 * （打ちかけは捨てられている）。
 */
/**
 * **こちらから動かしたカーソルは「欄を出た」と数えない**（違反の欄へ戻す移動・新しい画面の着地）。
 * 数えると、違反のある欄が 2 つあるとき戻す移動が次の検査を呼び、2 つの欄の間で往復し続ける
 * （独立点検の指摘。ACS も戻す移動を `moveCursorWithMandFillCheck` に通さない）。
 * カーソルの変化は次の tick の監視で届くので、その tick が終わるまで黙らせる。
 */
let leaveCheckMutes = 0;
function muteLeaveCheck(): void {
  leaveCheckMutes++;
  void nextTick(() => {
    leaveCheckMutes--;
  });
}
/**
 * キー操作の中で動かすカーソル用の mute。Vue の `nextTick` は、フラッシュが**まだ予約されていなければ**その場の微タスクとして走り、
 * 後から予約される監視のフラッシュより先に解ける。通常のキー操作ではカーソルの同期（`sync` の `emit("cursor")`）が先にフラッシュを予約するので
 * 1 段でも足りるが、カーソルが変わらない同期の後はその保証が無い——2 段にして、どちらでも監視のフラッシュが済むまで黙らせる（保険。テストでは
 * 1 段との差は出ない）。数えて重ねる（別の mute が先に解いても他方は残る。これもテストでは区別できない）
 */
function muteLeaveCheckThroughKeyMove(): void {
  leaveCheckMutes++;
  void nextTick(() => {
    void nextTick(() => {
      leaveCheckMutes--;
    });
  });
}
watch([cursor, snapshot], ([pos, snap], [oldPos, oldSnap]) => {
  const st = state.value;
  if (leaveCheckMutes > 0 || !st || !snap || snap !== oldSnap || !oldPos) return;
  const from = fieldAtCaret(oldPos.row, oldPos.col, snap.fields, snap.cols, snap.rows);
  if (!from) return;
  if (fieldAtCaret(pos.row, pos.col, snap.fields, snap.cols, snap.rows)?.index === from.index) return;
  const hit = findFieldViolation(from, st.edits, snap.fields);
  if (!hit) return;
  showNotice(hit.reason === "mandatory-fill" ? MSG_MANDATORY_FILL : MSG_SELF_CHECK);
  focusMandatoryViolation(hit); // 欄の先頭へ
});
watch(cursor, (pos) => {
  const st = state.value, snap = snapshot.value;
  if (st?.awaitingFieldExit === undefined || !snap) return;
  // 右端の境界も欄の中（満杯の FER 欄で止まっただけでは出たことにしない）
  const here = fieldAtCaret(pos.row, pos.col, snap.fields, snap.cols, snap.rows);
  if (here?.index !== st.awaitingFieldExit) {
    delete st.awaitingFieldExit;
    return;
  }
  // **キャレットが右端の境界に出たら「出た」ことになる**（`20260921-field-exit-required-types`）。
  // 矢印で最終桁の外へ出た: ACS では欄の外のセルへ移る＝欄を出た（`processCursorMove` が `1007 && endPos` で立てる）。
  // ~~最終桁まで打った: 境界へ出る~~ → 最終桁まで打ったときはカーソルは最終桁に留まり、ScreenGrid が
  // `field-exited` で知らせる（ACS `fieldExited`。実機で RZ は 3,25・6S0 は 19,25 に留まった）。
  // ~~符号付き数値は数字桁を埋めても 0020 のまま（場合 11）~~ は読み違い——場合 11 は 7 桁の 6S0 に
  // 5 桁しか打っていなかった。6 桁打てば送れる（実機で確認。`scripts/acs-probe/field-exit-full.txt` の場合 A）
  if (!fieldAt(pos.row, pos.col, snap.fields, snap.cols, snap.rows)) delete st.awaitingFieldExit;
});
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
function onFieldFull(fieldIndex: number, viaFieldExit = false, leaving = false): void {
  // 単独欄で自分へ巡回しても「出た」ことになる（ACS `processFieldPlusMinusAndExit` がフラグを立てる）
  noteFieldExited();
  // **Field Exit・Field± で出るときは、出た後の MF・自己点検を掛けない**——ACS `processFieldPlusMinusAndExit` は MF を出る前に自分で見る
  // （`fieldExitRejection`）だけで、`moveCursorWithMandFillCheck` も `checkModulusField` も呼ばない（javap で確認。検査桁の合わない自己点検欄でも
  // Field Exit は次の欄へ進む）。出た後の検査を掛けると、消去・右寄せの後の値で MF を見直して止め、自己点検も止めていた
  // （`20260921-field-exit-checks` の節目 10 の独立点検 B-S5）。Dup・満杯の自動送りは従来どおり掛ける
  if (viaFieldExit) muteLeaveCheckThroughKeyMove();
  // ホストが指定したカーソル送り（FLDCSRPRG）が最優先。無ければ画面順の次へ
  const to = progressionStop(fieldIndex);
  if (to) { focusStop(to); return; }
  const flds = editableFields();
  const els = editableInputs();
  const cur = flds.findIndex((f) => f.index === fieldIndex);
  if (cur < 0 || els.length === 0) return;
  focusInput(els, leaving ? indexAfterLeaving(flds, cur) : (cur + 1) % els.length);
}

/**
 * **欄を出る操作（Field Exit・Field±・Dup）の行き先**（ACS `FFT5250.nextNonByPassInputFieldPos`）: カーソルより後ろの入力欄のうち、
 * **継続欄の 2 区間目以降を飛ばして**最初のもの。無ければ画面の最初の入力欄へ巡回する。鎖の途中の区間から出ても行き先は次の区間ではなく鎖の後ろ
 * （実機の ACS のコアで、日付欄の 1・2 区間目・最後の区間から Field Exit して行き先が次の欄・巡回だった。`scripts/acs-probe/continued-field-erase-exit.txt`）。
 * 打鍵で満杯になったときの自動送りは、ACS も次の区間へ進むので従来どおり（`(cur + 1)`）
 */
function indexAfterLeaving(flds: readonly { continued?: string }[], cur: number): number {
  for (let j = cur + 1; j < flds.length; j++) {
    const c = flds[j]!.continued;
    if (c !== "middle" && c !== "last") return j;
  }
  return 0;
}

function onGuiSelect(fieldId: number, choiceIndex: number, selected: boolean): void {
  selectGuiChoice(props.sessionId, fieldId, choiceIndex, selected);
}
function onGuiSubmit(fieldId: number): void {
  submitGuiSelection(props.sessionId, fieldId, cursor.value);
}
// 新しいホスト画面が来たらユーザーのカーソル上書きをリセットする
watch(snapshot, (snap) => {
  // 新しい画面の着地（カーソルの上書きを外す）も「欄を出た」ではない
  muteLeaveCheck();
  cursorOverride.value = undefined;
  // **挿入モードも画面ごとに上書きへ戻す**（`20260921-insert-mode-per-screen`）。
  // ACS は `DS5250.initKeyboard`（`resetInsertMode` を呼ぶ）を、書式の開始・WEC・
  // `processClearFMT` から呼ぶので、**新しい画面は必ず上書きモードで始まる**。
  // 残ると、前の画面で入れた挿入モードのまま次の画面で打つことになり、
  // 「挿入で欄が満杯のとき弾く」規則と重なって**打てない・意図せず押し出す**が起きる。
  insertMode.value = false;
  // **CLEAR UNIT で操作員エラーも抜ける**（ACS `DS5250.processClearUnit` が `clearErrorMode()` を呼ぶ）。
  // 抜けないと、自動の繋ぎ直しや無操作のサインオフでサインオン画面になったあと、最初の打鍵が
  // メッセージも出ないまま拒否される（独立点検の指摘）。ホストのエラーはコアが `systemMessage` を捨てるので
  // ここでは要らない。~~SAVE SCREEN~~ はスナップショットに印が無いので見ていない（利用者のキーを経ずに
  // 操作員エラー中に SAVE が来る経路は、今のところ思い当たらない）
  // **操作員エラーだけを抜ける**——同じレコードに CLEAR UNIT と WEC が載っていると、`exitErrorMode` は
  // いま届いたホストのエラーまで隠してしまう
  if (snap?.lastWrite?.cleared === true && errorMode.value) clearNotice();
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
    // **EDTMSK で分割された欄は先頭区間だけを停止点にする。** ホストは区切り文字（`/`）を挟んだ
    // 別々の欄として送ってくるが、ACS は並び全体で**1 つの入力欄**なので、区切りごとに Tab が
    // 止まるのは実機と違う（`22/22` の日付欄で Tab を 3 回押さないと次の項目へ行けなかった）。
    // 打鍵の自動送り（満杯 → 次区間）は別経路（`onFieldFull`）なので、ここを絞っても影響しない。
  ).filter((el) => {
    const f = fieldOfStop(el);
    return f === undefined || isTabStopField(f);
  });
}

/** 停止点の入力欄が担当している欄（ボタン等は undefined） */
function fieldOfStop(el: HTMLElement): Field | undefined {
  if (!(el instanceof HTMLInputElement)) return undefined;
  const idx = Number(el.dataset["fieldIndex"]);
  return snapshot.value?.fields.find((f) => f.index === idx);
}

/**
 * いまフォーカスがある停止点の位置。**分割欄の中間・最終区間に居るときは、その並びの
 * 先頭区間を現在地とみなす**（停止点から外してあるので素の `indexOf` では見つからない）。
 * こうすると Tab は並びの次の欄へ、~~Shift+Tab は並びの前の欄へ~~——単独欄と同じ動きになる。
 * （Shift+Tab は、中間・最終区間からは並びの先頭区間へ戻る。ACS の Backtab。`backtab` が先に処理する）
 */
function currentStopIndex(stops: HTMLElement[]): number {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return -1;
  const direct = stops.indexOf(active);
  if (direct !== -1) return direct;
  const f = fieldOfStop(active);
  if (!f || f.continued === undefined) return -1;
  const first = continuedRunOf(snapshot.value?.fields ?? [], f)[0];
  if (!first) return -1;
  return stops.findIndex((el) => fieldOfStop(el)?.index === first.index);
}

/**
 * **カーソル送り（FLDCSRPRG / FCW 0x88nn）の行き先。**
 *
 * ホストが「この欄を出たら画面順の次ではなくこの欄へ」と指定してくる仕組み。
 * 入力の順序をアプリの都合で決める画面（伝票の明細と合計を行き来する等）で使われ、
 * 無視すると **Tab で飛ぶ先が実機と違う**。
 *
 * 参照実装 2 つとも「Tab（次の欄）」と「満杯・Field Exit での自動送り」の両方で見る
 * （GNU tn5250 `display.c` の `tn5250_display_set_cursor_next_field` と
 * `tn5250_display_interactive_addch`、tn5250j `ScreenFields.gotoFieldNext`）。
 * 送り先が無い・保護欄なら**画面順どおりに倒す**（原典も見つからなければ `sf.next` へ落ちる）。
 *
 * ~~⚠ **Shift+Tab（逆方向）には効かせない。** tn5250j は逆引き（自分を指している欄を探す）まで
 * するが GNU tn5250 は前方だけで、**どちらが実機と同じかを確かめる手段が無い**（ACS 不可）。
 * 確かめられないほうは実装しない側へ倒す（`fieldSign` の num-only と同じ判断）。~~
 * → ACS は逆向きにも辿る（`FFT5250.previousNonByPassInputFieldPos`。欄の先頭で Backtab すると、
 * そこへ送る欄へ戻る）。逆引きは `backtab` が持つ（`20260921-backtab-acs`）。
 */
function progressionStop(fromFieldIndex: number): HTMLElement | undefined {
  const fields = snapshot.value?.fields ?? [];
  const from = fields.find((f) => f.index === fromFieldIndex);
  const to = from?.cursorProgression;
  if (to === undefined) return undefined;
  // 番号は継続欄の 2 区間目以降を数えない並びで引く（ACS `getStandardFieldList`。`index` とは前に継続欄があるとずれる）
  const target = progressionTarget(fields, to);
  if (!target || target.protected) return undefined;
  return inputForSlice(target.index, 0);
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

/**
 * **Backtab**（ACS `PS5250.processBacktab` → `FFT5250.previousNonByPassInputFieldPos(カーソル−1)`。
 * `20260921-backtab-acs`）。行き先は「カーソルの 1 つ手前以前で始まる最後の入力欄の先頭」:
 * - **欄の途中ならその欄の先頭で止まる**（実機の ACS: 7,22 → 7,20。欄の直後の桁 7,26 からも 7,20）
 * - 継続欄は並び全体で 1 つの欄（2 区間目以降はどこからでも先頭の区間の先頭へ。ACS は先頭以外の区間を飛ばす）
 * - 欄の先頭なら前の欄。**そこへカーソル送り（FCW 0x88）で来る欄があれば、そちらへ**（ACS は逆向きにも辿る）
 * - 前に無ければ最後の欄へ回り込む。欄の外（自由カーソル）からは `focusByOffset` の位置での探索が同じ規則
 * ~~以前は常に前の停止点へ移り、カーソル送りの逆引きは「ACS で確かめられない」として入れていなかった~~
 * （原典と実機で確かめた。`scripts/acs-probe/backtab-home.txt`）
 */
function backtab(): void {
  const active = document.activeElement;
  const f = active instanceof HTMLInputElement ? fieldOfStop(active) : undefined;
  if (f && !f.protected) {
    const first = f.continued !== undefined ? (continuedRunOf(snapshot.value?.fields ?? [], f)[0] ?? f) : f;
    if (first.index !== f.index || gridRef.value?.caretAtFieldStart() !== true) {
      focusFieldStart(first);
      return;
    }
    const n = progressionNumberOf(snapshot.value?.fields ?? [], first);
    const from = n === undefined ? undefined : editableFields().find((x) => x.cursorProgression === n);
    if (from && inputForSlice(from.index, 0)) {
      focusFieldStart(from);
      return;
    }
  }
  focusByOffset(-1);
}

/**
 * **Home**（ACS `PS5250.processHome`。`20260921-home-record-backspace`）。
 * - カーソルがホーム位置（IC で指された番地、無ければ先頭の入力欄。`snapshot.home`）に無ければ、そこへ移る。
 *   欄の中からでも**欄の先頭ではなく画面のホーム位置**へ行く（実機の ACS: ADJPGM の 7,22 → 3,20）。出た欄は「出た」扱い
 * - **既にホーム位置なら Record Backspace（AID 0xF8）を送る**（実機の ACS のワイヤ: `… 03 14 07 f8`。
 *   ホストが受けなければ「機能キーは使用できません」が返る）
 * ~~以前は欄の中なら欄の先頭、欄の外なら先頭の入力欄へ移るだけだった~~
 */
function homeKey(): void {
  const snap = snapshot.value;
  if (!snap) return;
  // 3270 には Record Backspace もホーム位置の申告も無い。従来どおり先頭の入力欄へ移るだけ（独立点検の指摘:
  // 3270 で送るとサーバーが「知らない AID」として断り、エラーの通知が出ていた）
  if (!is5250.value) {
    focusInput(editableInputs(), 0);
    return;
  }
  const first = editableFields()[0];
  const home = snap.home ?? (first ? { row: first.row, col: first.col } : { row: 1, col: 1 });
  const at = cursor.value;
  if (at.row === home.row && at.col === home.col) {
    onAid("RecordBackspace");
    return;
  }
  noteFieldExited(); // ACS は出た欄の `fieldExitReqFlag` を立てる
  onCursor(home.row, home.col);
  // DBCS 欄は caret を明示的に置く（頭出しと同じ理由。reconcileFocus はフォーカス中の DBCS 欄の caret を触らない）
  const land = fieldAt(home.row, home.col, snap.fields, snap.cols, snap.rows);
  if (land && !land.protected && land.dbcsType) gridRef.value?.setDbcsCaretAtColumn(land.index, home.row, home.col);
}

/**
 * **欄の外で押した End**（欄の中の End は ScreenGrid が欄の末尾へ置く）。
 *
 * ~~最後の入力欄の先頭へ~~ → ACS `PS5250.processEndField`: 欄の外なら `FFT5250.nextNonByPassInputFieldPos`——**カーソルより後で始まる
 * 最初の入力欄**（継続欄は先頭の区切りだけ。無ければ先頭の入力欄へ巡回）へ行き、その欄の末尾（入力の直後。最後の桁まで埋まっていれば最後の桁）に置く
 * （`20260921-end-outside-field`）。末尾の求め方（DBCS・行をまたぐ欄）は ScreenGrid が持つので、着いた欄の input に End を渡す。
 * 3270 は従来どおり最後の入力欄へ（ACS の 3270 の End は別の処理）
 */
function endKey(inputs: HTMLInputElement[]): void {
  const snap = snapshot.value;
  if (!snap) return;
  if (!is5250.value) {
    focusInput(inputs, inputs.length - 1);
    return;
  }
  // 保護（バイパス）欄の上なら、その欄の中の末尾へ（ACS `FFT5250.getField` は保護欄も返す。節目の点検の指摘）
  const here = fieldAt(cursor.value.row, cursor.value.col, snap.fields, snap.cols, snap.rows);
  if (here?.protected) {
    const to = endInProtectedField(here, cursor.value.row, snap.cells, snap.cols);
    onCursor(to.row, to.col);
    return;
  }
  const heads = editableFields().filter((f) => f.continued === undefined || f.continued === "first");
  if (heads.length === 0) return;
  const at = (cursor.value.row - 1) * snap.cols + (cursor.value.col - 1);
  const target = heads.find((f) => (f.row - 1) * snap.cols + (f.col - 1) > at) ?? heads[0]!;
  focusFieldStart(target);
  // **伝えない（bubbles: false）**——欄の input の直接のリスナー（ScreenGrid）だけが受ける。伝えると、欄が処理しない状態
  // （施錠中など）で End がペインへ戻り、また `endKey` が走って無限に繰り返した（節目の点検の指摘）
  inputForSlice(target.index, 0)?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: false, cancelable: true }));
}

/**
 * 欄の先頭（スライス 0）へフォーカスし、**ペインのカーソル位置も合わせる**。
 * 既にフォーカスのある input へ `focus()` しても focus イベントは出ず、ScreenGrid はカーソルを知らせない——
 * 欄の途中から同じ欄の先頭へ戻る Backtab で、ペインのカーソルが古い桁のまま残り、直後の Enter が
 * 古い桁を送っていた（独立点検の指摘。ACS は欄の先頭を送る）。focus イベントが出る場合は ScreenGrid が知らせる
 */
function focusFieldStart(target: Field): void {
  const el = inputForSlice(target.index, 0);
  const already = el !== undefined && document.activeElement === el;
  focusStop(el);
  if (already) onCursor(target.row, target.col);
}

/** 順次移動（Tab / Shift+Tab / 欄外での左右）。末尾↔先頭でラップ */
function focusByOffset(delta: number): void {
  const stops = tabStops();
  if (stops.length === 0) {
    // 行き先が 1 つも無い画面（確認画面等）。原点へ置く。
    onCursor(1, 1);
    return;
  }
  const cur = currentStopIndex(stops);
  if (cur !== -1) {
    // ホストがカーソル送りを指定した欄からの前進だけは、その行き先を優先する
    const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : stops[cur];
    if (delta > 0 && active instanceof HTMLInputElement) {
      const to = progressionStop(Number(active.dataset["fieldIndex"]));
      if (to) { focusStop(to); return; }
    }
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
      backtab();
      // ACS は Backtab で着いた欄の `fieldExitReqFlag` を立てる（欄の途中から同じ欄の先頭へ戻っても 0020 にならない）
      noteFieldExited();
      break;
    case "newline": {
      // **次の行の先頭から見て最初の入力欄へ移る。ホストへは送らない**
      // （`20260921-shift-enter-newline`）。ACS `PS5250.processNewline` は次の行の先頭位置を
      // 起点に `FFT5250.nextNonByPassInputFieldPos` で次の入力欄を探す。
      // 下に入力欄が無ければ先頭へ巡回する（ACS もループで回り込む）。
      // ※ 次の行の先頭が「前の行から続く行またぎ欄の中」に当たる場合、ACS はその欄の中へ
      //   置くが、ここでは次の行で始まる欄だけを見る（行またぎ欄は開始行で判定）。未対応の差として残す
      const fields = editableFields();
      if (fields.length === 0) break;
      const row = cursor.value.row;
      const i = fields.findIndex((f) => f.row > row);
      focusInput(inputs, i < 0 ? 0 : i);
      break;
    }
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
      homeKey();
      break;
    case "end":
      endKey(inputs);
      break;
    // ローカル編集キー（ホストへ送らない）。値の編集は ScreenGrid、欄の移動はここ、の分担。
    case "field-exit":
      // 次の欄への移動は ScreenGrid が出す field-full → onFieldFull が担う
      gridRef.value?.fieldExit();
      break;
    case "erase-eof":
      gridRef.value?.eraseEof();
      break;
    case "delete-word":
      gridRef.value?.deleteWord();
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
      // 着地は ScreenGrid がホーム位置（IC で指した欄、無ければ先頭の入力欄）へ置く。
      // ここで先頭の入力欄へ寄せると、その着地を上書きしてしまう（ACS: `getHomePos()`）
      gridRef.value?.eraseInput();
      noteFieldExited(); // ACS は MDT ごと下ろすので、0020 の対象から外れる
      break;
  }
}

/** キー設定で割り当てた表示設定の順送り。切り替わった内容を OIA に通知する（次のキー操作で消える）。 */
function onViewCycle(key: string): void {
  const r = viewSettings.cycle(key);
  if (r) showNotice(`${r.label}: ${r.valueLabel}`); // 情報の通知なのでエラー状態には入らない
}

// ---- システム要求行（SysReq） ----
function onAid(key: AidKey): void {
  // ボタン経由（マウス）ではペインの keydown を通らずローカル通知が残る。残したままだと
  // 応答が無かったときのサーバー発の通知（effectiveNotice）を覆い隠すので、ここで消す。
  // **AID はエラー状態も抜ける**（ACS `PS5250.processAIDCode` → `clearErrorMode`）
  exitErrorMode();
  clearNotice();
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
  muteLeaveCheck(); // 戻す移動は「欄を出た」ではない
  // 0020 はカーソルを動かさない（ACS は打った位置のまま。実機で確認）——いま居る欄の話なので
  if (hit.reason === "field-exit-required") return;
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
 * Alt+PageUp/Down（タブ切替）と Alt+Shift+矢印（ペイン移動）はペインではなく App のグローバルハンドラが
 * 担うため、行を開いていて `onKeydown` が早期 return していても発火する。そのとき離れたペインの行が
 * フォーカスを引き戻すと、切替先のペインがキーボードを取れなくなる。
 * （Alt+矢印 単独は `e448749d` で語頭ジャンプに割り当てたので、ペイン移動は Alt+Shift+矢印。上の App.vue 参照）
 */
watch(
  () => props.focused,
  (focused) => {
    if (!focused) sysReqOpen.value = false;
  }
);

/**
 * キーの一覧（`その他のキー`）から押されたキー（`20260802-key-palette`）。
 *
 * **キーボードで押したのと同じ道を通す。** ボタン専用の対応表を別に持つと、
 * キー設定（`ctrl+F1` 等）を変えたときに片方だけ古くなる——
 * `rawKeydown` に流せば、割り当ての解決も既定の分類も 1 か所で済む。
 *
 * `preventDefault` は形を合わせるためのダミー（本物のイベントではないので抑えるものが無い）。
 */
function onPaletteKey(k: { key: string; ctrlKey?: boolean; altKey?: boolean }): void {
  // **施錠中は先打ちとして溜める**（キーボードで押したのと同じ扱い。capture を通らないのでここで見る）
  if (shouldHold()) {
    const like = { key: k.key, ctrlKey: k.ctrlKey === true, altKey: k.altKey === true, shiftKey: false, metaKey: false };
    const kind = typeAheadKind(like);
    if (kind === "hold") {
      pushTypeAhead({ ...like, code: "" });
      return;
    }
    if (kind === "help") {
      discardTypeAhead();
      return;
    }
    if (kind === "flag") discardTypeAhead();
  }
  rawKeydown({
    key: k.key,
    ctrlKey: k.ctrlKey === true,
    altKey: k.altKey === true,
    shiftKey: false,
    metaKey: false,
    preventDefault: () => {}
  } as KeyboardEvent);
}

/** キー設定で割り当てたマクロを再生する（ホストへは送らない。spec D10） */
function onPlayMacro(macroId: string): void {
  clearNotice();
  play(props.sessionId, macroId);
}

const rawKeydown = makeKeydownHandler({
  sendAid: onAid,
  local: onLocal,
  viewCycle: onViewCycle,
  playMacro: onPlayMacro,
  isFocused: () => props.focused,
  fieldSignKeys: () => is5250.value,
  // 汎用機の 3270 は Attn・SysReq・Help・Print を送れない（サーバーの `planKey3270` が拒否する）
  canSendAid: (key) => !(state.value?.meta?.terminal === "3270" && state.value?.ibmI3270 === false && IBMI_ONLY_3270.has(key))
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
/**
 * **操作員エラーの状態**（ACS の `error_mode`。`20260921-operator-error-mode`）。
 *
 * 操作員エラー（型違反・符号桁・満杯の挿入・保護域など）の通知で入り、キーボードを施錠する。
 * 実機で測った ACS の規則（`research.md` F3/F5）:
 *  - **欄を書き換えるキーは拒否**（文字・Backspace・Delete）。入力されず、エラーのまま
 *  - **カーソルを動かすキー・AID・Reset・クリックで抜ける**（矢印・Tab・Home で抜けて、カーソルも動く）
 *  - **エラーに入った時点で挿入モードが解ける**（抜けるときではない。`research.md` F6 で F4 の読みを訂正）
 * ACS の「施錠」は Reset だけで解く硬い錠ではない。情報の通知（表示設定の順送り等）では入らない。
 */
const errorMode = ref(false);
/** 通知を出す。操作員エラーならエラー状態に入り、**挿入モードを解く**（ACS の実測。`research.md` F6） */
function showNotice(text: string): void {
  notice.value = text;
  errorMode.value = isOperatorError(text);
  if (errorMode.value) insertMode.value = false;
}
/** 通知を消す（エラー状態も解く。挿入モードには触れない） */
function clearNotice(): void {
  notice.value = "";
  errorMode.value = false;
}
/** エラー状態を抜ける（挿入モードには触れない。解けるのはエラーに入ったとき＝`showNotice`） */
function exitErrorMode(): void {
  if (errorMode.value) clearNotice();
  // **ホストのエラーだったら、メッセージ行を元に戻す**（ACS `clearErrorMode` → `restoreMsgLinePosition`。
  // 実機でも矢印・Tab で抜けると最下行のメッセージが消えた。`20260921-host-error-mode`）
  const st = state.value, seq = snapshot.value?.systemMessageSeq;
  if (hostErrorActive.value && st && seq !== undefined) st.hostErrorDismissedSeq = seq;
}
/*
 * **ホストのエラー（WRITE ERROR CODE）でもエラー状態に入る**（`20260921-host-error-mode`）。
 *
 * ACS は `DS5250.processWriteErrorCode` で `setErrorMode(true)` とし、挿入モードも解く。実機（ULKPGM の
 * RANGE(1 5) に 9）でも inhibit=5・文字は拒否・挿入モードが解け、矢印・Tab で抜けると最下行のメッセージが消えた。
 * 規則は操作員エラー（上）と同じ。**同じ文言のエラーがもう一度来たら入り直す**——見分けはコアが WEC ごとに振る
 * 通し番号（`systemMessageSeq`）で行う。窓の中のエラーは実機では WTD で来たので、ここは通らない（ACS も同じ）。
 */
/**
 * **ホストのエラーの状態**。ペインでは持たず、スナップショットとセッションの状態から導く
 * （`SessionState.hostErrorDismissedSeq`。タブの切り替え・ペインの作り直しで食い違わないため。独立点検の指摘）。
 * 番号があって、抜けて隠した番号と違えばエラー中。**CLEAR UNIT・SAVE SCREEN で抜ける**のは、コアがそこで
 * `systemMessage` を捨てるから（ACS `processClearUnit` / `processSaveScreen` の `clearErrorMode`）。
 * 挿入モードは、WEC を載せた画面が届いた時点で `watch(snapshot)` が上書きへ戻している（ACS も WEC で解く）。
 */
const hostErrorActive = computed(() => {
  const snap = snapshot.value;
  if (!snap || snap.systemMessage === undefined || snap.systemMessageSeq === undefined) return false;
  return snap.systemMessageSeq !== state.value?.hostErrorDismissedSeq;
});
/** エラー状態（操作員エラーはペインの通知から、ホストのエラーはセッションの状態から） */
const inErrorMode = computed(() => errorMode.value || hostErrorActive.value);
function onNotice(text: string): void {
  showNotice(text);
}
// **同じペインでタブ（セッション）を切り替えたら、前のセッションのエラー状態と通知を持ち越さない**。
// ペインのインスタンスは使い回され、`sessionId` だけが差し替わる（独立点検の指摘）
watch(
  () => props.sessionId,
  () => {
    clearNotice();
    leftCtrlAlone = false;
  }
);
/**
 * **送信の合流点（`sendKey`）が止めた操作員エラーも、エラー状態に入れる。** `sendKey` は
 * ペインを通らない経路（OIA のボタン等）からも呼ばれるので、通知はセッション状態に載る。
 * 操作員エラーならローカルの通知へ移す——そうしないと、エラーを抜けてもセッション側の通知が
 * 残って見え続ける（ACS はエラーを抜けるとメッセージ行を戻す）。
 */
watch(
  () => state.value?.notice,
  (text) => {
    if (text === undefined || !isOperatorError(text)) return;
    showNotice(text);
    if (state.value) delete state.value.notice;
  }
);
/**
 * StatusBar へ渡す操作員メッセージ。ローカル発（欄の型違反・保護領域への入力）を優先し、
 * 無ければサーバー応答由来（ホスト無応答の通知。`SessionState.notice`）を出す。
 * ローカル発はキー操作で消え、サーバー発は次の送信で消える（session-controller）。
 */
const effectiveNotice = computed(() => notice.value || state.value?.notice || "");
/**
 * 画面の最下行に出す操作員メッセージ（ACS と同じ置き方）。
 *
 * **クライアント側が優先**し、無ければホスト側（`systemMessage`。WRITE ERROR CODE 由来）。
 * ACS は**どちらも同じ見た目で同じ行**に出すので、色でも区別しない。
 */
/** ホストのメッセージ（WRITE ERROR CODE）。エラー状態を抜けて隠したものは出さない（メッセージ行を元に戻す） */
const hostMessage = computed(() => {
  const snap = snapshot.value;
  if (!snap?.systemMessage) return "";
  if (snap.systemMessageSeq !== undefined && snap.systemMessageSeq === state.value?.hostErrorDismissedSeq) return "";
  return snap.systemMessage;
});
const messageLine = computed(() => effectiveNotice.value || hostMessage.value);

/** ScreenGrid 発の AID。キーボードの F キーと同じ扱いで送る。
 *  ボタン側で mousedown を preventDefault しているので、入力欄のフォーカス＝カーソルは動かない。
 *
 *  経路は 2 つある: **機能キー凡例のボタン**（利用者の操作）と、
 *  **AUTO_ENTER 欄が満杯になったときの自動 Enter**（FFW 0x0080。`advanceIfFull` / `fieldExitKey`）。
 *  後者も `busy` / `keyboardLocked` のプロテクトに乗せたいので、同じ入口へ合流させている。 */
function onFkeyAid(key: AidKey): void {
  if (inputBlocked.value || snapshot.value?.keyboardLocked) return;
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
  if (inputBlocked.value || snapshot.value?.keyboardLocked) return;
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

/**
 * 欄を書き換えるキーか（エラー中に拒否する側）。文字・Backspace・Delete（実機で確認。`20260921-operator-error-mode`
 * research F3/F5）に加えて、**ローカル編集キー**（Field Exit・Erase EOF・Erase Input・Field±・Dup）も拒否する。
 * ACS `PS5250.keyDown` はエラー中にこれらを警告音だけで捨て（`ErEOF_Key` / `ErInp_Key` / `EraseField_Key` /
 * `FldExit_Key` / `FldPlus_Key` / `FldMinus_Key` / `FldMark_Key` / `Dup_Key`）、実機の ACS でもどれも欄を
 * 変えずエラーのままだった（`scripts/acs-probe/field-exit-full.txt` の場合 F・H）。
 * ~~未測定のキーは抜ける側に倒す~~（`20260921-operator-error-mode` D2）は、原典と実測で破棄した。
 * それ以外の修飾キー付きは対象外（ショートカット）
 */
function isEditingKey(ev: KeyboardEvent): boolean {
  const local = localEditActionOf(ev);
  // **Delete Word は拒否しない**——エラーを抜けてから語を消す。ACS `PS5250.keyDown` のエラー中の拒否の一覧は Backspace・Erase EOF・Erase Input・
  // Erase Field・Delete・Field±・Field Exit・Dup・Field Mark と文字だけで、`[deleteword]`（63623）は入っていない。実機の ACS のコアでも、
  // 先頭の Backspace（0005）の後の `[delete]` は拒否（inhibit=5・値そのまま）、`[deleteword]` は inhibit=0 で語を消した（`scripts/acs-probe/delete-word.txt` の m。`20260921-delete-word`）
  if (local !== undefined) return local !== "delete-word";
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return false;
  return ev.key.length === 1 || ev.key === "Backspace" || ev.key === "Delete";
}
/** 修飾キー単独の押下か（エラー状態を抜けない。Reset の左 Ctrl もここに当たる） */
function isModifierOnly(ev: KeyboardEvent): boolean {
  return ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta" || ev.key === "CapsLock";
}
/**
 * **Reset は「左 Ctrl を単独で押して離す」**（ACS の既定割り当て。`20260921-operator-error-mode`）。
 * 素直に Ctrl の押下へ割り当てると **Ctrl+C のたびに Reset が走る**ので、左 Ctrl を押してから
 * **ほかのキーを挟まずに離したとき**だけ Reset とする。挟んだら（Ctrl+C 等）取り消す。
 */
let leftCtrlAlone = false;
/**
 * Reset キーの働き。**エラーでなくても挿入モードを解く**（ACS `ECLPS.reset` が常に解く。実機でも確認。
 * `research.md` F6）。そのうえでエラー状態を抜ける（`PS5250.processReset` → `clearErrorMode`）。
 */
function resetKey(): void {
  insertMode.value = false;
  discardTypeAhead(); // 溜めた先打ちを捨てる（`ECLPS.reset`。実機でも Reset の後は再生されなかった）
  exitErrorMode();
}

/**
 * 打鍵の捕捉。**操作員エラー中は ACS の規則で打鍵を振り分け**、それ以外は次のキーで通知を消す。
 * capture で拾うこと: 入力欄は Home/End/矢印などで stopPropagation するため、bubble の
 * onKeydown では欄内のキーを取りこぼす（メッセージが出るのはまさに欄内なので消えなくなる）。
 */
function onKeydownCapture(ev: KeyboardEvent): void {
  noteUserActivity();
  if (holdTypeAhead(ev)) return;
  leftCtrlAlone = ev.code === "ControlLeft";
  if (inErrorMode.value) {
    if (isEditingKey(ev)) {
      // **拒否**: 入力欄へ届かせず（stopPropagation）、文字の挿入も止める（preventDefault）。
      // メッセージは残し、エラーのまま（ACS: 文字・Backspace・Delete は入力されない）
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (isModifierOnly(ev)) return; // Shift 等の単独押下では抜けない
    // カーソルを動かすキー・AID 等: **抜けてから本来の働きをさせる**（矢印ならカーソルも動く）
    exitErrorMode();
    return;
  }
  clearNotice();
}
/*
 * **先打ち（type-ahead）**（`20260921-type-ahead`）。
 *
 * 応答待ち（`busy`）・ホスト施錠（`keyboardLocked`）の間に打ったキーを捨てずに溜め、**解錠したら
 * 同じキーとして再生する**。ACS の既定の振る舞い（`ECLPS.SendKeys` の `keyBuffer`・`DISABLE_SESSION_TYPE_AHEAD`
 * の既定は false）で、実機でも「施錠中の ABC が解錠後のコマンド行に入る」「施錠中の DSPLIBL+Enter が
 * 解錠後に送られる」「Enter の連打の 2 回目が送られる」を確かめた（research F2）。
 *
 * - **溜めるのは capture**（入力欄より先に見る）。溜めたキーは欄にもペインにも届かせない。
 *   **溜めはセッションごと**（`SessionState.typeAhead`）——ペインはタブの切り替えで使い回される。
 * - **溜めが残っている間は、生の打鍵も後ろへ積む**。解錠から再生までの隙間や再生の最中に打ったキーが
 *   溜めを追い越さないため（ACS も `keyBuffer` が空でない間は後ろに積む）。
 * - **再生は同じ入口を通す**——合成した keydown を、いまフォーカスのある欄（無ければカーソルの位置へ
 *   戻して）へ投げる。欄の型検査・操作員エラー・キー割り当て・0020 がそのまま効く。
 * - **1 キーごとに Vue の反映を待つ**（`await nextTick()`）。0020 の待ちを外すカーソル監視・操作員エラーへ
 *   入る通知の監視・Erase Input の着地はどれも次の tick で走るので、待たずに流すと次のキーが古い状態で
 *   処理される（独立点検の指摘）。
 * - **AID を再生して施錠したら止める**（残りは次の解錠で続きから。ACS も `SendKeys` の残りを `keyBuffer` に戻す）。
 * - **再生するのは、このペインがフォーカスを持つときだけ**。ACS はセッションの窓が前面でなくても流すが、
 *   当 PJ の欄の編集は DOM のフォーカスに乗っているので、よそのペインに居る間は戻ってくるまで待つ（D7）。
 * - **捨てる**: Reset・Attn・SysReq・Help（ACS と同じ）、切断・予約開始（ストア）。
 * - **溜めない**: 自動操作の予約中・マクロ再生中（利用者の打鍵を他人の画面へ流さない）、システム要求行。
 *   これらは従来どおり捨てる。IME の変換は溜めない（未確認）。Insert はその場で切り替える。
 */
/** 溜める上限（暴走した自動入力でメモリを食わないため。ACS の上限は未確認） */
const TYPE_AHEAD_MAX = 1000;
/** 施錠中（応答待ち・ホスト施錠）か */
const holding = computed(() => busy.value || snapshot.value?.keyboardLocked === true);
/** 再生が走っている間 */
let replaying = false;
/** 合成 keydown を配っている最中（その keydown を溜め直さないため） */
let dispatchingReplay = false;
function hasQueued(): boolean {
  return (state.value?.typeAhead?.length ?? 0) > 0;
}
function discardTypeAhead(): void {
  if (state.value) delete state.value.typeAhead;
}
/** 溜め・再生をしてよい相手か。予約中・マクロ再生中・システム要求行・切断中はしない */
function typeAheadAllowed(): boolean {
  return (
    reservedBy.value === undefined &&
    !blocksManualInput(props.sessionId) &&
    !sysReqOpen.value &&
    state.value?.connected === true &&
    // ホストへ繋ぎ直している間は溜めない（送り先が無い。ACS も通信が準備できていない間の打鍵は捨てる）
    state.value?.hostReconnect === undefined
  );
}
/** いまの打鍵を溜めるか。施錠中に加え、**溜めが残っている間**（再生待ち・再生中）も溜める */
function shouldHold(): boolean {
  return !dispatchingReplay && typeAheadAllowed() && (holding.value || hasQueued() || replaying);
}
function pushTypeAhead(k: HeldKey): void {
  const st = state.value;
  if (!st) return;
  const q = (st.typeAhead ??= []);
  if (q.length < TYPE_AHEAD_MAX) q.push(k);
}
/** 施錠中の打鍵を溜める（捨てる）。処理し終えたら true（以降の capture 処理をしない） */
function holdTypeAhead(ev: KeyboardEvent): boolean {
  if (!shouldHold()) return false;
  // 端末の打鍵だけ（ペインか画面の入力欄）。ボタン・ピッカー・行の入力には手を出さない
  const t = ev.target;
  const onTerminal = t === paneEl.value || (t instanceof HTMLInputElement && t.classList.contains("grid-input"));
  if (!onTerminal) return false;
  // **Insert は溜めずにその場で切り替える**（ACS `SendKeys` は `[insert]` を溜めない）。溜めると
  // 新しい画面で上書きモードへ戻った**後**に効いてしまい、溜めた文字が挿入で入る
  if (ev.key === "Insert" && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
    ev.preventDefault();
    ev.stopPropagation();
    insertMode.value = !insertMode.value;
    return true;
  }
  switch (typeAheadKind(ev)) {
    case "flag":
      discardTypeAhead(); // Attn / SysReq は溜めを捨てて、そのまま通す（応答待ちの逃げ道）
      return false;
    case "help":
      discardTypeAhead();
      leftCtrlAlone = false; // Ctrl 付きの割り当てでも、離したときに Reset にしない
      ev.preventDefault();
      ev.stopPropagation();
      return true;
    case "hold":
      ev.preventDefault();
      ev.stopPropagation();
      pushTypeAhead({
        key: ev.key, code: ev.code,
        shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, altKey: ev.altKey, metaKey: ev.metaKey
      });
      leftCtrlAlone = false;
      return true;
    default:
      return false;
  }
}
/** いま流してよいか: 解錠・このペインにフォーカス・溜めがある */
function canReplayNow(): boolean {
  return !holding.value && props.focused && typeAheadAllowed() && hasQueued();
}
/** 流す条件のどれかが変わったら試す。**新しい画面の欄フォーカス（nextTick）の後のタスク**で流す */
watch(
  [holding, () => props.focused, () => props.sessionId, () => state.value?.connected, reservedBy],
  () => {
    if (!replaying && canReplayNow()) setTimeout(() => void replayTypeAhead(), 0);
  }
);
async function replayTypeAhead(): Promise<void> {
  if (replaying) return;
  replaying = true;
  try {
    // 途中でタブ（セッション）が替わっても、溜めはセッションごとなので表示中のセッションの分を流すだけ
    while (canReplayNow()) {
      const k = state.value!.typeAhead!.shift()!;
      // 欄にもペインにもフォーカスが無ければ、カーソルの位置へ戻してから流す
      const active = document.activeElement;
      if (!(active instanceof HTMLElement && paneEl.value?.contains(active))) reconcileFocus(cursor.value);
      const el = document.activeElement;
      const target = el instanceof HTMLElement && paneEl.value?.contains(el) ? el : paneEl.value;
      dispatchingReplay = true;
      try {
        target?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: k.key, code: k.code, shiftKey: k.shiftKey, ctrlKey: k.ctrlKey, altKey: k.altKey,
            metaKey: k.metaKey, bubbles: true, cancelable: true
          })
        );
      } finally {
        dispatchingReplay = false;
      }
      await nextTick();
    }
  } finally {
    replaying = false;
  }
}

/** 左 Ctrl を単独で離したら Reset（上の `leftCtrlAlone` 参照） */
function onKeyupCapture(ev: KeyboardEvent): void {
  if (ev.code === "ControlLeft" && leftCtrlAlone) resetKey();
  leftCtrlAlone = false;
}
/** クリックでもエラー状態を抜ける（ACS `PS5250.canClearErrorModeViaMouseClick`） */
function onPointerdownCapture(): void {
  noteUserActivity();
  leftCtrlAlone = false; // Ctrl+クリックの後に Ctrl を離しても Reset にしない
  exitErrorMode();
}
function onKeydown(ev: KeyboardEvent): void {
  // システム要求行が開いている間は 5250 のキー処理を止める。**入力欄は .pane の子なので
  // keydown がここまでバブルしてくる**——素通しすると実行キーが「行の確定」と「5250 の Enter 送信」の
  // 両方に解釈され、二重に送ってしまう。
  //
  // 行の中で起きたキーは**行が閉じた後でも**触らない（`.sysreq` 由来かで判定する）。
  // 確定・取り消しのハンドラが先に走って sysReqOpen を false にしてから、同じイベントが
  // ここへバブルしてくるため。Esc を SysReq に割り当てていると（利用者の想定用途そのもの）、
  // 取り消しの Esc がそのまま再び行を開いてしまい、二度と閉じられなくなる。
  //
  // **この判定は入力プロテクトより先に置く。** 後ろに置くと、通信中は下の `preventDefault` が
  // 行への打鍵まで潰し、**「2. 前の要求の終了」の `2` が入力できない**——固まった要求から
  // 抜けるための行が、固まっている時だけ使えないことになる（実機で確認）。
  if (sysReqOpen.value || (ev.target instanceof HTMLElement && ev.target.closest(".sysreq"))) return;
  // 通信中は入力プロテクト（キー操作を無効化）。**Attn / SysReq だけは通す**——
  // 応答待ちの最中にこそ使う逃げ道で、core も ws も施錠中の送信を許している（`isEscapeAidEvent`）
  if (inputBlocked.value && !isEscapeAidEvent(ev)) {
    ev.preventDefault();
    return;
  }
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
  // **日付・時刻ピッカーも同じ扱い。** 開いている間はピッカー内のキー操作を優先する
  // （`Esc` はピッカー自身が閉じるために使う）。
  if (
    gridRef.value?.dtPickerOpen?.() &&
    ev.target instanceof HTMLElement &&
    ev.target.closest(".dtp")
  ) {
    return;
  }
  // **Alt+↓ でオプション欄のドロップダウン / 日付・時刻ピッカーを開く**（コンボボックスの慣用キー）。
  // フォーカスしただけでは開かない——一覧を移動するたびにリストが視界を塞ぐため。
  // `Alt+矢印` はペイン移動から `Alt+Shift+矢印` へ移してここを空けた（App.vue）。
  // **同じ欄で両方が成立することは無い**（Opt 欄は長さ 1〜2 の単独欄、ピッカーは継続欄）ので、
  // 順に試して開けたほうを採る。**新しいリスナーは足さない**——ここは既存の 1 か所。
  if (ev.altKey && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && ev.key === "ArrowDown") {
    if (gridRef.value?.openOptHints() || gridRef.value?.openDateTimePicker?.()) {
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
  // **日付・時刻ピッカーが開いている間の `Esc` は「ピッカーを閉じる」に使う。**
  // `optHints` がリスト内の Esc を握り潰すのと同じ趣旨——開いている間は他の Esc 割当
  // （下のブロック選択の解除等）を発火させない。ピッカーは `Alt+↓` で開くと**フォーカスが欄に残る**
  // （値を書くと `sync` が欄へフォーカスを戻すため）ので、ピッカー自身の keydown では届かない。
  // ここが唯一の経路になる。フォーカスがピッカーの中にあるときは上で早期 return 済み。
  if (ev.key === "Escape" && gridRef.value?.dtPickerOpen?.()) {
    gridRef.value.closeDtPicker(); // 時刻は確定するまで書かないので、閉じるだけで取り消しになる
    ev.preventDefault();
    return;
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
  // テンキーの − / ＋（5250）は文字ではなく Field− / Field+（独立点検の指摘: 下の合成 keydown は `code` を持たず、
  // 欄から先へも伝わらないので、そこへ流すと文字 `-` が入っていた）。選択を解いて欄へ戻し、`code` 付きで
  // **欄の input から伝わる**形で送り直す——欄がまず native caret から編集カーソルを取り直し（そうしないと Field− が
  // 欄の先頭から消す）、文字としては入れずにペインのキーマップへ渡す（そのときはもう選択中ではない）
  if (selFromCaret && numpadFieldSign(ev, is5250.value)) {
    ev.preventDefault();
    restoreCaretFromBlockSel();
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && !el.readOnly) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ev.key, code: ev.code, bubbles: true, cancelable: true }));
    } else {
      rawKeydown(ev);
    }
    return;
  }
  if (selFromCaret && isProtectedEdit(ev)) {
    ev.preventDefault();
    restoreCaretFromBlockSel();
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && !el.readOnly) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ev.key, cancelable: true }));
    } else {
      showNotice(MSG_PROTECTED); // カーソルが欄上に無いなら操作員エラー（エラー状態に入る）
    }
    return;
  }
  // 欄外（保護領域・非入力セル）での文字入力・Backspace・Delete は ACS 同様に
  // 操作員メッセージを出す。入力欄にフォーカスがあるときは ScreenGrid が出す。
  if (!editableFocused() && isProtectedEdit(ev)) {
    ev.preventDefault();
    showNotice(MSG_PROTECTED);
    return;
  }
  rawKeydown(ev);
}

// ACS 同様、マウスホイールで PageUp/PageDown を送る。連続発火はクールダウンで 1 ページ/ジェスチャに抑制
let wheelCooldownUntil = 0;
function onWheel(ev: WheelEvent): void {
  if (Math.abs(ev.deltaY) < 4) return; // 微小ジッタは無視
  // **画面に重ねた部品の上では、その部品自身をスクロールさせる。**
  // ここで preventDefault すると native スクロールが死に、さらにホストへ Roll（PageUp/Down）が
  // 飛んでしまう——部品を送っただけで画面が送られるのは明らかに誤り。
  // 対象は `OVERLAY_SELECTOR` に一元化してある（個別に足すと取りこぼす。実際ピッカーが漏れていた）。
  if (ev.target instanceof HTMLElement && ev.target.closest(OVERLAY_SELECTOR)) return;
  ev.preventDefault(); // 端末はスクロールせずページ送りに割り当てる（ACS 準拠）
  if (inputBlocked.value || snapshot.value?.keyboardLocked) return; // 通信中・予約中・ロック中は送らない
  const now = Date.now();
  if (now < wheelCooldownUntil) return;
  wheelCooldownUntil = now + 120;
  emit("focus");
  // **キーの AID と同じ入口（`onAid`）を通す**——エラー状態を抜けるため（ACS は Roll も
  // `processAIDCode` を通り `clearErrorMode` する）。直に `sendKey` すると、前の画面の
  // 操作員エラーが次の画面まで残り、最初の打鍵が拒否される（独立点検の指摘）
  onAid(ev.deltaY > 0 ? "PageDown" : "PageUp");
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
    :data-pointer="view.pointer"
    :style="screenMonoStyle"
    tabindex="0"
    @keydown.capture="onKeydownCapture"
    @keyup.capture="onKeyupCapture"
    @pointerdown.capture="onPointerdownCapture"
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
        :field-sign-keys="is5250"
        :busy="busy"
        :message="sysReqOpen ? '' : messageLine"
        :cursor="cursor"
        :show-shift-marks="view.sosi !== 'none'"
        :shift-mark-tone="view.sosi === 'strong' ? 'strong' : 'dim'"
        :sbcs-view="sbcsView"
        :uppercase-input="uppercaseInput"
        :katakana-restricted="katakanaRestricted"
        :sbcs-session="sbcsSession"
        :ccsid="state?.ccsid"
        :linkify="view.linkify"
        :buttons="view.buttons"
        :window-frame="view.windowFrame"
        :window-backdrop="view.windowBackdrop"
        :opt-hints="view.optHints"
        :dt-picker="view.dtPicker"
        :cursor-shape="view.cursorShape"
        :cursor-blink="view.cursorBlink"
        :rule-line="view.ruleLine"
        :rule-follow="view.ruleFollow"
        :rule-style="view.ruleStyle"
        :col-sep="view.colSep"
        @edit="onEdit"
        @cursor="onCursor"
        @field-full="onFieldFull"
        @field-exited="noteFieldExited"
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
        予約プロテクト（HLLAPI の Reserve）。**理由と解除の口を出す**——
        自動化が落ちると Release が届かず、期限（2 分）まで打てないままになる
      -->
      <div v-if="reservedBy" class="reserved-overlay" role="status">
        <div class="reserved-box">
          <span>{{ msgReserved(reservedBy) }}</span>
          <button type="button" @click="breakReservation">{{ MSG_RESERVE_BREAK }}</button>
        </div>
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
      @combo="onPaletteKey"
      @violation="focusMandatoryViolation"
      @reconnect="retryReconnect(sessionId)"
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
/* 予約プロテクト: 通信中と違い**理由を見せる**ので、最初から覆う */
.reserved-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: not-allowed;
  background: color-mix(in srgb, var(--crt) 65%, transparent);
}
.reserved-box {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.6rem 0.9rem;
  border: 1px solid color-mix(in srgb, var(--t-green) 45%, transparent);
  border-radius: 4px;
  background: var(--crt);
  color: var(--t-green);
  font-size: 0.9rem;
}
.reserved-box button {
  cursor: pointer;
}
/* 通信中プロテクト: ポインタ操作をブロック。0.5 秒までは透明、loading で薄く覆う。

   **砂時計は出さない（`cursor` は最後まで変えない）。** 待っているのはホストであって
   **ts5250 が応答しなくなっている訳ではない**（利用者の指摘）。OS の砂時計／`progress` は
   「このアプリが固まっている・処理中で反応しない」の合図なので、ここで出すと事実と違う
   ——実際、待ちの最中でも OIA の Attn / SysReq は押せるし、タブの切り替えも操作ログも動く。
   長い待ちは 0.5 秒超のスピナーと薄い覆い、それに OIA の 🔒 で示せば足りる。

   覆う前と同じ形（`text`）にするのは、**この覆いが画面領域（.screen-wrap）だけを覆う**
   から。その下は一面のテキストなので、下と同じにすれば変化そのものが見えない。
   `auto` や `inherit` だと、中身の無い要素なので矢印に化けて結局ちらつく。 */
.busy-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  cursor: text;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  transition: background 0.2s ease;
}
.busy-overlay.loading {
  background: color-mix(in srgb, var(--crt) 55%, transparent);
}
/* ポインター＝十字線（ACS「カーソル > ポインター」）。覆いの下の画面と同じ形にする
   （上の注記と同じ理由——覆いが出た瞬間にポインターが変わると、それ自体が変化として見える） */
.pane[data-pointer="crosshair"] .busy-overlay {
  cursor: crosshair;
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
