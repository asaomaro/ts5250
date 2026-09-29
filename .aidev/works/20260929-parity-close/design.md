# 仕様: 台帳を閉じる

## 概要
DSM に WDSFMINOR を足し、ACS のコア・当 PJ のコアを実機で比べる。台帳の残り 9 件に、必須でない理由を書いて閉じる。

## 依拠する既存の事実
- `scripts/host-src/dscmd.c` の WDSFNEG（同じ形）・`scripts/verify-wdsf-negative.mjs`

## 受け入れ基準との対応
- AC1: `scripts/verify-wdsf-minor.mjs`（pass=18）
- AC2: `.aidev/backlog/acs-parity.md`
