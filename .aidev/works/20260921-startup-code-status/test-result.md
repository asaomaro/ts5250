# テスト結果: 表示セッションの開始の知らせ

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `cd packages/server && npx vitest run test/ws-host-reconnect.test.ts test/ws-handler.test.ts test/ws-reconnect-resume.test.ts` — 53 passed / 0 failed
- `cd packages/web-ui && npx vitest run test/startup-code-notice.test.ts test/session-reconnect.test.ts test/host-reconnect.test.ts test/startup-rejection-ja.test.ts` — 64 passed / 0 failed
- mutation（`scratchpad/mut-sc.py` 10 通り＋`mut-sc2.py` 2 通り）— 全部 KILLED（1 通りはテストを足してから）

## 受け入れ基準ごとの判定
- AC1: pass — `ws-host-reconnect.test.ts`（開く・後から入る・繋ぎ直しで載る、起動応答が無ければ載せない）。
- AC2: pass — `startup-code-notice.test.ts`（開いたら出して 3 秒で消す・I901・エラー状態に入らない・間の別の通知を消さない・先の通知を上書きしない・繋ぎ直し）と
  `session-reconnect.test.ts`（ブラウザの繋ぎ直しの `opened`）。
- AC3: pass — `startup-code-notice.test.ts`（ⓘ に「起動」の行）。
- AC4: pass — 実機（社内機・2026-09-22）でサーバーの ws 経由で表示セッションを開き、`opened.startupCode` が I902（関連付けなし）・I901（保存した設定の
  `associatedPrinter` に存在しない名前）になった（`scratchpad/ap/ws-startup.mjs`。サインオン画面で閉じた）。設定の関連付けがサーバーの経路を通ってホストまで届くことも同時に確かめた。
- AC5: pass — mutation 12 通りすべて KILLED。

## 失敗の証跡
このラウンドではテストの失敗は発生していない。書いたテストの 1 回目は、記録済みの実機トレースに起動応答が入っていなかったので `opened` に載らず落ちた
（トレースは起動応答より後から採っている。テストで開いた直後のセッションに起動応答を持たせた）:

```
     × 開いたときの `opened` に載る（実機の記録の I902） 14ms
     × 後から入ったタブの `opened` にも載る 6ms
AssertionError: expected { type: 'opened', …(4) } to match object { type: 'opened', startupCode: 'I902' }
AssertionError: expected undefined to match object { startupCode: 'I902' }
      Tests  2 failed | 7 passed (9)
```

mutation で 1 通り生き残った（先に出ている通知を上書きしない判定）。テストを足して落ちるようにした:

```
SURVIVED 先に出ている通知を上書きする :: 47 passed (47)
$ python3 scratchpad/mut-sc2.py
KILLED 先に出ている通知を上書きする :: 1 failed | 47 passed (48)
```

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 46033)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

新しい入口は足していないので `smokeCommands` は据え置く。

## 未検証の穴（skip / 環境不足）
- 実ブラウザでの見え方（通知欄に 3 秒出て消える）は jsdom まで。
- ACS の GUI の状態行そのものは測れない（ECL のコアに GUI は無い）。原典（`AcsOnly.displayResponseCode`・`StatusBar`）まで。

## 節目 10 の対応（ラウンド 2 の指摘を直した回）

### 実行したもの
- `npm test`（全量）— 6,619 passed / 0 failed / 41 skipped（10 ワークスペース）
- `npm run lint` — exit 0 / `npm run build`（web-ui の `vue-tsc` を含む）— exit 0（途中の 1 回は `field-exit-checks-wiring.test.ts` の型で落ち、`NonNullable<Field["dbcsType"]>` に直した）
- mutation（`scratchpad/mut-c10.py` の C-S6 の 5 通り）— 5 通りとも落ちた（旧 `mut-sc.py`・`mut-sc2.py` の分と合わせて開く・繋ぎ直し・後から入る経路を固定）

### 受け入れ基準の再確認
- AC1〜AC5: pass（全量）

### 失敗の証跡
直す前の点検役の再現: I906 で開いたセッションに「セッションを開始しました（起動応答 I906）」と出る。ブラウザの繋ぎ直しでも出る。

直した後の mutation（C-S6 の 5 通り）はすぐ落ちた（生き残りは無く、失敗の記録は無い）。

### 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45959)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

### 未検証の穴
- I906 などの成功扱いを ACS がどう扱うかは実機で測っていない（台帳）
- 状態行の履歴（ACS）は写していない（台帳）
