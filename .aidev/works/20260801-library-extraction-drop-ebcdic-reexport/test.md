# 検証結果（test 工程・2026-08-01）

## 1. 受け入れ基準

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 1 | `tn5250/src` に `export … from "@as400web/ebcdic"` が 0 件 | **0 件**（`import` は内部利用として残る） | ✅ |
| 2 | web-ui の `dependencies` に `@as400web/ebcdic` | あり | ✅ |
| 3 | web-ui がバレルを import していない | **`/catalog` `/katakana` `/codec` のみ** | ✅ |
| 4 | web-ui バンドル JS ≤ 359,857 バイト | **359,857 バイト（完全一致）** | ✅ |
| 5 | バンドルに `ibm-1399` / `ibm-37` / `ibm-273` が 0 件 | **0 件**（`ibm-930` / `ibm-939` の SBCS 部は各 1 件＝従来どおり） | ✅ |
| 6 | `npm run build` / web-ui ビルド | 成功（modules 169 → 169） | ✅ |
| 7 | テストが 270 files / 3,269 tests 以上・失敗 0 | **270 / 3,271** | ✅ |
| 8 | `npx eslint packages tools` | 成功 | ✅ |
| 9 | 再輸出を戻すと落ちるテストがある | 下記 | ✅ |

## 2. 削除した再輸出

**24 名前中、使われていたのは 6 個だけ**だった。

| 名前 | 利用者 | 新しい入口 |
|---|---|---|
| `TEXT_CCSIDS` / `ccsidLabel` | `IfsPane.vue` | `@as400web/ebcdic/catalog` |
| `LineEnding` | `ifsApi.ts` / `usePreview.ts` | `@as400web/ebcdic/catalog` |
| `katakanaChar` / `latinChar` | `ScreenGrid.vue` / `screenExport.ts` | `@as400web/ebcdic/katakana` |
| `codecForCcsid` | `test/host-code-pages.test.ts` | `@as400web/ebcdic/codec` |

**未使用だった 18 個**: `SbcsCodec` / `DbcsCodec` / `Codec` / `SO` / `SI` / `SbcsTable` /
`StatefulTable` / `PureDbcsCodec` / `pureDbcsCodecForCcsid` / `isPureDbcsCcsid` / `ibm300` /
`ibm16684` / `canDecodeCcsid` / `canEncodeCcsid` / `decodeCcsidText` / `encodeCcsidText` /
`isEbcdicCcsid` / `CcsidText`。

## 3. テスト件数

| package | 着手前 | 着手後 |
|---|---|---|
| `@as400web/tn5250` | 47 / 413 | 47 / **415** |
| その他 7 パッケージ | 変化なし | 変化なし |
| **合計** | **270 / 3,269** | **270 / 3,271**（+2） |

+2 は `codec-reexport.test.ts`（4 件）→ `ebcdic-not-reexported.test.ts`（6 件）の差。
失敗 0。skip は `zip-writer.test.ts` の 4 件のみ（既知）。

## 4. ガードが実際に効くことの確認 —— **2 方向とも**

| 壊し方 | 結果 |
|---|---|
| `tn5250/src/index.ts` に `export { codecForCcsid } from "@as400web/ebcdic";` を戻した | **2 件 FAIL**（バレル到達／src 走査） |
| `web-ui/src/ifsApi.ts` の入口を `/catalog` → バレルに変えた | **FAIL**「バレルに向けると変換表が丸ごとバンドルに入る: `src/ifsApi.ts: @as400web/ebcdic`」 |

**2 つ目が本命**。バンドルサイズの実測は人が回すときにしか効かないので、
**入口の指定そのもの**を走査で固定した。

## 5. 未検証の穴

- **実機（IBM i）での動作確認は未実施。** import 元の付け替えと再輸出の削除のみで
  実装ロジックには触れていないが、半角カナ表示・CCSID 選択は web-ui の見た目に関わるので、
  機会があれば IFS プレビューと表示コード切替を目視したい
- `zip-writer.test.ts` の 4 件は `unzip` 未インストールのため skip のまま
- CI が無いため、上記はいずれも自動では埋まらない
