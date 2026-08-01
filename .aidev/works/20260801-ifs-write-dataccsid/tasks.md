# タスク: IFS の書き込みタグ

- [x] T1: 実機で 4 条件を測る（無指定 / `dataCcsid=1208` / `1399` / 既存の上書き）
- [x] T2: `/api/host/ifs/write` のテキスト経路で `dataCcsid` を渡す（符号化に使った CCSID）（依存: T1）
- [x] T3: `IfsConnection.writeFile` のコメントを実態に合わせる
      （「通常経路は指定しない」は誤り。既定タグは機械ごとに違う）（依存: T1）
- [x] T4: 偽の接続に `dataCcsid` を記録させ、テストの期待値を更新する（依存: T2）
- [x] T5: `npm run build` / `npm run lint` / `npm test` ＋ 実機で再確認（依存: T1〜T4）
