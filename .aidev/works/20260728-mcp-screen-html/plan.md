# 計画

## split 判定

**分割しない（1 PR）。** 変換関数・履歴バッファ・MCP ツールは 1 本の筋で、
途中でコミットしても価値が出ない。

## 実装順

1. `core/src/html/screen-html.ts` — 変換の本体（純関数）
2. `core/src/browser.ts` / `index.ts` — 再輸出
3. `core/test/screen-html.test.ts` — T1〜T7
4. `server/src/session-manager.ts` — 録画バッファ（`ScreenRecorder`）
5. `server/src/mcp-tools.ts` — 4 ツール追加
6. `server/test/…` — T8
7. ビルド・全テスト・lint

**1 → 3 を先に固める。** 変換が正しくないと、その上に載せるツールの検証が濁る。

## リスクと対処

| リスク | 対処 |
|---|---|
| 桁ズレ（忠実さの核） | 全角を必ず 2ch の箱に入れる（`isCertainWideGlyph` で分岐しない）。T3 で固定 |
| HTML 注入 | エスケープ関数を 1 つに集約し、テキストにも属性値にも同じものを通す。T2 で固定 |
| 外部リソース混入 | T5 が `http`/`//`/`url(`/`@import`/`src=` を機械的に検出 |
| 描画経路の二重化 | 単票と履歴が同じ `screenFigure()` を通す。T7 で「履歴版が単票の出力を含む」を固定 |
| 録画のリーク | `stop` と `close` の両方で `off`。T8 で購読解除を確認 |
| 秘密の記録 | `ScreenSnapshot` と AID キーのみ。`fields[].value` を記録も出力もしない |
