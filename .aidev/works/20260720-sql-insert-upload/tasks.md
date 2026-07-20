# タスク: 取り込みを SQL INSERT（パラメータマーカー）経路へ

各タスクは「1 タスク = 1 つの検証可能な変更」。単体テストは各タスクに含める。

## core — 骨格

- [x] T1: `db-datastream.ts` に符号を追加（`changeDescriptor` = `0x1E00`、
      拡張マーカー形式 `0x381E`、拡張マーカーデータ `0x381F`、応答のマーカー形式 `0x3813`）。
      `db-connection.ts` の `parameterMarkerHandle`（スパイクで追加済み）を整理し、
      **RPB ハンドルとの取り違えを防ぐコメント**を残す
- [x] T2: `db/marker-format.ts` を新規作成（依存: T1）。`0x3813` を解析して
      `MarkerFormat`（型・長さ・位取り・CCSID・**オフセットの累積**）を返す。
      単体テスト: **スパイクで実際に受け取った 138 バイトを固定データとして使う**（回帰資産）
- [x] T3: `db/marker-encode.ts` を新規作成（依存: T2）。spec D2 の表どおりに値を詰める。
      単体テスト（**ここを厚く**）: 整数の BE・境界値 / `CHAR` の空白詰めと CCSID 別 /
      `VARCHAR` の 2 バイト長 / `DECIMAL`・`NUMERIC`（既存関数の再利用）/
      **未対応型は拒否**（列名・型番号つき）/ NULL 指標 `0xFFFF` / ヘッダー各欄 / 複数行の並び
- [x] T4: `db/insert.ts` を新規作成（依存: T3）。`insertRows` が
      **prepareAndDescribe → changeDescriptor → execute を 1 関数で完結**させる（spec D1）。
      診断ビット（`messageId | firstLevelText`）を常時立てる（spec D5）。
      単体テスト: バッチ分割の件数計算・境界・`uncertainRange` の算出

## core — 実機で確かめる

- [x] **T5: 実機ゲート** — `DATE` / `TIME` / `TIMESTAMP` / `GRAPHIC` を含む表へ 1 行 INSERT し、
      SQL で読み返して一致を確認（依存: T4）。**spec の「残る不確実性」の本体**。
      ⚠ **ここを通るまで T8 以降に進まない**。詰め方が違えば spec へ差し戻す
- [x] T6: 1 バッチの上限を実測し定数化（依存: T5）。行数を増やして限界を測り、
      **根拠をコメントに残す**（保守的な既定から始める）

## core — 事前検査の縮小

- [x] T7: `upload-prepare.ts` を縮小して `ddm/` から `db/` 側へ移す（依存: T2）。
      **型・CCSID・バイト長の検査を外す**（サーバーが形式で教えるため不要）。
      残すのは列突き合わせ・NULL 不可列の検査・行番号つきの拒否。
      **「1 行も書かずに中止する」保証は維持**（全行を詰め終えてから送る）

## server

- [ ] T8: `host-upload.ts` の実行経路を `insertRows` に差し替える（依存: T5, T6, T7）。
      **API の形（`committedRows` / `uncertainRange` / 拒否理由）は変えない**。
      接続は `DbPool` から借り、**借りている間は他の SQL を流さない**（spec D6）
- [ ] T9: **`/api/host/sql` が読み取り専用のままであること**をテストで固定（依存: T8）。
      requirement の完了条件。`query` に更新系が通らないことを回帰として残す
- [ ] T10: MCP ツール `host_upload_table` が新経路で動くことを確認（依存: T8）。
      **入口は変えない**（`uploadRows` の中身が変わるだけ）

## tools

- [ ] T11: `hostserver-check/src/upload.ts` を新経路向けに更新（依存: T8）。
      DDM 版の検証項目（日本語・型・性能）をそのまま新経路で回せるようにする

## 仕上げ

- [ ] T12: **実機通し確認**（依存: T11）。
      (a) CSV から投入 → SQL で読み返して一致
      (b) **日本語**（CCSID 5035）が往復する
      (c) `VARCHAR`（引用符入り）・日付時刻・`GRAPHIC` が入る
      (d) 未対応型・NULL 不可列への NULL が **1 行も書かずに**拒否される
      (e) 100 行の性能を測り、**DDM 経路の 11.6 秒と比較して記録**
- [ ] T13: **実ブラウザ確認**（依存: T12）。データ転送ペインで CSV を取り込み、
      日本語が入ることを目視。拒否・部分完了の表示、ファイル D&D、取得側の CSV 保存。
      ⚠ **前作業の最大の反省。飛ばさない**
- [ ] T14: `npm run build`（`vue-tsc` 込み）・全パッケージのテスト・lint を通す（依存: T13）。
      web-ui のテストは**パッケージ dir から実行**する（AGENTS.md）
