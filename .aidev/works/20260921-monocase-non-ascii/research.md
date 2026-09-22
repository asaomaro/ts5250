# 調査: ACS の打鍵の受け付けと MONOCASE

## 判明した事実
- F1（原典）: `PS5250.inputChar` は、DBCS のセッション（か Unicode のデータストリーム）でなければ DBCS の判定（`CodePage.IsDBCSChar`）も
  文字の可否（`codepage.isValidChar`→エラー 39）も行わず、`checkSBCSField`（数値欄などの型）の後に `putSBChar` で置く。
- F2（原典）: MONOCASE の欄は `Character.toUpperCase(c)`。`c != 'µ'` と「DBCS の文字でない」ときだけ（`µ` を `Μ` にしない）。Java の char 単位なので
  `ß` は `ß` のまま。Greek の `μ` はコードページに `µ` があれば先に `µ` へ置き換える（`hasMicroSymbol`）——当 PJ は扱っていない（台帳）。
- F3（実機・ACS のコア・PUB400・37。`scripts/acs-probe/monocase-non-ascii.txt`）: コマンド行（MONOCASE でない）に `aéñøüµß` → そのまま、
  サインオン画面の利用者名（MONOCASE）に `aéñøüµß` → `AÉÑØÜµß`。利用者名の欄は 2 経路で同じ結果（接続直後の画面と、SIGNOFF の後の画面）。
  手順の `signon`（欄へ直接書く）は PUB400 で 3 回とも失敗したので、ACS の自動サインオン（`PROBE_BYPASS_SIGNON=encrypted`）で繋いだ。
- F4（当 PJ）: `fieldValidate.ts` の `rejectReason` は `isFullWidth`（Ambiguous を含む）で SBCS の欄の全角を弾き、`dbcsByteLength` も同じ判定で
  SO/SI と 2 バイトを数える。`é` `ü` `ß` `ø` は Ambiguous（`packages/base/src/east-asian-width.ts` の `FULLWIDTH_RANGES`）。`ñ` `µ` は含まれない。
- F5（当 PJ）: core の送信時検証（`packages/tn5250/src/screen/field-validate.ts` の `validateFieldContent`）はコードページに無い文字を拒否する。
  SBCS の codec は置き換え（0x3F）で数えるので、送れない字は送信時に分かる。
