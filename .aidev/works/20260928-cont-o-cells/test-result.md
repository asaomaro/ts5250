# テスト結果: 継続欄の O の編集を ACS と同じセルの並びで行う

## 実行したもの
- `cd packages/web-ui && npx vitest run` — 2956 passed / 0 failed
- `cd packages/tn5250 && npx vitest run` — 1157 passed / 0 failed
- `cd packages/server && npx vitest run` — 1660 passed / 0 failed / 3 skipped
- `npm run lint` / `npm run build` / `npm run build -w @ts5250/web-ui`（vue-tsc）
- 実機（社内機・ブラウザ）: `node --env-file=.env --env-file=.env.verify scripts/verify-browser-cont-o.mjs` — 3 回とも `RESULT: pass=24 fail=0`、独立点検の修正の後にもう 1 回 `pass=24`
- 実機の ACS のコア: `scripts/acs-probe/cont-o-edit.txt`（12 通り）・`scripts/acs-probe/cont-o-last-lead.txt`（前半が区間の最後の桁。`0e448244874488448144840fe740e8e9`・カーソル 6,11）
- mutation（scratchpad の `mut.py`）: 34 通り中 32 検出・2 は等価（decisions D9）。点検の修正に 6 通り当て 5 検出・1 は等価（IME の余りの break）

## 受け入れ基準ごとの判定
- AC1: pass — `o-chain-cells.test.ts`（C01〜C04・C09〜C12 の区間のセル）と `o-chain-send.test.ts`（その値から組む READ MDT の欄データが ACS のバイト列と一致）
- AC2: pass — 同じく C05〜C08（上書きの区間送り・Delete・Backspace・Erase EOF）
- AC3: pass — `o-chain-cells.test.ts` のカーソル（区間・桁）が research F2 の表と一致、実機のブラウザでも 12 巡ともカーソルが一致
- AC4: pass — `o-chain-send.test.ts` の C12（SI|SO の詰め）・C02（死んだ桁は途中の NUL＝空白）・ALT の死んだ桁
- AC5: pass — `o-chain-cells.test.ts` の 0012 の 3 件（余地不足・死んだ桁の分の溢れ・表に無い位置）と `o-chain-edit.test.ts` の 0012（値は変えない）
- AC6: pass — 実機のブラウザで 12 巡のバイト列とカーソルが ACS と一致（3 回）。C09・C10 は末尾の `40` を除いて比べた（既知の差。decisions D4）
- AC7: pass — 既存の O 欄・継続欄のテストを含む全件。`dbcs-insert-sosi-room.test.ts` の継続欄の 1 件は旧挙動を固定していたので、ACS の詰め直しの結果へ書き換えた（取り消し線で旧の期待を残した）

## 失敗の証跡
このラウンドでは差し戻しの失敗は発生していない（開発中の失敗はテストの期待値の書き間違い——8 桁の数え違い・view の添字の数え違い——で、実装の修正は要らなかった。
`dbcs-insert-sosi-room.test.ts` の 1 件は旧挙動の固定）。

```
$ npx vitest run  (packages/web-ui, 配線の直後)
 FAIL  test/dbcs-insert-sosi-room.test.ts > 対象外: この検査を掛けない場合 > 継続欄は ACS の別の手順（併合と語詰め）なので、ここでは見ない（従来どおり入る）
      Tests  1 failed | 2944 passed (2945)
```

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 38976)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 語送り（FCW 0x8680）の欄・継続した O 欄への貼り付け・単独の SO/SI の Delete の詰め直しは未測定（台帳の兄弟の `[ ]`）
- 空白と NUL の区別（C09・C10 の末尾の `40`、ALT の途中の NUL）は既知の差
- SI が区間の最後の桁のときの全角の挿入は ACS が字を区間の間で割る——当 PJ は 0012（既知の差。台帳 (e)）
