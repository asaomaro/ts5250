# タスク: オフライン回帰を CI で回す

- [x] T1: `npm run lint` / `npm run build` / `npm test` が手元で通ることを確かめる。
      対象: リポジトリ直下 / 根拠: AC3
- [x] T2: ワークフローを書く（`lint` → `build` → `test`、Node 20、資格情報なし）。
      対象: `.github/workflows/ci.yml`（新規）/ 根拠: spec D1 D2 D3
- [x] T3: 観測した揺れを記録する。
      対象: work の `verify/results.md` / 根拠: spec D5・AC4
