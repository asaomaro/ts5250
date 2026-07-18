# ライブラリ切り出し

`packages/core` の各層を他プロジェクトから使えるライブラリとして切り出す構想。
2026-07-18 の ACS データ転送（signon 認証）実装時に、結合度を測って洗い出した。

## 前提: 依存関係の実測（2026-07-18 時点）

```
codec      227行 ＋ テーブル18,900行   依存: なし        ★完全に独立
scs.ts     246行                       依存: codec のみ
hostserver 878行                       依存: errors/codec/log/transport
protocol ⇄ screen                      相互依存（分割不可）
session    770行                       依存: ほぼ全部 ＝ TN5250 クライアント本体
```

## 先に返すべき負債（どの切り出しにも共通で効く）

切り出しの実作業より、こちらが本体。**とくにコーデックは「依存ゼロ」が売りなので、
pino を持ち込むと価値が半減する。**

- [ ] ロガーを注入可能にする（現在 `pino` を直接依存。ライブラリが利用側にロガーを強制している）
  - `hostserver/` は `log.ts` を1箇所で使うだけなので、今なら数行で済む
- [ ] 例外の基底を `Tn5250Error` → `As400Error` に改名（旧名は別名で維持し既存コードを壊さない）
  - ホストサーバーは TN5250 ではないのに `Tn5250Error` を投げていて、名が体を表していない
- [ ] `ErrorCode` の整理（19種に `FIELD_PROTECTED` / `KEYBOARD_LOCKED` / `NEGOTIATION_TIMEOUT` など
      ホストサーバーに無縁のものが混在）
- [ ] CCSID テーブルの同梱単位を見直す（CCSID 37 の174行のために DBCS 込み18,900行が付いてくる）

## 切り出し候補（推奨順）

- [ ] **1. EBCDIC コーデック** — 依存ゼロ、今すぐ出せる、独自価値が明確
  - SBCS(37/273) と DBCS(930/939/1399)、SO/SI 制御に対応。npm の EBCDIC 系は SBCS 止まりが多い
  - ICU の .ucm から生成する `tools/gen-tables` も併せて出せば CCSID を増やせる
- [ ] **2. SCS デコーダ** — 246行、依存は codec のみ。1 と同じ切り出しで一緒に出せる
  - スプールのバイト列 → 論理ページ。`server/src/pdf.ts` が66行で済んでいるのは分離が効いている証拠
  - IBM i のスプールを扱いたいが TN5250 一式は要らない、という需要に合う
- [ ] 3. ホストサーバー（`hostserver/` ＋ `transport/host-connection.ts`）
  - **SQL 実装後に実施**（認証だけでは単体の使い道が乏しく、API が固まる前に公開契約にしたくない）
  - needs: SQL 実行機能の実装
- [ ] 4. TN5250 クライアント一式（`protocol`/`screen`/`session`/`telnet`/`transport`/`trace`）
  - `protocol ⇄ screen` が相互依存のため分割不可。出すなら一式
  - 競合あり（例: green-screen-react）。差別化軸は「純 TypeScript・依存なし・トレース再生付き」
  - 最も重いので最後でよい
