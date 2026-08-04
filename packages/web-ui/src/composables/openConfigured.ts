import { ref, type Ref } from "vue";
import { systemsStore } from "../stores/systems.js";
import { sessionsStore } from "../stores/sessions.js";
import { workspaceStore } from "../stores/workspace.js";
import { watchesStore } from "../stores/watches.js";
import { openSession, openPrinterSession } from "../session-controller.js";

/**
 * **保存済みセッション設定を開く唯一の経路**（`20260802-printer-report-history`）。
 *
 * もとはランチャーの中だけにあった。サービス一覧からもプリンターを開けるようにするにあたって
 * 書き写すと、「開いていればタブへ戻す」「装置名の二重掴みを断る」「監視はセッションとして
 * 開かない」という**判断が 2 か所**になる。どれも実機で踏んだ失敗から入った規則なので、
 * 片方だけ直る形にはしない。
 */

/**
 * その設定で既に開いているセッション（あれば）。
 *
 * **システムを切り替えて戻ってきたときの誤操作を防ぐのが目的。** 戻るとメニューに出るのは
 * この設定カードだけで、タブが生きていることが見えない。そこで「接続」を押すと 2 本目が開き、
 * 装置名を固定していればホストが「使用中」としてネゴシエーション中にソケットを切る
 * （`SESSION_CLOSED: closed during negotiation`）。開いているならタブへ戻す。
 */
export function openedSession(ref: string): string | undefined {
  return sessionsStore.all.find((x) => x.configRef === ref && x.connected)?.sessionId;
}

/** 同じ装置名で既に開いているセッション（別設定でも衝突する）。 */
function deviceNameInUse(deviceName: string | undefined): string | undefined {
  if (deviceName === undefined) return undefined;
  return sessionsStore.all.find((x) => x.connected && x.meta?.deviceName === deviceName)?.label;
}

/** 既存タブを前面に出してワークスペースへ移る */
export function focusSession(sessionId: string): void {
  const g = workspaceStore.groups().find((x) => x.tabs.includes(sessionId));
  if (g) {
    workspaceStore.setActiveTab(g.id, sessionId);
    workspaceStore.focus(g.id);
  }
  workspaceStore.showLauncher = false;
}

/**
 * 開いている最中の設定 ref と、直近の失敗。
 *
 * **モジュール共有にしてある。** 呼び出しごとに新しい ref を作ると、
 * ランチャーとサービス一覧から同時に押せてしまい、装置名の二重掴みを止められない
 * ——「いま 1 本開いている最中」はアプリに 1 つしかない状態。
 */
const connecting = ref("");
const openError = ref("");

export function useOpenConfigured(): {
  connecting: Ref<string>;
  error: Ref<string>;
  open: (ref: string, force?: boolean) => Promise<void>;
} {
  return { connecting, error: openError, open };
}

/** セッション設定から接続する。**資格情報は送らない**——サーバーが参照から解決する */
async function open(ref: string, force = false): Promise<void> {
  // 二重クリックで同じ装置名のセッションを 2 本開くと、2 本目がホスト側で弾かれる
  if (connecting.value) return;
  // **選択中システムで絞らない**——サービス一覧には別システムのプリンターも並ぶ。
  // `systemsStore.sessions` は全システムぶんを持っている（`currentSessions` だけが絞る）
  const s = systemsStore.sessions.find((x) => x.ref === ref);
  if (!s) return;
  // 既に開いているならタブへ戻す（明示的に「新しいセッション」を選んだときだけ 2 本目を開く）
  const opened = openedSession(ref);
  if (opened !== undefined && !force) {
    focusSession(opened);
    return;
  }
  // **監視は装置名を持たない。** 重複判定を通すと、装置名 undefined 同士で
  // 誤って「使用中」に見えるうえ、そもそも 1 装置 1 接続の制約が無い（research F5）。
  // 監視はサーバーのレジストリが所有するので、セッションとしては開かない
  if (s.sessionType === "dtaqwatch" || s.sessionType === "msgwatch") {
    connecting.value = s.ref;
    openError.value = "";
    try {
      // **同じ設定の待ち受けを二重に始めない。** データ待ち行列は消費するので、2 本掛かると
      // 1 本ぶんのエントリを取り合って両方が欠ける（セッションで「開いていればタブへ戻す」のと同じ判断）。
      // メッセージ側は消費しないが、**同じものが 2 度通知される**ので同じく 1 本にする
      const already = watchesStore.watches.some((x) => x.ref === s.ref);
      if (!already) await watchesStore.start(s.ref);
      else await watchesStore.connect();
      openWatchConsole(); // 監視コンソールを開く（開いていればそこへ移動）
    } catch (e) {
      openError.value = e instanceof Error ? e.message : String(e);
    } finally {
      connecting.value = "";
    }
    return;
  }
  const busyLabel = deviceNameInUse(s.deviceName);
  if (busyLabel !== undefined) {
    openError.value =
      `装置名 ${s.deviceName} は「${busyLabel}」が使用中です。` +
      `ホストは 1 つの装置に 1 接続しか許さないため、先に切断してください。`;
    return;
  }
  connecting.value = s.ref;
  openError.value = "";
  try {
    const openMsg = { type: "open" as const, kind: s.sessionType, session: s.ref };
    const meta = {
      // **そのセッション自身のシステムから引く**（選択中システムではない）。
      // サービス一覧は別システムのプリンターも並べるので、選択中を見ると別の機械の名前が付く
      host: systemsStore.systems.find((x) => x.ref === s.system)?.host ?? "",
      ...(s.deviceName !== undefined ? { deviceName: s.deviceName } : {})
    };
    if (s.sessionType === "printer") {
      await openPrinterSession(openMsg, s.name, meta, s.system, s.ref);
    } else {
      await openSession(openMsg, s.name, meta, s.system, s.ref);
    }
    workspaceStore.showLauncher = false;
  } catch (e) {
    openError.value = e instanceof Error ? e.message : String(e);
  } finally {
    connecting.value = "";
  }
}

/**
 * 監視コンソールのタブを開く（開いていればそこへ移動）。
 * **システムに紐づけない**——監視はサーバーのレジストリが所有し、1 枚で全部を出す。
 */
function openWatchConsole(): void {
  const tab = "watch:queues";
  const existing = workspaceStore.groups().find((g) => g.tabs.includes(tab));
  if (existing) {
    workspaceStore.setActiveTab(existing.id, tab);
    workspaceStore.focus(existing.id);
  } else {
    workspaceStore.addSession(tab);
  }
  workspaceStore.showLauncher = false;
}
