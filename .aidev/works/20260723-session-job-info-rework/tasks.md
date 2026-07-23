# タスク: セッションのジョブ情報を起動応答＋ジョブ一覧で取る

## core（新しい経路を先に通す）

- [x] T1: `packages/core/src/telnet/startup-record.ts` を新規作成。`parseStartupResponse(record, codec)` が
      応答コード / システム名 / 装置名を返す（起動応答でなければ `undefined`）。
      **実機で捕えた 73 バイト**をテストの固定値にする
- [x] T2: `printer-session.ts` の `readResponseCode` を T1 に寄せる（読み方の重複を無くす。既存テストが通ること）
- [x] T3: `Session5250` が**1 レコード目だけ**起動応答を判定して保持し、**画面へ流さない**（依存: T1）。
      起動応答でない 1 レコード目・2 レコード目以降は従来どおり画面へ流すことをテストで固定する

## server

- [x] T4: `session-manager.ts` に接続後のジョブ解決を足す（依存: T3）。
      資格情報があるときだけ・`listJobs({ name, user, type: "I" })` が **1 件のときだけ採用**・
      **`await` しない**・失敗は握りつぶす・接続は使い終わったら閉じる
- [x] T5: セッション状態の通知に `job` を載せる（依存: T4）
- [x] T7: MCP `get_job_info` を**副作用なし**に変更（既知の情報を返すだけ・`refresh` 廃止）（依存: T4）

## web-ui

- [x] T6: `SessionInfo.vue` から「🔄 取得」ボタンと `fetchJob()` を撤去し、届いた `job` を表示（依存: T5）。
      番号まで分かるとき／装置名だけのとき／無いときの 3 通り。「デバイス名」行は**実際の装置名**を優先

## 撤去（新経路が通ってから）

- [x] T8: core の `fetchJobInfo` / `parseJobInfo` / `jobInfoCache` / `fetchingJobInfo` / `assertNotBusy` と、
      `JOB_INFO_BUSY` / `JOB_INFO_UNAVAILABLE` を削除。関連テストも整理（依存: T6, T7）
- [x] T9: ws の `requestJobInfo` 要求と応答メッセージ型を削除（依存: T8）
- [x] T10: README の MCP ツールの説明を実態に合わせる（依存: T7）

## 検証

- [ ] T11: 実機（PUB400）で、接続直後に**何も押さずに**ジョブが出ること・画面が変化しないこと。
      資格情報が無い設定でも壊れないこと（依存: T6）
