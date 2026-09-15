# タスク: `pendingAid` の解決条件を「Read 要求」に一本化する

## 実装方針

`design.md`「振る舞いの詳細」の擬似コードに従い、`handleRecord()` 内の `unlocked`
（ローカル変数）を `readSolicited` に改名し、立つ条件を `result.unlockKeyboard` から
`result.readRequested` へ切り替える。この1つの変数で `this.state`/`onceReady`・
`pendingAid` 解決の両方の判定を制御する構造は変えない（design.md「設計方針」）。
実装自体は1箇所（`session.ts` の `handleRecord()`）に閉じるため、タスクは
「実装（T1）」「回帰テスト追加（T2）」「実機再検証（T3）」「既存テスト全件での
回帰確認（T4）」の4つに分ける。

## 作業順序と依存関係

下の `依存:` に従う。T1（実装）を先に終わらせる必要があるが、T2（単体テスト）と
T3（実機再検証）はどちらも T1 にのみ依存し、T2 と T3 の間に順序関係は無い
（並行して進めてよい）。T4（既存テスト全件）は T1・T2 の両方が終わってから
（T2 で追加した新規テストを含めて全件を回すため）。

## リスク / 留意点

- `design.md`「エラー処理 / 異常系」の通り、`readSolicited` が一度も来ない経路は
  `handleClose()`/`sendAndWait()` のタイムアウトが既存のまま面倒を見る——**この経路自体は
  変更しない**（触ると別の回帰を生みやすい）。
- 単体テストは実機不要で完結させる（`design.md`「テスト方針」）。実機診断は test 工程で
  別途実行する。

## テスト方針

- `packages/tn5250/test/` に新規テストファイル（T2）を追加し、`DeferredTransport` で
  レコードの到着タイミングを制御し、「1レコード目（unlock のみ）到着時点では未解決」
  「2レコード目（read 付き）到着で解決、かつ内容が2レコード目由来」を確認する。
- 修正前のコードに対してこのテストが実際に red になることを確認してから（`git stash` 等）、
  修正後に green であることを確認する（discrimination の裏付け、AGENTS.md の慣例）。
- 実機診断（AC1/AC2）は test 工程で実行し、`test-result.md` に生ログを貼る。
- T4（`npm run test -w @ts5250/tn5250` 全件）で、T2 の新規テスト以外の既存テストに
  回帰が無いことを確認する。

## タスク

- [x] T1: `handleRecord()` の `pendingAid`/`this.state`（`onceReady` 含む）解決条件を
      `unlocked` から `readSolicited`（改名したローカル変数）ベースへ切り替える。
      対象: `packages/tn5250/src/session/session.ts:568, 673-694`（`research.md` A1/A2、
      `design.md`「振る舞いの詳細」の擬似コード）
      依存: なし
      AC: AC3
- [x] T2: 複数レコードに分かれた応答（1レコード目: unlock のみ・read 無し、2レコード目:
      read 付き・実データ）を合成し、`sendAid()` が2レコード目まで解決を待つこと、
      解決される画面が2レコード目の内容を反映することを検証する単体テストを追加する。
      修正前のコードでは red になることを確認する（discrimination）。
      対象: `packages/tn5250/test/`（新規ファイル。`sendaid-cursor-sync.test.ts` の
      `DeferredTransport`/`buildRecord`/`ByteWriter` の書き方を参考にする——research.md
      「design への申し送り」参照）
      依存: T1
      AC: AC4
- [x] T3: 修正後、`scripts/diag-dspfmt-ws-e2e.mjs`（8回以上）と
      `scripts/diag-dspfmt-reconnect-blank.mjs`（`sendAid()` の解決値を見る形に改修済み、
      `decisions.md` D1。6回以上）を再実行し、それぞれ AC1（罫線のみ0件）・AC2（コア層の
      discrimination——修正前は複数回中すべてで再現していたのが解消していること）を
      確認する。実機トレースなので test 工程で実施し、生ログを `test-result.md` に貼る。
      対象: 未特定（test 工程での実機トレース実施そのもの。コード変更は伴わない）
      依存: T1
      AC: AC1, AC2
- [x] T4: `npm run test -w @ts5250/tn5250`（既存テスト全件）を実行し、回帰が無いことを
      確認する。
      対象: 未特定（既存テストの実行そのもの）
      依存: T1, T2
      AC: AC5
