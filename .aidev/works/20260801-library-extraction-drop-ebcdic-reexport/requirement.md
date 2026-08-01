# 要件: `@as400web/tn5250` の ebcdic 再輸出を撤去する

## 背景 / 課題

`.aidev/backlog/library-extraction.md` の **4b**（項目 4 / PR #237 の follow-up）。
これで「ライブラリ切り出し」の全項目が閉じる。

`packages/tn5250/src/index.ts` と `browser.ts` は `@as400web/ebcdic` の名前を
**24 個**再輸出している。#235 以降の方針「**使うものは在り処から取る**」に反しており、
`@as400web/tn5250` を「何でも入っている袋」に戻す入口になっている。

### 実測（2026-08-01）—— 24 個中 6 個しか使われていない

| 名前 | 利用者 | 本来の入口 |
|---|---|---|
| `TEXT_CCSIDS` / `ccsidLabel` | `web-ui/src/components/IfsPane.vue` | `@as400web/ebcdic/catalog`（**表ゼロ**） |
| `LineEnding` | `web-ui/src/ifsApi.ts` / `composables/usePreview.ts` | `@as400web/ebcdic/catalog` |
| `katakanaChar` / `latinChar` | `web-ui/src/components/ScreenGrid.vue` / `screenExport.ts` | `@as400web/ebcdic/katakana`（**SBCS 部のみ**） |
| `codecForCcsid` | `web-ui/test/host-code-pages.test.ts` | `@as400web/ebcdic/codec` |

**未使用の 18 個**: `SbcsCodec` / `DbcsCodec` / `Codec` / `SO` / `SI` / `SbcsTable` /
`StatefulTable` / `PureDbcsCodec` / `pureDbcsCodecForCcsid` / `isPureDbcsCcsid` /
`ibm300` / `ibm16684` / `canDecodeCcsid` / `canEncodeCcsid` / `decodeCcsidText` /
`encodeCcsidText` / `isEbcdicCcsid` / `CcsidText`。

利用者はすべて **web-ui**（server / tools は既に `@as400web/ebcdic` 直参照）。

### 最大の危険 —— 入口を間違えるとバンドルが膨らむ

使われている 6 個は**表を引き込まない狭い入口**から来ている。
web-ui の import 先を `@as400web/ebcdic`（バレル）にすると、
**変換表 18,900 行が丸ごとバンドルに入る**——#237 で `@as400web/scs` のバレルに向けて
**359,853 → 1,458,480 バイト**にした失敗を繰り返すことになる。

`@as400web/ebcdic/catalog` / `/katakana` を**そのまま指す**こと。

## 目的 / ゴール

`@as400web/tn5250` から ebcdic の再輸出を無くし、web-ui が実体の**狭い入口**から直接取る。

## スコープ

### 対象

- `packages/tn5250/src/index.ts` の ebcdic 再輸出 3 ブロック（計 24 名前）を削除
- `packages/tn5250/src/browser.ts` の ebcdic 再輸出（`catalog` / `katakana` 由来）を削除
- web-ui 6 ファイルの import を `@as400web/ebcdic/catalog` / `/katakana` / `/codec` へ
- `packages/web-ui/package.json` の `dependencies` に `@as400web/ebcdic` を追加
- `packages/tn5250/test/codec-reexport.test.ts` の作り直し
  （再輸出が無くなるので、**再輸出が復活していないこと**と**web-ui が狭い入口を使っていること**を検査する向きへ反転）

### 対象外

- `@as400web/tn5250` **内部**の `@as400web/ebcdic` 利用（`screen/` `protocol/` が使う。正当）
- `@as400web/base` の再輸出（`assertIdentifier` 等。base は「どれにも属さない」層で別軸）
- `@as400web/ebcdic` 側の変更
- 振る舞いの変更・publish

## 機能要件

- `@as400web/tn5250` を import しても EBCDIC の変換 API が付いてこない
- web-ui が CCSID 一覧・半角カナ表示・コードページ判定を従来どおり使える
- **web-ui の本番バンドルに変換表が入らない**（狭い入口を維持する）
- 振る舞いは一切変わらない

## 非機能要件 / 制約

- 型検査・lint・テストが monorepo 全体で従来どおり通る
- **web-ui の本番バンドルサイズを増やさない**（基準線 **359,857 バイト**）
- 逆向きの依存を作らない（`dependency-direction.test.ts` が検査）

## 完了条件 (受け入れ基準)

- [ ] `packages/tn5250/src` に `@as400web/ebcdic` からの **`export`** が 0 件
      （`import` は残ってよい＝内部利用は正当）
- [ ] `packages/web-ui/package.json` の `dependencies` に `@as400web/ebcdic` がある
- [ ] web-ui が `@as400web/ebcdic`（**バレル**）を import していない
      ——`/catalog` `/katakana` `/codec` の**狭い入口のみ**
- [ ] web-ui 本番バンドル JS が **359,857 バイト以下**
- [ ] バンドル内に `ibm-1399` / `ibm-37` / `ibm-273` の痕跡が 0 件
      （`ibm-930` / `ibm-939` の SBCS 部が各 1 件なのは従来どおり）
- [ ] `npm run build` / `npm run build -w @as400web/web-ui` が成功
- [ ] `npm test` が **270 files / 3,269 tests 以上**、失敗 0
- [ ] `npx eslint packages tools` が成功
- [ ] 再輸出を戻すと落ちるテストがある

## 未確定事項

- `codec-reexport.test.ts` の新しい名前と検査内容（spec で決める）
