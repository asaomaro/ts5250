# レビュー: 930（Katakana / Katakana Extended）を利用者に選ばせる設定

## タスク横断点検ログ
- cross: 同じセッションで全タスクの差分を読み直した。指摘なし（`aidev taskcheck report cross --findings 0`）。

## ラウンド 1

- **要件適合**: `aidev coverage --strict` は gap 0（AC1〜AC4 が design・tasks とも 100%）。930/5026 の
  Katakana/Katakana Extended/未指定の 3 状態を、`--accent` ならぬ 2 個の独立フラグ
  （`uppercaseInput`/`katakanaRestricted`）で表す設計どおり実装されている。
- **価値適合**: 利用者から提示されたスクリーンショットの根拠（ACS 自身が利用者ごとに選ばせる設定）どおり、
  当 PJ にも同じ選択肢が増えた。未指定の利用者には何も変わらない（AC4）。
- **正確性**: `deviceEnvFor`・`ConfigResolver`・`ws-handler` の「opened」送出・`EmulatorPane` の計算式・
  `fieldValidate.rejectReason`・`ConfigCard` の UI 表示条件まで、system→session→core→サーバー→ブラウザの
  全層を通しで mutation テストして検証済み（生存 0）。
  - [should] **S1** `packages/server/src/config-types.ts` の `katakanaVariant` スキーマに、
    不正な形（型違い・enum 外の文字列・配列・null 等）を弾くテストが無かった
    （`.aidev/conventions/test-input-shape.md` [conv:test-input-shape!]——外から来る入力
    〔REST の system/session 設定〕を弾くコードに、値だけでなく型・容れ物を振ったテストが要る）。
    `config-store.test.ts` に `addSystem`/`addSession` へ 8 通りの不正な形（文字列の typo・空文字・数値・
    真偽値・null・配列・オブジェクト・配列に包んだ正しい値）を渡す `it.each` を追加し、スキーマの
    `enum` 制約を外す変異で検出することを確認した（16/17 KILLED。1 件は `z.any()` に緩めても
    たまたま通る組み合わせで、変異自体が粗すぎたための想定内）。
- **規約適合**: 新規エクスポート（`isKatakana290InvalidChar`）は `@ts5250/ebcdic` のバレルへ足さず、
  既存の `isKatakanaCcsid` と同じ狭い入口（`@ts5250/ebcdic/katakana`）のまま——バレル非再輸出の
  ガードテスト（`ebcdic-not-reexported.test.ts`）が緑であることを確認済み。プリンターセッションは
  対象外にする決定（D1）・ブラウザ直指定にも足す決定（D2）を decisions.md に記録済み。UI 文言は
  既存の hint/option の文体（です・ます調に近い指示文・句点なし）に合わせた。
  実資格情報・実機の識別子はコード・コメントに書いていない。
- **保守性**: `katakanaVariant` の通り道は既存の `ccsid` の配線をそのまま複製する設計に沿っており、
  読み手が「`ccsid` を見ればどこに何を足すか分かる」形になっている。
  `sesEffectiveCcsid`（セッションフォームの実効 CCSID）は新設の computed だが、既存の `isServer`
  等と同じ場所・同じ書き方に揃えた。

対応: S1 を `config-store.test.ts` に追記して解消（mutation で検出確認済み）。

## ラウンド 2（通過）

ラウンド 1 の指摘（should 1）を直した。全量テスト（合計 5294 passed / 0 failed / 3 skipped。
skip はこの work と無関係な既存分）・`npm run build`（root tsc -b・web-ui vue-tsc 込み）・
`npm run lint`・`aidev smoke` はすべて緑。指摘なし。
