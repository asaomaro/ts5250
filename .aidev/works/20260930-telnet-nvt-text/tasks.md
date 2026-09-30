# タスク: 交渉の前のテキスト

## 実装方針
偽のサーバーで ACS のコアを測る → 純関数 → telnet 層 → セッション → 検証。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 既存の試験・再生は交渉を省いたレコードを流す（IAC EOR 終わりはレコードにする）
- 実機は要らない（IBM i は交渉前にテキストを送らない）

## テスト方針
- 単体（書き出しのバイト・telnet 層・セッション）、変異、偽のサーバーで ACS のコアと画面比較

## タスク
- [x] T1: 偽のサーバーと ACS のコアの測定（9 通り）
      対象: `scripts/fake-nvt-server.mjs`（新規）`scripts/acs-probe/nvt-text.txt`（新規）
      依存: なし
      AC: AC1
- [x] T2: NVT の書き出し（純関数）
      対象: `packages/tn5250/src/telnet/nvt-text.ts`（新規）
      依存: T1
      AC: AC1
- [x] T3: telnet 層のテキストの見分けと渡し
      対象: `packages/tn5250/src/telnet/telnet.ts` `feed` `handleIac` `handleOptNeg`
      依存: なし
      AC: AC2
- [x] T4: セッションの適用と接続の待ち
      対象: `packages/tn5250/src/session/session.ts` `handleNvtText`
      依存: T2, T3
      AC: AC3
- [x] T5: テストと ACS との画面比較
      対象: `packages/tn5250/test/nvt-text.test.ts`（新規）`packages/tn5250/test/telnet.test.ts` `scripts/verify-nvt-text.mjs`（新規）
      依存: T4
      AC: AC1, AC2, AC3
