/**
 * ホストコードページ（CCSID）の選択肢。
 *
 * ACS（IBM i Access Client Solutions）のセッション設定と同様に、CCSID を数値で
 * 直接入力させるのではなく、意味の分かるラベル付きの一覧から選ばせる。
 * ここに載せる CCSID は ACS の接続設定画面（`CodePage.codePagesMap32705250` が
 * 5250 表示／印刷セッション向けに構築する一覧）が実際に選ばせるものに限る
 * （SBCS: 37・273 等 / DBCS 日本語: 930・939・1399）。
 *
 * **5026・5035 は載せない**: 以前は 930・939 の「エイリアス」として一覧に含めていたが、
 * ACS のデコンパイル済みコア（`com/ibm/eNetwork/HOD/common/CodePage`）を当たったところ、
 * 接続設定画面の一覧・`JAPANCodePages`/`DBCSCodePages` の定数表・クラス全体の文字列定数の
 * いずれにも "5026"・"5035" は一度も現れない——ACS はこの 2 つの CCSID を選択肢として
 * 知らない（`20260922-katakana-variant-setting` で 930/5026 を対に扱っていたのは、
 * 実機の裏づけがないまま「同じだろう」で広げた判断だった。AGENTS.md 条項 3）。
 *
 * カタカナ系（930）は SBCS がカタカナ配列で、実機（ACS）では半角英小文字を入力すると
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

/**
 * スプール（SCS）デコードの既定 CCSID。**5250 画面用の `DEFAULT_CCSID`（37）とは別**——
 * 経路によって扱いが違うため、既定値も揃えない（サーバー側 openNetPrint の既定と合わせる）。
 */
export const DEFAULT_SPOOL_CCSID = 273;

export const HOST_CODE_PAGES: readonly HostCodePage[] = [
  { ccsid: 37, label: "037 — 英語（アメリカ／カナダ）" },
  { ccsid: 273, label: "273 — ドイツ語／オーストリア" },
  // ~~「カタカナ拡張」~~ → 変種（Katakana / Katakana Extended）は別の設定（キー配列）で選ぶので
  // ここでは付けない（`20260922-katakana-variant-setting`）
  { ccsid: 930, label: "930 — 日本語（カタカナ）", katakana: true },
  { ccsid: 939, label: "939 — 日本語（英小文字拡張）" },
  { ccsid: 1399, label: "1399 — 日本語（拡張漢字・Latin）" }
];

/**
 * スプール（SCS）CCSID の選択肢。**上の `HOST_CODE_PAGES` とは意味が違う**ので分けている。
 *
 * こちらは「ACS の接続設定画面で選ぶ値」ではなく、**ホスト（IBM i）がジョブ／出力キューに
 * 設定している CCSID をこちら側の解読でも合わせて申告し直す**欄——ACS はスプール CCSID を
 * 手動選択させる画面を持たない（当 PJ 独自の機能）。5026・5035 はここでは**残す**:
 * `.aidev/backlog/hostserver.md`（`20260718-hostserver-spool`・PR #247）で、実機（日本語環境の
 * サインオン）が実際に `serverCcsid` として 5035 を申告してくることを確認済み。`codecForCcsid`
 * も 930/939 のバイト配置そのままのエイリアスとして 5026/5035 を解決する
 * （`packages/ebcdic/src/codec.ts`）。
 */
export const SPOOL_CODE_PAGES: readonly HostCodePage[] = [
  ...HOST_CODE_PAGES,
  { ccsid: 5026, label: "5026 — 日本語（カタカナ）", katakana: true },
  { ccsid: 5035, label: "5035 — 日本語（英小文字）" }
];

/** CCSID からコードページ定義を引く（未知なら undefined）。5250 画面用の一覧から引く。 */
export function hostCodePageOf(ccsid: number | undefined): HostCodePage | undefined {
  return HOST_CODE_PAGES.find((p) => p.ccsid === ccsid);
}

/**
 * カタカナ系（英小文字入力を大文字化する）コードページか。
 *
 * **判定は `@ts5250/ebcdic/katakana` に一本化してある**——2 表（CP290 / CP1027）が
 * 住んでいる場所と同じにしないと、表を足したときに片方だけ直して食い違う。
 * 上の一覧の `katakana` はドロップダウンの説明用で、判定には使わない。
 */
export { isKatakanaCcsid } from "@ts5250/ebcdic/katakana";
