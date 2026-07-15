# レビュー記録（04-dbcs-tls-wide）

## ラウンド 1（2026-07-15）

subtask 04 の単独レビュー。原典（ICU .ucm・SC30-3533・GNU tn5250）と照合。

- [nit] `query-reply.ts` の英数字混在モデル（例 IBM-5555-**C01**）は Query Reply の 2 桁モデル欄に末尾 2 桁
  （"01"）のみ格納し「C」が落ちる / 対応: 許容
  - 権威ある端末タイプは TELNET TERMINAL-TYPE ネゴシエーション（正しく "IBM-5555-C01" を送る）で伝わり、
    Query Reply の device type/model は補助情報。PUB400 実機で受理・メニュー到達を確認済みのため実害なし。
    tn5250 も model を %02d（数値）で扱う。将来必要なら Query Reply の model 欄を拡張する。

- [nit] DBCS フィールドの**セル単位表示**は 1 セル/文字で簡略化（実バイトは 2 桁）。送信は fieldValue→codec.encode で
  SO/SI 込み正しくエンコードされるため**送信の正しさは担保**。編集中のセル表示の忠実化（入力中 SO/SI 桁維持）は
  subtask 05 の scope（decisions D4）/ 対応: 許容（05 へ委譲）。

- [note] 検証項目:
  - DBCS codec: SO/SI ステートマシン・SBCS/DBCS 混在の SO/SI 最小挿入・往復（日本語）を確認。
  - WtdApplier: SO→so セル・DBCS 2 バイト→lead/tail・SI→si セル、cells 全桁保持を確認（原典 tn5250 の
    DBCS 処理挙動に整合）。
  - TLS: 証明書検証既定 ON・自己署名で TLS_CERT_INVALID・ca/rejectUnauthorized の分岐を自己署名サーバで確認。
  - field-validate: 数値型・pure/open DBCS 種別・コードページ許容文字（930 英小文字不可）を確認。
    numeric は SHIFT_NUMERIC_SHIFT（英数許容）を制限対象から除外しており妥当。
  - 27x132: CLEAR UNIT=24x80 / CLEAR UNIT ALTERNATE=27x132（許可時）の切替を確認。

判定: must/should なし（nit 2 件は許容・05 委譲）。review 通過。
