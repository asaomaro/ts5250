# テスト結果: 挿入モードの余地を ACS と同じに数える

## 実行したもの
- web-ui `test/insert-no-room.test.ts` — 22 passed（純関数 9・打鍵 13）。挿入・継続欄・IME・「出た」状態に関係する 18 ファイル — 437 passed / 0 failed
- 型検査: `vue-tsc --noEmit`（`tsconfig.json`・`tsconfig.test.json`）通過
- 実機（ACS のコア）: `scripts/acs-probe/insert-no-room.txt` を 2 回（同じ結果）、`insert-no-room-continued.txt` を `PROBE_ENPTUI=true` で 2 回
  （2 回目に見分けのつく C6・C7 を足した）。拡張なしでも 2 回流し、ホストが欄を割らないことを確かめた。
- 全量・lint・build は節目でまとめて回す（この項目では回していない）。

## 受け入れ基準ごとの判定
- AC1: pass — 最終桁（I2）・途中の空白（I4）・満杯（I5）・行またぎ（I3）の 4 例を ACS の実測と同じ入力で固定。
- AC2: pass — 右寄せの `    12-`（台帳の再現手順）・数字桁が埋まって符号桁が空白・左詰めの押し出し・最終の数字桁で「出た」→ 次は 0012。
- AC3: pass — 継続欄 C2・C5・C6・C7 と区間の終わりで次の区間の先頭へ。IME（SBCS）の満杯で 0012。DBCS の予算超過で 0012。
- AC4: pass — mutation 14 通り（I-a〜I-o。I-k は条件ごと撤去）すべて検出。1 回目は I-g（符号付きの余地を最終桁まで数える）と
  I-k（「出た」後は常に 0018）が生き残った。I-g は例が見分けられなかったので例を足し、I-k は足した条件が等価だったので戻した（D4）。

## 失敗の証跡

```
$ python3 mut-ins.py   # 1 回目
I-g 符号付きの余地を最終桁まで: 21 passed (21)
I-k 出た後は常に 0018: 21 passed (21)
```
テストの例の弱さ（I-g）と、実装に足した条件が等価だったこと（I-k）。直した後は I-g も検出（`1 failed | 21 passed (22)`）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45065)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 実ブラウザでの打鍵（jsdom のみ）。DBCS 欄の最終桁・継続欄への IME 確定は ACS 側を測っていない（台帳に残した）。
