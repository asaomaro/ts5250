# レビュー: `pendingAid` の解決条件を「Read 要求」に一本化する

## タスク点検ログ

- [should][conv:-] T1: `session.ts` の追加コメントが「`pendingAid` が骨格レコードで
  解決される」バグの説明はしているが、design.md が明記する「`this.state`/`onceReady`
  も一緒に切り替える理由」（`assertReady()` を通した新規 AID 送信のレース）に一切
  触れていなかった。
  — 対応: `this.state = "ready"` 遷移の直前にコメントを追加し、
  `ws-handler.ts`/`app.ts` のメッセージ非直列化を理由として明記した
  （`aidev taskcheck report T1 --findings 1`）。
- [nit][conv:-] cross: T1 実装（`handleRecord()` 冒頭へのコメント挿入）で行番号がずれ、
  design.md「依拠する既存の事実」の複数箇所（`handleClose()`・「Read の無いレコードでは
  上書きしない」既存区別）が古い行番号のまま残っていた。設計判断の内容自体に誤りは無い
  （T1・T2 との整合は横断点検で確認済み）。
  — 対応: design.md の該当行番号を全て現在の実装に合わせて更新した
  （`aidev taskcheck report cross --findings 1`）。

## レビュー指摘（ラウンド1）

- [should] 新規回帰テストが、design.md が明記する不変条件（`emit("screen", snap)` は
  `readSolicited` の判定と無関係に毎レコード発火する）を検証していなかった——将来
  `emit("screen", snap)` が誤って `if (readSolicited)` の内側に移動するような退行が
  あっても検出できない状態だった（web-ui の🔒表示・busyインジケータが依拠する経路。
  design.md「副次的な改善」参照）。
  — 対応: `session.on("screen", ...)` を購読し、骨格レコード・実データレコードの
  それぞれで発火し、`keyboardLocked` が正しく変化することを検証するテストケースを
  追加した（`pending-aid-multi-record.test.ts` 3件目、全3件green）。

指摘は上記1件のみ（must=0, should=1, nit=0）。その場で対応済み。
