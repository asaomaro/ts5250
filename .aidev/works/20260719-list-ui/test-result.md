# テスト結果（2026-07-19T00:45:36Z）

## 受け入れ基準

| # | 基準 | 結果 |
|---|---|---|
| 1 | 3 種のペインが開ける | ✅ `list:jobs` / `list:objects` / `list:users` |
| 2 | 一覧が表示される | ✅ 実機の API 経由で 3 種とも |
| 3 | 絞り込みが効く | ✅ ライブラリ・ユーザー・種別 |
| 4 | ジョブ操作 | ✅ 保留/解放/終了の CL を組み立て。実機のジョブで経路を確認 |
| 5 | オブジェクト削除 | ✅ **使い捨ての `MYLIB/UITEST` を作って削除**（`CPC2191`） |
| 6 | 失敗時にメッセージ ID | ✅ `CPF2105 "Object NOSUCHOBJ ... not found."` |
| 7 | コンポーネントテスト | ✅ UI 10 件 / サーバー 10 件 |
| 8 | 既存テストが緑 | ✅ |

## 実機での確認（API 経由）

```
オブジェクト: MYLIB CLRTPGM *PGM / INLPGM *PGM / A1 *FILE ...
ジョブ:       000000/QSYS/SCPF *ACTIVE X ...
ユーザー:     ENGMTZ / USER / SANDEP981 / VENSUJA
削除:         MYLIB/UITEST(*DTAARA) → CPC2191 "deleted."
失敗:         NOSUCHOBJ → CPF2105 [severe] "not found."
```

実機に作った `UITEST` は削除済み。

## 自動テスト

core 462 / server 202（新規 10）/ web-ui 289（新規 10）= **953**。

## 未検証の範囲

- **ジョブの終了（`ENDJOB`）は実行していない**。他人のジョブを止められず、
  自分のジョブを止めると検証中の接続が切れるため。CL の組み立てとエラー経路のみ確認
- 大量件数（200 件上限）での表示
- 認証オン環境での権限の見え方
