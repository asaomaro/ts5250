# 計画: 01-core-sbcs — 通信コア SBCS 縦貫通

親: 20260714-5250-mcp-web-emulator（scope は親 plan.md の境界表で凍結済み。ここでは分解のみ行う）

## 実装方針

- 下から積む: scaffold → 変換 → transport/telnet → （実機 trace 採取）→ パーサ/画面 → セッション。
- **T7（trace 採取）を中間に置く**のが肝: 以降のパーサ・画面・セッションのテストを実データのリプレイで
  駆動し、PUB400 への接続を最小化する。
- 各モジュールは design.md の core 構成（transport/telnet/protocol/screen/codec/session/trace）に 1:1 対応。
  ピュアロジック（codec/protocol/screen）は Node API 非依存を lint/tsconfig で強制する。
- DBCS 分岐は一切実装しない（04 の scope）。ただし spec のデータモデル（Cell.kind、Field.dbcsType）は
  型として定義だけしておく（04 で作り直しにならないため）。

## 前提（ユーザー準備事項）

- PUB400 アカウント（作成済み・初回パスワード変更済み）。資格情報は環境変数
  `PUB400_USER` / `PUB400_PASSWORD` で渡す（リポジトリ・trace には残さない。trace は伏字化を確認してコミット）。

## テスト方針（この subtask の範囲）

- ユニット: codec 対照表・telnet ネゴのバイト列シナリオ・ByteReader/Writer・ScreenBuffer 不変条件
  （SO/SI はまだ出ないが cells 全桁保持・マスクは検証）。
- リプレイ回帰: PUB400 trace（サインオン画面・メニュー遷移）からのスナップショット検証・
  sendAid の Read 応答バイト列検証。
- 実機疎通: サインオン→メインメニュー→F3 サインオフの往復（telnet 23・SBCS・24x80）。
- 結合検証（MCP/Web/DBCS/TLS）は親の統合 test へ（ここではやらない）。
