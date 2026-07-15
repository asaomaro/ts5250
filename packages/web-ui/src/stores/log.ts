import { reactive } from "vue";

export type LogDir = "tx" | "rx" | "event";

export interface LogEntry {
  id: number;
  ts: number;
  sessionId: string;
  dir: LogDir;
  kind: string;
  summary: string;
  /** 往復時間（rx で key→screen 応答時に付与） */
  roundtripMs?: number;
  /** 展開用の整形 JSON（hidden フィールド値はマスク済み） */
  detail?: unknown;
  error?: boolean;
}

const MAX = 500;
let seq = 0;

export const logStore = reactive({
  entries: [] as LogEntry[],

  add(e: Omit<LogEntry, "id">): void {
    this.entries.push({ ...e, id: ++seq });
    if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
  },

  clear(): void {
    this.entries.splice(0, this.entries.length);
  },

  /** JSONL 文字列（不具合報告用ダウンロード） */
  toJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n");
  }
});

/**
 * 送信メッセージから、ログ格納前に hidden フィールドの値を伏字化する（spec: 平文パスワードを記録しない）。
 * fields 配列内の value を、hiddenIndexes に含まれる field を対象にマスクする。
 */
export function maskOutgoing(msg: unknown, hiddenIndexes: ReadonlySet<number>): unknown {
  if (typeof msg !== "object" || msg === null) return msg;
  const m = msg as { fields?: { field: unknown; value: string }[] };
  if (!Array.isArray(m.fields)) return msg;
  return {
    ...m,
    fields: m.fields.map((f) =>
      typeof f.field === "number" && hiddenIndexes.has(f.field) ? { ...f, value: "●●●●" } : f
    )
  };
}
