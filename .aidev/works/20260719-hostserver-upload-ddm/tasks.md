# タスク

- [x] **T1** `encode.ts`（ゾーン/パック 10 進・EBCDIC 文字・整数のエンコード。純関数）＋単体テスト
- [x] **T2** `record-layout.ts`（SQL メタデータ → オフセット計算。対応外の型は失敗）＋単体テスト
- [x] **T3** `ddm-datastream.ts`（6 バイトヘッダー・LL/CP の組み立てと解析）＋単体テスト
- [x] **T4** `ddm-connection.ts` の握手（EXCSAT → ACCSEC → SECCHK）。
      パスワード置換値は既存 `password.ts` を再利用
- [x] **T5** `open`（S38OPEN → S38OPNFB の解析）
- [x] **T6** `write`（S38PUTM + S38BUF）と `close`
- [x] **T7** index.ts から export
- [x] **T8** `tools/hostserver-check` にサブコマンド追加
- [x] **T9** **実機検証**: テスト用 PF を作る → 書く → **SQL で読み返す** → 後片付け
- [x] **T10** backlog 更新 / decisions.md
