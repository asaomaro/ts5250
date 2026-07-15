# 計画: 04-dbcs-tls-wide — DBCS・TLS・27x132・QUERY

親: 20260714-5250-mcp-web-emulator（scope は親 plan.md の境界表で凍結済み。分解のみ・再分割なし）
依存: 03-web（review 承認済み）

## 実装方針

- **DBCS が最大の工数・技術リスク**（research）。データモデル（Cell.kind の so/si/dbcs-lead/dbcs-tail、
  Field.dbcsType）は 01 で型定義済みのため、04 は実装の追加であって作り直しにはならない。
- 段階: 変換テーブル（DBCS）→ codec（EBCDIC_STATEFUL）→ 画面（SO/SI・DBCS セル）→ フィールド入力 →
  端末タイプ → TLS → 27x132 → QUERY 拡充 → web 描画 → 実機/リプレイ検証。
- **受け入れ基準 13 項目の総点検は親の統合 test** に属する（protocol 2.8）。04 は DBCS/TLS/27x132/QUERY を
  **単独で検証**する（オフライン decode/encode・リプレイ・限定的な実機疎通）。

## リスク / 留意点

- **PUB400 の DBCS 検証は限定的**（research F3）: プロファイル CCSID 恒久変更不可。`CHGJOB CCSID(1399)`＋
  IGCDTA(*YES) の自作ソース PF レベルでの日本語入出力に限る。よって **DBCS はキャプチャ再生（fixture）を主軸**とし、
  実機は疎通確認レベル。日本語 NLV 画面（システムメニュー日本語化）は不可。
- **DBCS 端末タイプ名（IBM-5555 系）の受理**は冒頭で PUB400 実機確認する。拒否されたら 3477/3179＋CCSID のみで
  DBCS を試す代替経路を検討（decisions に記録）。
- **tn5250j は GPL**: DBCS 実装の挙動参考のみ。根拠は RFC 1205/4777・SC30-3533-04・ICU .ucm に置く。
- TLS 証明書検証は既定 ON。PUB400 は Sectigo DV（research で実測確認済み）。
- 27x132 のワイド画面は PUB400 で該当画面（WRKACTJOB 等の F11 拡張表示や 132 桁表示コマンド）を探して検証。

## テスト方針（protocol 2.8・この subtask の範囲）

- ユニット: DBCS codec（EBCDIC_STATEFUL の decode/encode・SO/SI・変換不能）、ScreenBuffer の SO/SI/DBCS セル
  （桁位置不変）、DBCS フィールド入力のバイト長検証、Query Reply の端末別能力、27x132 バッファ切替、
  screenToText の DBCS 桁保持。
- リプレイ: PUB400 で採取した DBCS 画面 trace（CHGJOB CCSID(1399)＋IGCDTA ソース PF）からのスナップショット検証。
- 実機疎通: TLS 接続（ポート 992）、DBCS 端末タイプ受理、27x132 画面表示。
- **MCP×Web 同時セッション・受け入れ基準 13 項目の総点検は親の統合 test に委ねる**（ここではやらない）。
