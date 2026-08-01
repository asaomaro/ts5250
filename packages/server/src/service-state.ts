/**
 * **待ち受けの状態**。プリンターと待ち行列監視が共有する（`20260801-service-lifecycle-model` design D5）。
 *
 * 別々の文字列を持たせると、同じことを表す語が 2 つになり UI が二重になる。
 * ここ 1 か所で定義する。
 *
 * ```
 * [定義がある] --> stopped
 * stopped      --> listening      開始（手動 or 自動で待ち受け開始 ✅）
 * listening    --> stopped        停止（接続を手放す）
 * listening    --> reconnecting   切れた（障害）
 * reconnecting --> listening      張り直せた
 * reconnecting --> error          待っても直らない
 * error        --> listening      開始（利用者が直してから）
 * ```
 *
 * ## `stopped` と `reconnecting` を混ぜない
 *
 * **前者は利用者の意思、後者は障害。** 状態を 1 つにまとめると
 * 「止めたのか壊れたのか」が画面で区別できなくなる。
 *
 * ## `stopped` は実体を持たない
 *
 * 装置・ホスト接続を手放す。仕事は失われない——**スプールはホストの OUTQ に、
 * 待ち行列のエントリはキューに残る**（読むまで消えない）。
 * つまり停止は「いま消費しない」であって「取りこぼす」ではない。
 *
 * その帰結として:
 * - 他の人が同じ装置を使える（掴んだまま受け取らないと実害が出る）
 * - **上限を「待ち受け中の数」で数えられる**——停止中は資源ゼロなので枠を占めない
 */
export type ServiceState = "stopped" | "listening" | "reconnecting" | "error";

/** その状態はホストへの接続を持っているか */
export function holdsConnection(state: ServiceState): boolean {
  return state === "listening" || state === "reconnecting";
}

/**
 * 定義の「自動で待ち受け開始」を解く。**未設定は `true`**。
 *
 * 既定を `true` にするのは、いまある定義の挙動を変えないため——
 * `false` を既定にすると、アップグレードで「開いても何も起きない」に変わる。
 */
export function autoStartOf(v: boolean | undefined): boolean {
  return v !== false;
}
