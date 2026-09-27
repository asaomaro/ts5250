# 仕様: 継続欄の O への挿入の ACS の測定

## 依拠する既存の事実
- DSM は `scripts/host-src/dscmd.c` にモードを足して `scripts/build-dscmd.mjs` で作る。継続欄は `PROBE_ENPTUI=true` で割られる（`scripts/README.md`）

## 受け入れ基準との対応
- AC1: DSM の CONTO と `scripts/acs-probe/cont-o-insert.txt`。結果は台帳
