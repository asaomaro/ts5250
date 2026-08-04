/**
 * **メッセージ待ち行列の待ち受け。**
 *
 * `20260804-message-queue` で一覧・応答はできるようになったが、**気づく手段が無かった**。
 * `QSYSOPR` に照会が入っても、誰かが画面を開いて「読む」を押すまで分からない——
 * 応答しないとジョブは止まったままなので、**気づくのが遅れること自体が損害**になる。
 *
 * ## ポーリングしない
 *
 * `QMHRCVM` は待ち時間を指定すると**届くまで無通信でブロックする**（実機で確認）。
 * データ待ち行列の監視（`read({ wait: -1 })`）と同じ形にできる。
 *
 * ## ただし**無限には待たない**（実機で踏んだ）
 *
 * 待ち時間を `-1` にすると、**ホスト側のジョブが待ち行列を掴んだまま**になる。
 * こちらが接続を切っても、ジョブは `QMHRCVM` の中で止まったままなので気づかない
 * ——その結果、**待ち行列が消せなくなる**:
 *
 * ```
 * DLTMSGQ MSGQ(TESTLIB/WCHMSGQ) → CPF2451「Message queue in use」が**永久に**続く
 * SNDMSG で 1 通投げる         → 待っていたジョブが返って終わり、直後に消せた
 * ```
 *
 * 待ち行列を消す・変えるといった保守が、**誰かが待ち受けているだけでできなくなる**のは
 * 割に合わない。そこで `WAIT_SECONDS` で区切り、時間切れならそのまま掛け直す。
 *
 * **通知の速さは変わらない**（届いた瞬間に返る）。掛かるのは、何も来ないときに
 * 1 分に 2 往復だけ——「ポーリングしない」の趣旨（ホストを叩き続けない）は保てている。
 *
 * 裏を返すと、**止めてから待ち行列を消せるようになるまで最大 `WAIT_SECONDS` 掛かる**。
 * この待ちは保守が止まる時間そのものなので、伸ばすときはそれを承知で。
 *
 * ## **消さない**
 *
 * メッセージ動作は `*SAME` 固定。待ち受けは**観測であって消費ではない**——
 * 読んだメッセージは一覧に残り、照会には後から応答できる。
 *
 * 設定で変えられるようにはしない。「待ち受けたら消える」を選べると、
 * **取り違えたときに戻せない**（`MessagePane` の削除に確認を出しているのと同じ理由）。
 */
import { As400Error, type ErrorCode } from "@ts5250/base";
import {
  buildReceiveParams,
  messageKeyToBytes,
  parseReceivedMessage,
  type CommandConnection,
  type MessageSelector
} from "@ts5250/hostserver";
import type { ConnectOptions } from "@ts5250/tn5250";
import type { MsgWatchSpec } from "./config-types.js";
import { childLog } from "./log.js";
import type { WatchItem, WatchLink, WatchSource } from "./watch-source.js";

const log = childLog({ component: "msg-watch" });

/**
 * 器の大きさ。実機の `QSYSOPR` で一番大きかったのは 2,001 バイト
 * （`CPA3303`＝二次レベル 1,645）なので、その倍を取る。
 * 足りなくても失敗はせず、本文が途中で切れる（`truncated` で分かる）。
 */
const BUFFER_BYTES = 4096;

/**
 * カーソルが行方不明になったときのホスト側の断り。
 * **指したメッセージが消されている**（誰かが `DSPMSG` で消した、等）。
 */
const KEY_GONE = "CPF2551";

/**
 * 1 回の待ち時間（秒）。**無限にしない理由は冒頭の注記**——
 * 掴んだままのジョブが残ると待ち行列が消せなくなる。
 *
 * 何も来なければ 1 分に 2 往復。**届いたときの速さはこの値に依らない**
 * （待っている最中に届けば即座に返る）。
 */
const WAIT_SECONDS = 30;

/**
 * **待っても直らない断り。** これらは `WatchRegistry` の `FATAL_CODES` に載る
 * エラーコードへ移し替えて、張り直しを止める——待ち行列が無い・権限が無いは、
 * 何度張り直しても同じ結果になる。
 *
 * ここに無いものは一時的とみなしてバックオフで張り直す（安全側）。
 */
const FATAL_MESSAGE_IDS: Record<string, ErrorCode> = {
  /** 待ち行列が見つからない */
  CPF2403: "NOT_FOUND",
  CPF9801: "NOT_FOUND",
  /** 権限が無い */
  CPF2189: "ACCESS_DENIED",
  CPF9802: "ACCESS_DENIED"
};

