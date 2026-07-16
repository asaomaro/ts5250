/**
 * ホストコードページ（CCSID）の選択肢。
 *
 * ACS（IBM i Access Client Solutions）のセッション設定と同様に、CCSID を数値で
 * 直接入力させるのではなく、意味の分かるラベル付きの一覧から選ばせる。
 * ここに載せる CCSID はすべて core の codecForCcsid が解決できるものに限る
 * （SBCS: 37 / DBCS: 930・939・1399 とそのエイリアス 5026・5035）。
 *
 * カタカナ系（930・5026）は SBCS がカタカナ配列で、実機（ACS）では半角英小文字を入力すると
 * 大文字化される。エミュレータも同挙動にするため、これらを katakana フラグで区別する。
 */
export interface HostCodePage {
  ccsid: number;
  /** ドロップダウンに表示する日本語ラベル */
  label: string;
  /** カタカナ系（SBCS がカタカナ配列。英小文字入力は大文字化）コードページか */
  katakana?: boolean;
}

/** 既定のホストコードページ（core の ConnectOptions 既定と揃える）。 */
export const DEFAULT_CCSID = 37;

export const HOST_CODE_PAGES: readonly HostCodePage[] = [
  { ccsid: 37, label: "037 — 英語（アメリカ／カナダ）" },
  { ccsid: 273, label: "273 — ドイツ語／オーストリア" },
  { ccsid: 930, label: "930 — 日本語（カタカナ拡張）", katakana: true },
  { ccsid: 939, label: "939 — 日本語（英小文字拡張）" },
  { ccsid: 1399, label: "1399 — 日本語（拡張漢字・Latin）" },
  { ccsid: 5026, label: "5026 — 日本語（カタカナ）", katakana: true },
  { ccsid: 5035, label: "5035 — 日本語（英小文字）" }
];

/** CCSID からコードページ定義を引く（未知なら undefined）。 */
export function hostCodePageOf(ccsid: number | undefined): HostCodePage | undefined {
  return HOST_CODE_PAGES.find((p) => p.ccsid === ccsid);
}

/** カタカナ系（英小文字入力を大文字化する）コードページか。 */
export function isKatakanaCcsid(ccsid: number | undefined): boolean {
  return hostCodePageOf(ccsid)?.katakana === true;
}
