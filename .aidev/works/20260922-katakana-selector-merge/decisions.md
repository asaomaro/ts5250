# 決定記録

`20260922-katakana-variant-setting`（930/939/1399 のホストコードページ設定・930 のキーボード配列選択）
に対する、利用者指摘を受けた修正。この work は `.aidev` の requirements→design→…の全工程は踏まず
（PR #411・#413 と同じ、直接修正の扱い）、コード中の `20260922-katakana-selector-merge` 参照の
解決先としてこの decisions.md だけを置く（`.aidev/conventions/comment-provenance.md`）。

経緯は `.aidev/backlog/acs-parity.md`「930 の申告の選択」の取り消し線に要約がある。

## D1: `katakanaVariant`（930 の Katakana/Katakana Extended 設定）から 5026 を除く

- 背景: `20260922-katakana-variant-setting`（PR #412）は 930 と 5026 を対で扱い、
  `deviceEnvFor`・`isKatakanaCcsid`（`EmulatorPane.vue` の gate）の両方で 5026 にも
  katakanaVariant の CHARSET 切り替え・入力制限を適用していた。この対応関係は実機・ACS の
  どちらでも裏づけを取っていない「同じだろう」という拡張だった。
- 新しい事実: ACS の接続設定画面が実際に構築する一覧（`com.ibm.eNetwork.HOD.common.CodePage#codePagesMap32705250`。
  `IBMiAccess_v1r1/acsbundle.jar` の `plugins/emulator/acshod2.jar` を CFR でデコンパイルして確認）は
  日本語について 930（`KEY_JAPAN_KATAKANA`/`KEY_JAPAN_KATAKANA_EX`）・939（`KEY_JAPAN_ENGLISH_EX`）・
  1399（`KEY_JAPAN_LATIN_EXTENDED`/`_JIS2004`）の 3 CCSID しか選ばせない。`CodePage` クラス全体の
  文字列定数（javap の定数プール）を総当たりしても "5026" は一度も現れない。ACS の内部の
  文字コード変換テーブル（`SBGIDTable`/`DBGIDTable`/`DBCSSectTable`）・日本語 CCSID の集合
  （`JAPANCodePages`/`DBCSCodePages`）にも 5026 は無い。ACS はこの CCSID の存在自体を知らない。
- 決定: `packages/base/src/device-env.ts` の `deviceEnvFor` から `ccsid === 5026` の分岐を外し、
  930 のときだけ katakanaVariant を見るようにした。`packages/web-ui/src/components/EmulatorPane.vue`
  の `uppercaseInput`/`katakanaRestricted` も `isKatakanaCcsid(ccsid)`（930・5026 両方 true）ではなく
  `ccsid === 930` を直接見るように変えた（gate の意味が「SBCS がカナ配列か」ではなく
  「ACS の 930 の 2 択のどちらを選んでいるか」だったため、正しい判定軸に付け替えた）。
- 影響が及ばない範囲: `isKatakanaCcsid`（`@ts5250/ebcdic/katakana`）自体は変更していない。930/5026 の
  SBCS が英小文字を持たずカナ配列である、という事実（`screenExport.ts`・`ReportText.vue`・
  `PrinterPane.vue` の表示切替・`codecForCcsid` のバイト変換）はどちらも真のままで正しい。
  変えたのは「katakanaVariant という**別の**選択が及ぶ範囲」だけ。
- スプール CCSID（`SPOOL_CODE_PAGES`）にも影響しない。あちらは ACS の接続設定画面と無関係な
  当 PJ 独自の欄で、5026・5035 を残す理由は別（PR #413 の PR 本文・`hostserver.md` 参照）。

## D2: 930 未指定（katakanaVariant undefined）の挙動を Katakana Extended 側に寄せる

- 背景: `20260922-katakana-variant-setting` は「未指定は既存利用者の挙動を変えない」という方針で、
  CHARSET 1172（Extended 相当）・大文字強制（Katakana 相当）・8 記号許可（Extended 相当）という、
  ACS のどちらの選択とも一致しない折衷を既定にしていた。
- 新しい事実: 利用者からの指摘で、当 PJ の CCSID 選択肢（`HOST_CODE_PAGE_OPTIONS`）を ACS の
  接続設定画面と同じ 1 本の一覧に統合すると（D3 参照）、930 を選んだ時点で必ず Katakana か
  Katakana Extended のどちらかになる——ACS の一覧に「未選択」という中間状態は無い。
- 決定: 未指定（`katakanaVariant === undefined`）は Katakana Extended 側として扱う
  （`hostCodePageOptionId(930, undefined)` は `"930-katakana-ex"` を返す。`EmulatorPane.vue` の
  `katakanaRestricted` は `ccsid === 930 && katakanaVariant === "katakana"` の 1 条件に統一し、
  それ以外〔未指定・`"katakana-ex"`〕はすべて Extended 相当）。
- 影響: 930 で katakanaVariant を一度も明示していない既存の system/session 設定は、
  この変更で**大文字強制が外れる**（CHARSET 1172・8 記号許可は変わらない）。
  `20260922-katakana-variant-setting` の AC4（未指定は挙動を変えない）はこの work で明示的に破棄する
  （AGENTS.md 判断の原則 3。根拠は上の「ACS の一覧に中間状態は無い」という事実）。