/**
 * メッセージ待ち行列版の `WatchSource`。
 *
 * **カーソル（最後に見たキー）はここに持つ**——接続の張り直しをまたいで生き残らせるため。
 *
 * 張り直しのたびに末尾から取り直すと、**切れている間に届いたぶんが消える**（通知の取りこぼし）。
 * 持ち越せば、切れている間のぶんがまとめて流れる——**取りこぼしより二重の方がまし**だが、
 * カーソルは単調なので実際には二重にもならない。
 */
export function msgqSource(opts: {
  spec: MsgWatchSpec;
  connect: ConnectOptions;
  open: (opts: ConnectOptions) => Promise<CommandConnection>;
}): WatchSource {
  const ccsid = opts.connect.ccsid ?? 37;
  const { name, library } = opts.spec;
  /** 最後に見たキー（8 桁 16 進）。**接続をまたいで残る** */
  let cursor: string | undefined;
  /** 既にあるぶんを流すかどうかは最初の 1 回だけ効く */
  let positioned = false;

  return {
    kind: "msgq",
    async open(): Promise<WatchLink> {
      const conn = await opts.open(opts.connect);

      const receive = async (selector: MessageSelector, key: string | undefined, wait: number) => {
        const params = buildReceiveParams({
          name,
          library,
          selector,
          ...(key !== undefined ? { key: messageKeyToBytes(key) } : {}),
          wait,
          action: "*SAME",
          bufferBytes: BUFFER_BYTES,
          ccsid
        });
        const { result, outputs } = await conn.call("QMHRCVM", "QSYS", params, {
          // **この 1 往復だけ**タイムアウトを外す（既定 20 秒では待ち切れない）。
          // 相手が黙って消えた場合は TCP キープアライブが拾う
          readTimeoutMs: wait < 0 ? 0 : (wait + 10) * 1000
        });
        if (!result.success) {
          const first = result.messages[0];
          const code = (first?.id !== undefined ? FATAL_MESSAGE_IDS[first.id] : undefined) ?? "COMMAND_FAILED";
          throw new As400Error(code, `${first?.id ?? "QMHRCVM"}: ${first?.text ?? "受信に失敗しました"}`);
        }
        return parseReceivedMessage(outputs[0], ccsid);
      };

      /**
       * **いまの末尾までカーソルを進める**（既にあるぶんは流さない）。
       *
       * `QSYSOPR` には数百件溜まっていることがあり、待ち受けを始めた瞬間に
       * 全部が押し寄せると**通知として使い物にならない**。
       */
      const positionAtEnd = async (): Promise<void> => {
        const last = await receive("*LAST", undefined, 0);
        if (last) cursor = last.key;
      };

      if (!positioned) {
        positioned = true;
        if (opts.spec.includeExisting !== true) await positionAtEnd();
      }

      return {
        async next(): Promise<WatchItem | undefined> {
          let msg;
          try {
            // カーソルがあれば次を、無ければ先頭を待つ。
            // **どちらも届くまで返らない**（時間切れまでは無通信）
            msg = await receive(cursor !== undefined ? "*NEXT" : "*FIRST", cursor, WAIT_SECONDS);
          } catch (e) {
            // **カーソルが指す先が消された。** 末尾へ逃がす以外に手が無い——
            // 黙って飛ばすと欠測に気づけないので、必ず記録に残す
            if (cursor !== undefined && e instanceof As400Error && String(e.message).includes(KEY_GONE)) {
              log.warn({ queue: `${library}/${name}`, cursor }, "message cursor lost; repositioning to end");
              cursor = undefined;
              await positionAtEnd();
              return undefined;
            }
            throw e;
          }
          // **時間切れ。** 何も来なかっただけなので、そのまま掛け直してもらう
          if (!msg) return undefined;
          // **捨てるものでもカーソルは進める**（進めないと同じものを永久に読み続ける）
          cursor = msg.key;
          if (opts.spec.onlyInquiry === true && !msg.inquiry) return undefined;
          return {
            text: msg.text,
            // 文字数（メッセージは本文が文字列なので、バイト数は意味を持たない。
            // 画面はメッセージのときは重大度を出す）
            bytes: msg.text.length,
            message: {
              key: msg.key,
              id: msg.id,
              type: msg.type,
              severity: msg.severity,
              inquiry: msg.inquiry,
              ...(msg.help !== "" ? { help: msg.help } : {}),
              ...(msg.truncated ? { truncated: true } : {})
            }
          };
        },
        close: () => conn.close()
      };
    }
  };
}
