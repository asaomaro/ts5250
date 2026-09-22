# 仕様: 自動サインオンの変数

## 設計方針
- USER: `trim().toUpperCase()`。IBMRSEED: 名前と VALUE の印だけ。IBMSUBSPW: 末尾の空白を落とす。USER と IBMSUBSPW の値は `envValue`（0x00〜0x03 の前に ESC）を通す。
- 変数の順と、ACS が送る他の変数（値なしの DEVNAME・KBDTYPE の空白）は変えない（台帳に残す）。

## 依拠する既存の事実
- `sendSb` が 0xFF を二重にする（`telnet.ts`）。

## 受け入れ基準との対応
- AC1: `telnet.test.ts`（3 件）。AC2: `scripts/verify-autosignon.mjs`（PUB400）と ACS のワイヤ（research F4）。
