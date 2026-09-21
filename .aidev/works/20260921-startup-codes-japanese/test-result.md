# テスト結果: 起動応答で断られた理由を日本語で出す

## 実行したもの
- web-ui: `startup-rejection-ja.test.ts`（9 件）と、エラーの文言・繋ぎ直しに関わるテスト 10 ファイル 134 passed。`vue-tsc`（test 込み）通過。
- tn5250: `startup-record.test.ts` ほか起動応答のテスト 45 passed（意味と失敗のコードの一覧）。
- mutation 9 通り（`scratchpad/mut-sja.py`）: 8 通り検出。VT を開く経路の reject を戻す 1 通りは生き残った——VT には起動応答が無く `SESSION_REJECTED` が
  届かないうえ、それ以外のコードでは `openErrorText` が以前と同じ文言を返すので等価（下の証跡）。
- 実機（PUB400）: 記号の無い同じ装置名で 2 本目を開いて 8902 で断らせた（`scratchpad/reject-8902.mjs`）——文言は `session rejected (8902: Device not available.)（装置 <名前>）`、
  `startupRejectionText` と同じ正規表現でコード 8902 と装置名が拾えた。
- 全量は次の節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 形・プリンター・答え直しの最中の文言・表に無いコード・通知・開く前（表示とプリンター）。
- AC2: pass — 英語の表の意味と、両側の一覧。
- AC3: pass — 上の mutation（1 通りは等価）。

## 失敗の証跡

```
$ python3 mut-sja.py
SURVIVED 開く前の reject 2 番目を戻す :: 9 passed (9)
```
2 番目は `openVtSession`。VT は起動応答を持たないので `SESSION_REJECTED` が来ず、他のコードでは `openErrorText` は `${code}: ${message}` をそのまま返す（等価）。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- 画面（ランチャー）に出た文字は実ブラウザで見ていない（文言の形は実機、置き換えは単体）。8902 以外のコードは実機で起こしていない。
