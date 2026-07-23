/**
 * 書き出しプログラムが処理できないスプールを、プリンターセッションの代わりに拾い上げる。
 *
 * **なぜ要るか。** プリンターセッションは仮想プリンター装置に書き出しプログラムを回して
 * SCS を受け取る（push 型）。ところが装置に能力が無いスプールは書き出せず、ホストは
 * CPA3303（属性が装置でサポートされていない）を出して待ち状態になる。日本語機では
 * IGC（DBCS）付きの帳票がこれに当たり、**帳票が 1 枚も届かないまま後続も止まる**。
 *
 * 一方、スプール機能が使うネットワーク印刷サーバー経由の取得（pull 型）は書き出しプログラムを
 * 通さないので、同じスプールを問題なく読める（日本語実機で確認）。どちらも最後は同じ
 * `LogicalPage[]` になるので、**pull で読んで push と同じ帳票として配れば利用者から見た体験は変わらない**。
 *
 * 拾ったあとはメッセージに「H」（保留して次へ）を応答する。応答しないと書き出しプログラムは
 * 待ち続け、後続の帳票も止まったままになる。
 *
 * 保留したスプールはホスト側に残り続けるので、運用によっては溜まる。取得後に削除するかは
 * `action` で選べるが、**既定は保留**——削除は取り消せないので、利用者が明示的に選んだ
 * ときだけ行う。
 */
import type { ConnectOptions, SpoolId, SpoolEntry } from "@as400web/core";
import { openNetPrint } from "./host-connect.js";
import { listSpools, readSpoolPages, DEFAULT_SPOOL_CCSID } from "./host-spools.js";
import { childLog } from "./log.js";

const log = childLog({ component: "spool-rescue" });

/** 拾い上げた 1 件 */
export interface RescuedSpool {
  entry: SpoolEntry;
  pages: Awaited<ReturnType<typeof readSpoolPages>>;
  /** ホストが出していたメッセージ ID（CPA3303 等）。何を回避したかを記録に残す */
  messageId: string;
}

/**
 * 書き出しプログラムが処理できず待ちになっているスプールを拾う。
 *
 * @param outputQueue 監視する出力待ち行列（＝プリンターセッションの装置名）
 */
/**
 * 取得後にホスト側のスプールをどうするか。
 * - `hold`（既定）… 保留にして残す。あとから手で扱える
 * - `delete` … 削除する。**取り消せない**ので明示的に選んだときだけ
 */
export type RescueAction = "hold" | "delete";

export async function rescueStuckSpools(
  opts: ConnectOptions,
  outputQueue: string,
  o: { max?: number; ccsid?: number; action?: RescueAction } = {}
): Promise<RescuedSpool[]> {
  const page = await listSpools(opts, { outputQueue, user: "*ALL" }, o.max ?? 20);
  const waiting = page.items.filter((s) => s.status === "MESSAGE_WAIT");
  if (waiting.length === 0) return [];

  const rescued: RescuedSpool[] = [];
  const np = await openNetPrint(opts, o.ccsid ?? opts.spoolCcsid ?? DEFAULT_SPOOL_CCSID);
  try {
    for (const entry of waiting) {
      const id = idOf(entry);
      const message = await np.retrieveMessage(id).catch(() => undefined);
      if (!message) continue;
      // 用紙のロード要求など、書き出しプログラムが進めば済むものは拾わない。
      // ここが拾うのは「この装置では処理できない」＝待っていても解決しないものだけ。
      if (!BLOCKING_MESSAGES.has(message.id)) continue;

      let pages;
      try {
        pages = await readSpoolPages(opts, id, o.ccsid);
      } catch (err) {
        // 読めなければ**応答しない**。応答してしまうと中身を届けないままキューから外れる
        log.warn({ file: entry.fileName, err }, "詰まったスプールを読めなかった（応答は保留）");
        continue;
      }
      rescued.push({ entry, pages, messageId: message.id });

      // **まず「H」で応答する。** 応答しないと書き出しプログラムが待ち続け、後続も止まる。
      // 削除する設定でも先に応答が要る（待ち状態のまま消すと writer が宙に浮く）。
      let answered = true;
      await np.answerMessage(message, "H").catch((err: unknown) => {
        answered = false;
        log.warn({ file: entry.fileName, err }, "メッセージに応答できなかった");
      });

      // 削除は**応答できたときだけ**。応答に失敗した状態で消すと、writer が待っている対象を
      // 取り上げることになる
      if (o.action === "delete" && answered) {
        await np.deleteSpooledFile(id).catch((err: unknown) => {
          log.warn({ file: entry.fileName, err }, "取得後の削除に失敗した（保留のまま残る）");
        });
      }
      log.info(
        {
          file: entry.fileName,
          fileNumber: entry.fileNumber,
          messageId: message.id,
          pages: pages.length,
          action: o.action ?? "hold"
        },
        "書き出しできないスプールを取得した"
      );
    }
  } finally {
    np.close();
  }
  return rescued;
}

/**
 * 拾い上げの対象にするメッセージ。
 *
 * **待っていても解決しないものだけ**を挙げる。用紙タイプのロード要求（CPA3394）のように
 * 応答すれば先へ進むものは対象にしない——push 経路で普通に受け取れるので、pull で
 * 横取りすると同じ帳票を二重に配ってしまう。
 */
const BLOCKING_MESSAGES: ReadonlySet<string> = new Set([
  /** ファイルの属性がこの装置でサポートされていない（IGC/ページサイズ/CPI 等） */
  "CPA3303"
]);

function idOf(s: SpoolEntry): SpoolId {
  return {
    jobName: s.jobName,
    jobUser: s.jobUser,
    jobNumber: s.jobNumber,
    fileName: s.fileName,
    fileNumber: s.fileNumber
  };
}
