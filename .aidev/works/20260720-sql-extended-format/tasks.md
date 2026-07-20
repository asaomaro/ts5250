# タスク

- [x] **T1** `db-reply-ext.ts`: 超拡張列定義（0x3812）の解析＋単体テスト
- [x] **T2** 拡張結果データ（0x380E）の解析＋単体テスト
- [x] **T3** `DbValue` に `LobPlaceholder` を追加（`null` と区別する）
- [x] **T4** `db-connection.ts` で `0x3821=0xF2` / `0x3822=0`（＝常にロケーター）を送る
- [x] **T5** `query.ts` を両形式対応に（0x3812/0x380E 優先、無ければ従来）
- [x] **T6** **実機で全型の回帰確認**（文字・数値・日付時刻・DBCS）
- [x] **T7** 実機で `SELECT * FROM QSYS2.SYSTABLES` 100 行＋応答サイズ測定
- [x] **T8** Web UI の表・CSV で `(LOB)` 表示（NULL/空文字と区別）
- [x] **T9** DDM の列レイアウト取得の回帰（実機往復）
- [x] **T10** #99 のメッセージ訂正 ／ backlog の誤記述の訂正
- [x] **T11** `tsc -b` / lint / 全テスト / web-ui ビルド
