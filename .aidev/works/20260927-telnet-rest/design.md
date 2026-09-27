# 仕様: telnet の残り

## 依拠する既存の事実
- 変数の値の作り方（エスケープ・暗号化・正規化）は `telnet.ts` の既存の実装（`20260921-telnet-signon-vars`・`20260921-encrypted-autosignon` ほか）

## インターフェース / データ構造
- `answerEnvSend(sb, table, user)`: SEND を読み、聞かれた順に答えのバイト列を組む（純関数・export）
- `EnvVar { name, value(): number[] }`: 表の 1 行。DEVNAME は書くたびに次の名前

## 受け入れ基準との対応
- AC1: 表を ACS の順に組み、`answerEnvSend` が SEND の順に答える
- AC2: 実機（PUB400・社内機）で既存の検証スクリプトを流す
