import type { WsOpen, WsServerMessage } from "@as400web/server";
import type { AidKey } from "@as400web/core";
import { WsClient } from "./ws-client.js";
import { sessionsStore, type SessionState } from "./stores/sessions.js";
import { workspaceStore } from "./stores/workspace.js";

const WS_URL = (): string => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
};

/** ローディング表示までの猶予（この時間内に応答が来ればスピナーを出さない） */
const LOADING_DELAY_MS = 500;
const loadingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 通信中フラグを設定。busy 中は入力プロテクト、0.5 秒超でローディング表示 */
function setBusy(sessionId: string, busy: boolean): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  const timer = loadingTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    loadingTimers.delete(sessionId);
  }
  s.busy = busy;
  if (busy) {
    s.loading = false;
    loadingTimers.set(
      sessionId,
      setTimeout(() => {
        const cur = sessionsStore.get(sessionId);
        if (cur?.busy) cur.loading = true;
        loadingTimers.delete(sessionId);
      }, LOADING_DELAY_MS)
    );
  } else {
    s.loading = false;
  }
}

/** 接続を開き、セッションを stores に登録してワークスペースに追加する */
export async function openSession(open: WsOpen, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let sessionId = "";
    const client = new WsClient(
      WS_URL(),
      {
        onServerMessage(msg: WsServerMessage) {
          switch (msg.type) {
            case "opened": {
              sessionId = msg.sessionId;
              const state: SessionState = {
                sessionId,
                label,
                snapshot: msg.screen,
                edits: new Map(),
                cursor: msg.screen.cursor,
                connected: true,
                readOnly: open.readOnly ?? false,
                client
              };
              sessionsStore.add(state);
              client.setHiddenIndexes(hiddenIndexes(msg.screen));
              workspaceStore.addSession(sessionId);
              resolve(sessionId);
              break;
            }
            case "screen": {
              sessionsStore.updateScreen(sessionId, msg.screen);
              client.setHiddenIndexes(hiddenIndexes(msg.screen));
              setBusy(sessionId, false);
              break;
            }
            case "jobinfo": {
              const s = sessionsStore.get(sessionId);
              if (s) s.job = msg.job;
              setBusy(sessionId, false);
              break;
            }
            case "closed": {
              const s = sessionsStore.get(sessionId);
              if (s) s.connected = false;
              setBusy(sessionId, false);
              break;
            }
            case "error":
              setBusy(sessionId, false);
              if (!sessionId) reject(new Error(`${msg.code}: ${msg.message}`));
              break;
          }
        }
      },
      label
    );
    client
      .connect()
      .then(() => client.send({ ...open }))
      .catch(reject);
  });
}

/** AID 送信（ローカル編集差分を fields に載せる） */
export function sendKey(sessionId: string, key: AidKey, cursor?: { row: number; col: number }): void {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return; // 通信中は多重送信しない（プロテクト）
  const fields = [...s.edits.entries()].map(([field, value]) => ({ field, value }));
  s.client.send({
    type: "key",
    key,
    ...(cursor ? { cursor } : {}),
    ...(fields.length > 0 ? { fields } : {})
  });
  setBusy(sessionId, true);
}

export function requestJobInfo(sessionId: string, refresh = false): void {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return;
  s.client.send({ type: "jobinfo", refresh });
  setBusy(sessionId, true);
}

/** GUI 選択フィールドの選択状態を変更（ローカル・ホスト送信なし） */
export function selectGuiChoice(
  sessionId: string,
  fieldId: number,
  choiceIndex: number,
  selected: boolean
): void {
  sessionsStore.get(sessionId)?.client.send({ type: "gui-select", fieldId, choiceIndex, selected });
}

/** GUI 選択フィールドを確定送信（AID/Enter を Read 応答として送る） */
export function submitGuiSelection(
  sessionId: string,
  fieldId: number,
  cursor?: { row: number; col: number }
): void {
  const s = sessionsStore.get(sessionId);
  if (!s || s.busy) return;
  s.client.send({ type: "gui-submit", fieldId, ...(cursor ? { cursor } : {}) });
  setBusy(sessionId, true);
}

export function closeSession(sessionId: string): void {
  const s = sessionsStore.get(sessionId);
  if (!s) return;
  const timer = loadingTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    loadingTimers.delete(sessionId);
  }
  s.client.send({ type: "close" });
  s.client.close();
  sessionsStore.remove(sessionId);
  workspaceStore.closeSession(sessionId);
}

function hiddenIndexes(screen: { fields: { index: number; hidden: boolean }[] }): number[] {
  return screen.fields.filter((f) => f.hidden).map((f) => f.index);
}
