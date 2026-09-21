# テスト結果: Unicode の欄の実機測定

## 実行したもの
- 実機（社内機）の測定（コードの変更なし）: `scripts/build-unitest.mjs` → `scripts/diag-unifield.mjs`（当 PJ）→ `scripts/acs-probe.mjs scripts/acs-probe/unicode-field.txt`（ACS のコア）→ `--clean`
- `node --check`（3 本）— exit 0 / `npx eslint scripts/build-unitest.mjs scripts/diag-unifield.mjs` — 1 回目は `numf`（既存のビルダーから写した未使用の関数）で 1 件落ち、消して exit 0

## 受け入れ基準ごとの判定
- AC1: pass — 道具 3 本と C のソースが残る。再実行して同じ結果（1 回目の DDS のコンパイルの落ち方は下）
- AC2: pass — 当 PJ が受けた WTD の生バイトに `1D 40 20 82 80 …`（FCW 0x8280＝DBCS open）とデータ `24 C1 C2 0E 44 81 44 82 0F …`（EBCDIC 混在）。FCW 0x90xx・WDSF 0x54 は無し。ACS のコアの画面も `ABああいい`（dump は DBCS を 2 桁ぶん重複して出す）
- AC3: pass — 台帳を直し、`--clean` で UNITST・UNIDSPF・メンバー・IFS のソースとログを消し、CHKOBJ で無いことを確認

## 失敗の証跡
DDS の 1 回目（A 型に CCSID を付けた形）と CL の 1 回目は実機のコンパイルで落ちた:

```
A37/A1200/A13488/A1399/A930: DDS のエラーが，指定の GENLVL では認められない。   → 作成されず
G13488/G1200/GPLAIN: ファイル UNIDSPF が作成された
CRTBNDCL: プログラム UNIPGM は作成されなかった。（CPF0820）
CRTBNDC 1 回目: CZM0045(30) Undeclared identifier UNITST_LOG.   → ソースの置き換えが最初の 1 か所だけだった（`replaceAll` に直した）
_Ropen 1 回目: fopen が IFS を開けず rc=2   → `SYSIFCOPT(*IFSIO)` を足した
```

## 起動確認（smoke）
測定と道具だけで、製品のコードは変えていない。`smoke` は同じセッションの `20260921-wtd-control-bytes` で通した。

## 未検証の穴（skip / 環境不足）
- Unicode を申告した ACS（設定で ON）の受け方は測っていない（当 PJ は申告しないので不要）
- WDSF 0x54 の EBCDIC 版（flag 0x80）・FCW 0x80xx・0x84xx は、実例が無く測っていない
