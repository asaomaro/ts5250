/**
 * ホストサーバーのフレームトレース（障害切り分け用）。
 *
 * signon にだけあった private 実装をここへ移し、**同じ 20 バイトヘッダー形式を使う
 * 5 箇所すべて**（signon / server-connect / database / command / netprint / IFS）で共有する。
 * database に無いことは backlog に「実利のある不足」として記録されていたが、
 * 実測すると **4 接続すべてに無かった**。
 *
 * ## ⚠ debug では応答本文（業務データ）が出る
 *
 * このトレースはフレームのバイト列をそのまま出すので、**SQL の応答には
 * 取得した行データが含まれる**。マスクしているのは資格情報だけで、本文は伏せない
 * （伏せたら切り分けに使えない）。
 *
 * したがって:
 *   - 既定（`LOG_LEVEL=info`）では**何も出ない**し、整形コストも発生しない
 *   - 値は既定 64 バイトで切る（切ったことは `…(+N bytes)` と明示する）
 *   - **本番で `LOG_LEVEL=debug` にするときは、ログの取り扱いに注意すること**
 */
import { CP, HEADER_LEN, PARAM_PREFIX_LEN } from "./datastream.js";
import type { CoreLogger } from "../log.js";

/** 値をこのバイト数で切る。フレームの構造（LL/CP の並び）は保たれるので切り分けには足りる */
const DEFAULT_MAX_VALUE_BYTES = 64;

/**
 * 伏せるコードポイント。
 *
 * - `CP.password`（0x1105）: パスワード置換値。**送信側**。伏せる理由は明白
 * - `0x111A`: **signon の応答**に載る 20 バイト（SHA-1 と同じ長さ）。
 *   **正体を特定できていない**——原典（jtopenlite の SignonConnection）もこの CP を
 *   解析せず読み飛ばしており、意味を確かめる手段が無かった。
 *   認証応答に含まれるハッシュ長の値は、**分からないなら伏せる側に倒す**
 *   （伏せて失うのは診断項目 1 つ、伏せずに間違えるとトークンをログに残す。損得が非対称）。
 *   正体が分かったら見直すこと（backlog に記録済み）
 */
const MASKED_CP: ReadonlySet<number> = new Set([CP.password, 0x111a]);

/** バイト列を16進文字列にする（Node の Buffer に依存しない） */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * 20 バイトヘッダー＋LL/CP 形式のフレームを 1 行に整形する。
 *
 * **資格情報に関わる CP は必ず伏せる**（`MASKED_CP`）。置換値は seed 込みのハッシュで
 * 平文ではないが、生の資格情報由来の値をログに残さない。
 *
 * トレースは副次機能なので、**壊れたフレームでも例外を投げない**
 * （解析エラーは parseReply が PROTOCOL_ERROR として報告する責務）。
 */
export function formatFrame(
  direction: "send" | "recv",
  frame: Uint8Array,
  opts: { maxValueBytes?: number } = {}
): string {
  const max = opts.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  if (frame.length < HEADER_LEN) {
    return `${direction} len=${frame.length} (too short to parse)`;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const parts: string[] = [];
  let pos = HEADER_LEN + view.getUint16(16);
  while (pos + PARAM_PREFIX_LEN <= frame.length) {
    const ll = view.getUint32(pos);
    if (ll < PARAM_PREFIX_LEN || pos + ll > frame.length) break;
    const cp = view.getUint16(pos + 4);
    const value = frame.subarray(pos + PARAM_PREFIX_LEN, pos + ll);
    parts.push(`0x${cp.toString(16).padStart(4, "0")}=${formatValue(cp, value, max)}`);
    pos += ll;
  }
  return (
    `${direction} len=${frame.length} ` +
    `reqrep=0x${view.getUint16(18).toString(16)} ${parts.join(" ")}`
  );
}

function formatValue(cp: number, value: Uint8Array, max: number): string {
  if (MASKED_CP.has(cp)) return `<masked ${value.length} bytes>`;
  if (value.length <= max) return toHex(value);
  // **黙って切らない**——切った量を書く
  return `${toHex(value.subarray(0, max))}…(+${value.length - max} bytes)`;
}

/**
 * フレームを debug に出す。**出力先が無ければ整形もしない**
 * （`isDebugEnabled()` は既定の no-op ロガーで false を返す）。
 */
export function traceFrame(log: CoreLogger, direction: "send" | "recv", frame: Uint8Array): void {
  if (!log.isDebugEnabled()) return;
  log.debug(formatFrame(direction, frame));
}

/**
 * 接続をトレース付きで包む。
 *
 * **呼び出しごとに `traceFrame` を書かない**——`request()` の呼び出しは 5 接続で
 * 12 箇所あり、1 箇所書き忘れると「そこだけ追えない」という気づきにくい穴になる。
 * 接続を作るときに 1 度包めば、以降の全往復が自動で乗る。
 */
export function traced<T extends { request(frame: Uint8Array): Promise<Uint8Array> }>(
  conn: T,
  log: CoreLogger
): T {
  return {
    ...conn,
    async request(frame: Uint8Array): Promise<Uint8Array> {
      traceFrame(log, "send", frame);
      const reply = await conn.request(frame);
      traceFrame(log, "recv", reply);
      return reply;
    }
  };
}