## D3: 930 を独立設定（`katakanaVariant`）ではなく、ホストコードページ一覧の 2 エントリとして出す

- 背景: `20260922-katakana-variant-setting` は 930 の Katakana/Katakana Extended を、CCSID の選択とは
  別の独立した「カタカナのキー配列」欄として実装していた。利用者から「ACS に従い、ホストコードの
  選択肢として吸収し項目を分けないでください」という指摘を受けた。
- 新しい事実: 上記 `CodePage.codePagesMap32705250` の実装は、930 を 1 エントリではなく
  `KEY_JAPAN_KATAKANA`・`KEY_JAPAN_KATAKANA_EX` という**ラベル違いの 2 エントリ**として
  `Properties` に積む（どちらも値は文字列 "930"）。ACS の「ホスト・コード・ページ」ドロップダウンは
  この `Properties` から直接選択肢を作る（`CodepageSelectDialog` を参照して確認した構造と同じ）ので、
  利用者から見ると 930 は最初から一覧の中の 2 項目であり、「CCSID を選んでから、さらにキー配列を選ぶ」
  という 2 段階の設定ではない。利用者提示のスクリーンショット（930 の一覧に「日本語（カタカナ）」
  「日本（拡張カタカナ）」が並ぶ）もこれと一致する。
- 決定: `packages/web-ui/src/hostCodePages.ts` に `HOST_CODE_PAGE_OPTIONS`（`id`/`ccsid`/`katakanaVariant`/
  `label` を持つ選択肢の配列。930 だけ `id` が 2 つ）を新設し、`ConfigCard.vue` の CCSID `<select>` を
  これ 1 本に統合した。旧来の「カタカナのキー配列」という独立した `<label>`（`isKatakanaCcsid(ccsid)` で
  条件表示していたもの）は削除した。保存する形式（system/session 設定の `ccsid` + `katakanaVariant` の
  2 フィールド）自体は変えていない——変えたのは web-ui の**見せ方**だけで、サーバーのスキーマ・
  wire 上の `katakanaVariant`（`ws-messages.ts`）は従来どおり。
- 代替案（採らなかったもの）: 930 の 2 エントリを別々の `ccsid` 値（例: 930 と 2900）として表す案は、
  「ACS も 290 という別の CCSID を名乗るのではなく、930 のまま CHARSET だけを変える」という
  `20260922-katakana-variant-setting` requirements の対象外方針と矛盾するため採らなかった
  （ACS 自身が CCSID としては常に "930" を申告する。2 エントリの違いは CHARSET・入力規則だけ）。

## D4（未実装の判断）: 1399 の Latin Unicode 拡張／JIS2004 は当 PJ では区別しない

- 背景: 利用者から「1399 にも選択肢が 2 つあるようです」という指摘（スクリーンショット）。
  ACS の一覧には「1399 日本語（Latin Unicode 拡張）」と「1399 日本語（Latin Unicode 拡張, JIS2004）」
  が並ぶ。
- 実機（ACS のコアを JVM 上で直接実行）で確認した事実: `acshod2.jar` の
  `com.ibm.eNetwork.HOD.converters.ja.{ByteToCharCp1399,ByteToCharCp1399JIS2004,CharToByteCp1399,CharToByteCp1399JIS2004}`
  を reflection で読み込み、有効な DBCS コード全域（decode）・1399 の全実在文字（encode、
  decode 表から抽出した 31,161 字）を突き合わせた。**decode・encode のどちらも、JIS2004 版と
  非 JIS2004 版で 1 バイトも差が無い**（`/tmp/jis2004-probe/` の実行ログ。このセッション限りの
  scratchpad なのでコミットには残していない。再現手順は下記）。
  唯一の差はフォントファイル（`fonts/jpn1399.fnt` と `fonts/jpnjis2004.fnt`）——JIS2004 は
  一部の漢字の**字体（グリフ）**だけを変える ACS 側の表示設定で、コードポイントや送信バイトは
  変わらない。
- 決定: 当 PJ には対応する実体が無い（ブラウザの日本語フォントに描画を委ねており、
  IBM のフォントを同梱していない）ため、1399 の JIS2004 エントリは追加しない。930 のような
  2 エントリ化（D3）は 1399 には適用しない。
- 再現手順（次に確かめる人のため）: `IBMiAccess_v1r1/acsbundle.jar` から
  `plugins/emulator/acshod2.jar` を取り出し、`com/ibm/eNetwork/HOD/converters/ja/ByteToCharCp1399*.class`・
  `CharToByteCp1399*.class`・`com/ibm/eNetwork/HOD/converters/{ByteToCharDBCS_EBCDIC,CharToByteDBCS_EBCDIC}.class`・
  `com/ibm/eNetwork/HOD/common/{HODByteToCharConverter,HODCharToByteConverter}.class` を展開し、
  `java -cp .:acshod2.jar <reflection harness>` で `convert(byte[],int,int,char[],int,int)` /
  `convert(char[],int,int,byte[],int,int)` を全域呼び出して突き合わせる。GUI 依存クラスは無いので
  ヘッドレスで動く。
