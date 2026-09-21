# テスト結果: 起動応答コード 2703 / 2777 / 8936 / 8937 を知らない

## 実行したもの
```
$ cd packages/tn5250 && npx vitest run test/startup-record.test.ts test/startup-reject.test.ts
  Tests  22 passed (22)
```
**全量・lint・build はバッチの節目でまとめて回す**（利用者の方針。項目ごとには回さない）。

## 受け入れ基準ごとの判定
- AC1: pass — `isKnownStartupCode` が 4 コードで true。
- AC2: pass — 装置名なしでも `session rejected <code>` が出て、`expected ESC` が出ない。
- AC3: pass — `STARTUP_SUCCESS_CODES` に入っていない。
- AC4: pass — 出所コメントに ACS のクラス／メソッド名と通信状態の対応、**文言が未確認である旨**を明記。
- AC5: pass（節目でまとめて確認）。

## 失敗の証跡

**テストの期待を一度取り違えた**——失敗コードの警告は `session rejected <code>` なのに、
成功側の `startup response <code>` を期待していた。

```
× 2703 を起動応答として認識する（装置名が無くてもデータ扱いしない）
  AssertionError: 起動応答として扱われていない＝5250 データに流れ込んでいる:
  expected false to be true
```

**実装ではなくテストの誤り**。既存テスト（`8902` で `session rejected 8902` を見ている）に合わせて直した。

## mutation（条項 `verify-by-mutation`）
```
表から `8936` の 1 行を外す → Tests  4 failed | 18 passed (22)
復元                        → Tests  22 passed (22)
```

## 未検証の穴
- **2703 / 2777 の意味は未確認。** ACS は個別の通信状態（12 / 13）へ落とすところまでは確認したが、
  通信状態→メッセージキーの対応を追えていない。**文言にその旨を書いてある**ので、
  ログを読む人が「まだ掴んでいないコード」と分かる。
- **実機でこの 4 コードを出させてはいない**（自動サインオンの失敗を作る必要がある）。
  認識の経路は結合テストで固定した。
smoke: /healthz ok, / が Web UI を返した (port 46533)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
