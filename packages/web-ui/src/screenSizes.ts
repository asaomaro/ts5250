/**
 * 画面サイズの選択肢。
 *
 * ACS のセッション設定と同様、接続ごとに 24x80 / 27x132 を選ばせる。これは接続時の
 * telnet 端末タイプ交渉に落ちる申告で（core の terminalTypeFor: 27x132 なら SBCS=IBM-3477-FC /
 * DBCS=IBM-5555-B01）、「この端末はどちらを扱えるか」をホストに伝えるだけ。
 *
 * どちらで描くかを決めるのは常にホスト側で、画面ごとに違う。表示ファイルの DSPSIZ に
 * 27x132（*DS4）版があり、かつ端末が 27x132 対応のときだけホストは CLEAR UNIT ALTERNATE で
 * 27x132 を送る。*DS4 版を持たない画面（サインオン・MAIN メニュー等）は 27x132 を選んでも
 * 24x80 のまま来る——これは異常ではない。
 *
 * 端末タイプは接続時にしか申告できないため、セッション中の動的な切替はできない。
 */
export type ScreenSize = "24x80" | "27x132";

export interface ScreenSizeOption {
  value: ScreenSize;
  /** ドロップダウンに表示する日本語ラベル */
  label: string;
}

/** 既定の画面サイズ（core の ConnectOptions 既定と揃える）。 */
export const DEFAULT_SCREEN_SIZE: ScreenSize = "24x80";

export const SCREEN_SIZES: readonly ScreenSizeOption[] = [
  { value: "24x80", label: "24x80 — 標準" },
  { value: "27x132", label: "27x132 — ワイド（対応画面のみ）" }
];
