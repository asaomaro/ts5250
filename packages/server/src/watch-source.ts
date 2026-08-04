/**
 * **待ち受けの「待ち方」だけを切り出したもの。**
 *
 * `WatchRegistry` が持っている規則——寿命・再接続・指数バックオフ・状態・履歴・
 * 所有・購読・転送——は**どの種類でも同じ**で、種類ごとに違うのは
 *
 * - どう**開く**か
 * - どう**1 件待つ**か
 *
 * の 2 つだけ。ここに閉じ込めておくと、種類を足しても `WatchRegistry` は変わらない。
 *
 * ## 別のレジストリを作らない理由
 *
 * 種類ごとにレジストリを分けると、寿命の規則・状態の語彙・所有の判定が
 * **丸ごと二重化**する。規則が 2 か所に分かれた瞬間、片方だけ直る事故が起きる
 * （`ServiceState` をプリンターと共有語彙にしたのと同じ理由）。
 */
import { type DtaqConnection, dtaqDecodeEbcdic } from "@ts5250/hostserver";
import type { ConnectOptions } from "@ts5250/tn5250";
import type { DtaqWatchSpec } from "./config-types.js";
import { fromBytes, toBytes, type DtaqEncoding } from "./host-dtaq.js";

/** 待ち受けの種類 */
export type WatchKind = "dtaq" | "msgq";

/**
 * メッセージ待ち行列から届いた 1 件の付随情報。
 * **データ待ち行列には無い**（あちらは本文がバイト列でしかない）。
 */
export interface WatchMessageInfo {
  /** 8 桁 16 進のメッセージキー。**応答・削除に使える**（`MessagePane` と同じ表記） */
  key: string;
  /** `CPA3303` 等。即時メッセージは空 */
  id: string;
  /** 読める種別名（`INQUIRY` 等） */
  type: string;
  severity: number;
  /** **応答しないとジョブが止まったまま**になるもの */
  inquiry: boolean;
  /** 二次レベル（原因と回復方法） */
  help?: string;
  /**
   * **器に収まらず本文が切れた。** 黙って切ると「短いメッセージ」に見えてしまい、
   * 肝心のところが落ちていても気づけない
   */
  truncated?: boolean;
}

/** 届いた 1 件 */
export interface WatchItem {
  text: string;
  bytes: number;
  /** 送信者情報（データ待ち行列で save sender 有効なときだけ） */
  sender?: string;
  message?: WatchMessageInfo;
}

/**
 * 開いている 1 本。**`next()` は届くまでブロックする**（ポーリングしない）。
 */
export interface WatchLink {
  /**
   * 次の 1 件を待つ。
   *
   * **`undefined` を返してよい**——「待ったが対象ではなかった」ときに使う
   * （`onlyInquiry` で捨てた場合など）。呼び出し側は黙って呼び直す。
   */
  next(): Promise<WatchItem | undefined>;
  close(): void;
}

/** 種類ごとの「開き方」。**接続の張り直しをまたいで生きる**（カーソル等はここに置く） */
export interface WatchSource {
  readonly kind: WatchKind;
  open(): Promise<WatchLink>;
}

/**
 * データ待ち行列版。**挙動はこれまでと同じ**——
 * `read({ wait: -1 })` で無通信のままブロックして待つ。
 *
 * `wait < 0` は read タイムアウトを無効にするので、**相手が黙って消えても永久に待つ**。
 * それを検出するために core 側で TCP キープアライブを入れてある
 * （`transport/host-connection.ts`）。切れたら `WatchRegistry` が張り直す。
 */
export function dtaqSource(opts: {
  spec: DtaqWatchSpec;
  connect: ConnectOptions;
  open: (opts: ConnectOptions) => Promise<DtaqConnection>;
}): WatchSource {
  const encoding: DtaqEncoding = opts.spec.encoding ?? "utf8";
  const read = {
    name: opts.spec.name,
    library: opts.spec.library,
    wait: -1,
    ...(opts.spec.key !== undefined ? { key: toBytes(opts.spec.key, encoding) } : {}),
    ...(opts.spec.search !== undefined ? { search: opts.spec.search } : {})
  } as const;
  return {
    kind: "dtaq",
    async open(): Promise<WatchLink> {
      const conn = await opts.open(opts.connect);
      return {
        async next(): Promise<WatchItem | undefined> {
          const entry = await conn.read(read);
          if (!entry) return undefined;
          return {
            text: fromBytes(entry.data, encoding),
            bytes: entry.data.length,
            ...(entry.senderInfo !== undefined ? { sender: dtaqDecodeEbcdic(entry.senderInfo) } : {})
          };
        },
        close: () => conn.close()
      };
    }
  };
}
