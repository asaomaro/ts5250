import { reactive } from "vue";
import type { PublicMacro } from "@ts5250/server";

/**
 * マクロ（画面操作の記録・再生）のストア。**サーバー保存・単一の真実**（spec D7）。
 *
 * localStorage を使わないのは、マクロに保存した秘密（パスワード）がサーバー側で
 * 暗号化管理されるため。本体をブラウザに置くと、マクロ削除で暗号文が孤児になり
 * 二重の真実ができる。表示設定（`viewSettings`）やキー割り当てが localStorage なのとは
 * 事情が違う——あちらは秘密を持たない。
 *
 * **このストアは秘密を一切持たない**。サーバーが返すのは `hasSecret`（有無）と
 * `steps[].secretFields`（どの欄に入るか）まで。値は再生時にサーバー内部で差し込まれる。
 */

/** 記録した秘密をどう扱うか（記録停止時にユーザーが欄ごとに選ぶ。spec D5） */
export type SecretChoice =
  /** サーバーで暗号化して保存し、再生時に自動で差し込む（サインオン自動化） */
  | "store"
  /** 保存せず、再生はその欄で休止してユーザー入力を待つ */
  | "prompt"
  /** 欄ごと記録しない（空のまま送る） */
  | "skip";

/** 作成時にサーバーへ送る 1 ステップ。`plainSecrets` はここでだけ現れる */
export interface CreateMacroStep {
  screen: {
    rows: number;
    cols: number;
    targets: { field: number; row: number; col: number; len: number }[];
  };
  fields: { field: number; value: string }[];
  /** 平文の秘密。**送ったら呼び出し側で即破棄する**（メモリに残さない） */
  plainSecrets?: { field: number; value: string }[];
  promptFields?: number[];
  key: string;
  sysReqText?: string;
  cursor: { row: number; col: number };
}

export interface CreateMacroForm {
  name: string;
  incomplete?: boolean;
  steps: CreateMacroStep[];
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export const macrosStore = reactive({
  macros: [] as PublicMacro[],
  /** サーバーに master key があるか。false なら「保存する」を選ばせない（spec D5） */
  canStoreSecrets: false,
  loaded: false,

  get(id: string): PublicMacro | undefined {
    return this.macros.find((m) => m.id === id);
  },

  async refresh(): Promise<void> {
    try {
      const res = await fetch("/api/macros");
      if (!res.ok) {
        this.macros = [];
        return;
      }
      const body = (await res.json()) as { macros: PublicMacro[]; canStoreSecrets: boolean };
      this.macros = body.macros;
      this.canStoreSecrets = body.canStoreSecrets;
      this.loaded = true;
    } catch {
      this.macros = [];
    }
  },

  async create(form: CreateMacroForm): Promise<PublicMacro> {
    const res = await fetch("/api/macros", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form)
    });
    if (!res.ok) throw new Error(await readError(res));
    const body = (await res.json()) as { macro: PublicMacro };
    await this.refresh();
    return body.macro;
  },

  async rename(id: string, name: string): Promise<PublicMacro> {
    const res = await fetch(`/api/macros/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error(await readError(res));
    const body = (await res.json()) as { macro: PublicMacro };
    await this.refresh();
    return body.macro;
  },

  async remove(id: string): Promise<void> {
    const res = await fetch(`/api/macros/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await readError(res));
    await this.refresh();
  }
});
