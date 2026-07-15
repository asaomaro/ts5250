import type { AidKey } from "@as400web/core";
import { keybindingsStore } from "../stores/keybindings.js";

export type LocalAction = "home" | "end" | "tab" | "shift-tab" | "left" | "right" | "up" | "down";

/** キーイベントを AID キー・ローカル操作・null（非対象）に分類する（純関数・テスト可能） */
export function classifyKey(ev: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): { aid?: AidKey; local?: LocalAction } {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return {};
  const k = ev.key;

  // F1–F12（Shift で F13–F24）
  const fm = /^F([1-9]|1[0-2])$/.exec(k);
  if (fm) {
    const n = Number(fm[1]);
    return { aid: `F${ev.shiftKey ? n + 12 : n}` as AidKey };
  }
  switch (k) {
    case "Enter":
      return { aid: "Enter" };
    case "PageUp":
      return { aid: "PageUp" };
    case "PageDown":
      return { aid: "PageDown" };
    case "Home":
      return { local: "home" };
    case "End":
      return { local: "end" };
    case "Tab":
      return { local: ev.shiftKey ? "shift-tab" : "tab" };
    case "ArrowLeft":
      return { local: "left" };
    case "ArrowRight":
      return { local: "right" };
    case "ArrowUp":
      return { local: "up" };
    case "ArrowDown":
      return { local: "down" };
    default:
      return {};
  }
}

export interface KeymapHandlers {
  /** AID キー送信（カーソル位置を伴う）。F プロンプト等のため現在カーソルを渡す */
  sendAid(key: AidKey): void;
  /** ローカルのカーソル/フィールド操作 */
  local(action: LocalAction): void;
  /** このペインがフォーカス中か（捕捉はフォーカスペインのみ） */
  isFocused(): boolean;
}

/**
 * キーダウンを捕捉し、対象キーは preventDefault してブラウザ既定動作より 5250 操作を優先する
 * （spec: F1 ヘルプ・F5 リロード・PageUp スクロール等を抑止）。フォーカスペインのみ作用。
 */
export function makeKeydownHandler(h: KeymapHandlers): (ev: KeyboardEvent) => void {
  return (ev: KeyboardEvent) => {
    if (!h.isFocused()) return;
    // カスタムキーバインドを既定より優先
    const custom = keybindingsStore.resolve(ev);
    if (custom) {
      ev.preventDefault();
      h.sendAid(custom);
      return;
    }
    const { aid, local } = classifyKey(ev);
    if (aid) {
      ev.preventDefault();
      h.sendAid(aid);
    } else if (local) {
      // Tab・矢印・Home/End はブラウザ既定（フォーカス移動・スクロール）より 5250 操作を優先
      ev.preventDefault();
      h.local(local);
    }
  };
}
