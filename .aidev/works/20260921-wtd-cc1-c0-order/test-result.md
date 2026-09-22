# テスト結果: WTD の CC1=0xC0 で欄が消えない

## 実行したもの
```
$ cd packages/tn5250 && npx vitest run test/wtd-applier.test.ts
  Tests  33 passed (33)
```
**全量・lint・build はバッチの節目でまとめて回す**（利用者の方針）。

## 受け入れ基準ごとの判定
- AC1: pass — CC1=0xC0 で欄の値が空になる。
- AC2: pass — 同時に MDT も落ちる。
- AC3: pass — 下記 mutation。
- AC4: pass — `case 0xc0` に ACS のメソッド名と順序を明記。
- AC5: pass（節目でまとめて確認）。

## 失敗の証跡

**テストの書き方を一度間違えた**——`fieldByIndex(1).value` は内部表現に `value` が無く、
`TypeError: Cannot read properties of undefined (reading 'trim')`。

```
TypeError: Cannot read properties of undefined (reading 'trim')
 ❯ test/wtd-applier.test.ts:190:38
```

既存の流儀（`snap.fields[0].value`）に合わせて直した。

## mutation（条項 `verify-by-mutation`）
```
順序を元に戻す（resetMdtNonBypass を先に） → Tests  1 failed | 32 passed (33)
復元                                        → Tests  33 passed (33)
```

## 未検証の穴
- **実機で CC1=0xC0 を出させていない。** 候補の DDS（`ERASEINP MDTOFF`）は未確認。
  合成 WTD での固定に留まる。実機で出せれば、付随の差（継続欄・DBCS 欄）も一緒に測れる。
smoke: /healthz ok, / が Web UI を返した (port 46013)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
