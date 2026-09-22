import type { KatakanaVariant } from "@ts5250/base";

/**
 * 5250 画面（system/session 設定の CCSID）の選択肢。
 *
 * ACS（IBM i Access Client Solutions）の接続設定画面の「ホスト・コード・ページ」一覧に倣う。
 * ここに載せる CCSID は、その一覧（`CodePage.codePagesMap32705250` が 5250 表示／印刷セッション
 * 向けに構築する一覧。デコンパイル済みコアで確認）が実際に選ばせるものに限る
 * （SBCS: 37・273 等 / DBCS 日本語: 930・939・1399）。5026・5035 は載せない——ACS の接続設定画面
 * にも、`CodePage` クラス全体の文字列定数にも "5026"・"5035" は一度も現れず、ACS はこの 2 つの
 * CCSID の存在自体を知らない（`20260922-katakana-selector-merge` D1）。
 *
 * **930 は 2 エントリで並ぶ**（`20260922-katakana-selector-merge`）。ACS の一覧自体が
 * `KEY_JAPAN_KATAKANA`（Katakana）と `KEY_JAPAN_KATAKANA_EX`（Katakana Extended）という
 * ラベル違いの 2 エントリを持ち、どちらも申告する CCSID は同じ "930" ——ACS にとって
 * これは「930 を選んだ後にキー配列を選ぶ」という 2 段の設定ではなく、**一覧そのものの選択肢**。
 * 当 PJ も同じ形にする（独立した設定項目には分けない）。`id` はこの 2 エントリを区別するための
 * 当 PJ 独自のキーで、ACS 由来の値ではない。
 *
 * 未選択（`katakanaVariant` 未指定）は **Katakana Extended 側**に倒す（`20260922-katakana-selector-merge`
 * D2）。ACS の一覧に「未選択」という中間状態は無く、930 を選ぶ時点で必ずどちらか一方になるため。
 */
export interface HostCodePageOption {
  /** `<select>` の value に使う、当 PJ 内だけの識別子（930 が 2 エントリあるため ccsid だけでは一意にならない） */
  id: string;
  ccsid: number;
  /** 930 の 2 エントリのときだけ設定する。930 以外は undefined */
  katakanaVariant?: KatakanaVariant;
  /** ドロップダウンに表示する日本語ラベル */
  label: string;
}

/** 既定のホストコードページ（core の ConnectOptions 既定と揃える）。 */
export const DEFAULT_CCSID = 37;

/**
 * スプール（SCS）デコードの既定 CCSID。**5250 画面用の `DEFAULT_CCSID`（37）とは別**——
 * 経路によって扱いが違うため、既定値も揃えない（サーバー側 openNetPrint の既定と合わせる）。
 */
export const DEFAULT_SPOOL_CCSID = 273;

export const HOST_CODE_PAGE_OPTIONS: readonly HostCodePageOption[] = [
  { id: "37", ccsid: 37, label: "037 — 英語（アメリカ／カナダ）" },
  { id: "273", ccsid: 273, label: "273 — ドイツ語／オーストリア" },
  { id: "930-katakana", ccsid: 930, katakanaVariant: "katakana", label: "930 — 日本語（カタカナ）" },
  { id: "930-katakana-ex", ccsid: 930, katakanaVariant: "katakana-ex", label: "930 — 日本（拡張カタカナ）" },
  { id: "939", ccsid: 939, label: "939 — 日本語（英小文字拡張）" },
  { id: "1399", ccsid: 1399, label: "1399 — 日本語（拡張漢字・Latin）" }
];

/**
 * `(ccsid, katakanaVariant)` から、その組を表す選択肢の `id` を引く（保存済みの system/session
 * 設定を `<select>` の選択状態に戻すため）。930 は `katakanaVariant` 未指定・`"katakana-ex"` の
 * どちらも `"930-katakana-ex"` に寄せる（未選択＝Katakana Extended 側。上の doc コメント D2）。
 * 930 以外は `katakanaVariant` を無視する（意味を持たないため）。930 でも 939/1399 でもない
 * CCSID（未知の値・スプール専用の 5026/5035 等）は undefined。
 */
export function hostCodePageOptionId(
  ccsid: number | undefined,
  katakanaVariant: KatakanaVariant | undefined
): string | undefined {
  if (ccsid === 930) {
    return katakanaVariant === "katakana" ? "930-katakana" : "930-katakana-ex";
  }
  return HOST_CODE_PAGE_OPTIONS.find((o) => o.ccsid === ccsid)?.id;
}

/** `id` から選択肢を引く（未知の id は undefined）。 */
export function hostCodePageOptionOf(id: string | undefined): HostCodePageOption | undefined {
  return HOST_CODE_PAGE_OPTIONS.find((o) => o.id === id);
}

/**
 * スプール（SCS）CCSID の選択肢。**上の `HOST_CODE_PAGE_OPTIONS` とは意味が違う**ので分けている。
 *
 * こちらは「ACS の接続設定画面で選ぶ値」ではなく、**ホスト（IBM i）がジョブ／出力キューに
 * 設定している CCSID をこちら側の解読でも合わせて申告し直す**欄——ACS はスプール CCSID を
 * 手動選択させる画面を持たない（当 PJ 独自の機能）ので ACS の一覧に縛られない。5026・5035 は
 * ここでは残す: `.aidev/backlog/hostserver.md`（`20260718-hostserver-spool`・PR #247）で、実機
 * （日本語環境のサインオン）が実際に `serverCcsid` として 5035 を申告してくることを確認済み。
 * `codecForCcsid` も 930/939 のバイト配置そのままのエイリアスとして 5026/5035 を解決する
 * （`packages/ebcdic/src/codec.ts`）。930 の Katakana/Katakana Extended のような 2 択は無い
 * （SCS の解読は CHARSET 申告や入力規則と無関係で、CCSID の SBCS 表だけで決まる）。
 */
export interface SpoolCodePage {
  ccsid: number;
  label: string;
}

export const SPOOL_CODE_PAGES: readonly SpoolCodePage[] = [
  { ccsid: 37, label: "037 — 英語（アメリカ／カナダ）" },
  { ccsid: 273, label: "273 — ドイツ語／オーストリア" },
  { ccsid: 930, label: "930 — 日本語（カタカナ）" },
  { ccsid: 939, label: "939 — 日本語（英小文字拡張）" },
  { ccsid: 1399, label: "1399 — 日本語（拡張漢字・Latin）" },
  { ccsid: 5026, label: "5026 — 日本語（カタカナ）" },
  { ccsid: 5035, label: "5035 — 日本語（英小文字）" }
];

/**
 * カタカナ系（英小文字入力を大文字化する）コードページか。
 *
 * **判定は `@ts5250/ebcdic/katakana` に一本化してある**——2 表（CP290 / CP1027）が
 * 住んでいる場所と同じにしないと、表を足したときに片方だけ直して食い違う。
 * 930・5026 の両方が true になる——これは SBCS の字形がカタカナ配列かどうかの判定であって、
 * `HostCodePageOption` の Katakana/Katakana Extended の 2 択（930 だけが持つ軸）とは別物。
 * 後者の判定は `hostCodePageOptionId` や `EmulatorPane.vue` の `katakanaRestricted` を使う。
 */
export { isKatakanaCcsid } from "@ts5250/ebcdic/katakana";
