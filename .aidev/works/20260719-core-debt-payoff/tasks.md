# タスク

- [x] **T1** `eslint.config.js` に `no-restricted-globals` を追加（適用範囲は既存の
      `no-restricted-imports` と同じ）
- [x] **T2** **違反コードで実際に落ちることを確認**する（ピュア層に `Buffer.from()` を
      一時的に書いて lint → 落ちるのを見てから戻す）。確認結果を test-result に記録
- [x] **T3** `As400Error` へ改名。`Tn5250Error` を互換別名として export（コメントで位置づけを明記）
- [x] **T4** core/src 内の使用箇所を新名へ置換。継承 3 クラスの `super` も
- [x] **T5** 別名の後方互換をテストで固定（`Tn5250Error` で import できる・`instanceof` が効く）
- [x] **T6** core `log.ts` を pino 非依存にする（`CoreLogger` / `setLogSink` / 既定 no-op）
- [x] **T7** `packages/core/package.json` から pino を外す
- [x] **T8** `packages/server/src/log.ts` を新設（pino）。server 6 ファイルの import を切り替え
- [x] **T9** `packages/server/package.json` に pino を追加
- [x] **T10** `main.ts` で `setLogSink` を呼び core へ注入
- [x] **T11** **注入なしでも server のログが出る**ことをテストで固定（監査ログが消えない）
- [x] **T12** 全テスト / `tsc -b` / lint / web-ui ビルド / `npm ls pino`
- [x] **T13** backlog を更新（やった 3 件を [x]、やらない 2 件を**実測値つきで書き換え**）
