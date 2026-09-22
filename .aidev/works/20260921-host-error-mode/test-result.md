# テスト結果: ホストのエラー（WRITE ERROR CODE）でも、ACS と同じくエラー状態に入る

## 実行したもの
- コア全テスト 725 passed・サーバー全テスト 1454 passed（3 skipped）・web-ui の関係 35 ファイル 541 passed
- 本 work のテスト: `packages/tn5250/test/system-message-lifetime.test.ts`（通し番号 3 件）・`packages/web-ui/test/host-error-mode.test.ts`（5 件）

## 受け入れ基準ごとの判定
- AC1: pass — WEC でエラー状態に入り文字を拒否する。挿入モードは上書きに戻る。同じ文言の 2 回目（番号が違う）でも入り直す。
  **実機**（ACS）: ULKPGM の RANGE に 9 → inhibit=5・文字 3 は拒否・挿入モードが解けた（research F2）。当 PJ のコアは
  WTD・WEC・READ を受けて `systemMessage` に本文を載せた（`verify-host-error.mjs`）。
- AC2: pass — 右矢印・Tab で抜けると最下行のメッセージが消える。同じ番号のまま画面が更新されても出さない。
- AC3: pass — mutation: H1 エラー状態に入らない→4 件 / H3 抜けても隠さない→3 件 / H4 文言で見分ける→3 件が落ちた。
  **H2（WEC で挿入モードを解かない）は生き残った**——画面が届くたびに上書きへ戻す既存の監視が同じ働きをするため（D3）。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザでの確認は未実施（jsdom）。WRITE ERROR CODE TO WINDOW（0x22）は実機で観測できていない（D1）。

## ラウンド 2（独立点検の指摘の対応後）

### 実行したもの
- `npm test`（全ワークスペース）— tn5250 726・server 1454（3 skipped）・web-ui 2267（1 件は旧挙動を固定していたテストを
  ACS の実測に合わせて書き換えた後に再実行して通過）ほか全部緑。`npm run lint`・root の `npm run build`・web-ui の
  `npm run build`（`vue-tsc` の test 込み）も通過
- 実機の ACS: `scripts/acs-probe/field-exit-full.txt`（場合 A〜H）・`scripts/acs-probe/window-error.txt`（挿入モードと Tab を足した分）

### 失敗の証跡

```
$ npm test   # 1 回目（web-ui）
 FAIL  test/field-keystroke-rules.test.ts > ScreenGrid: 打鍵 > 符号付き数値欄: 7 桁目（符号桁）に数字は入らない
AssertionError: expected [ Array(1) ] to include '符号桁には数字を入力できません（符号は - / + キーで入れます）'
 Tests  1 failed | 2266 passed (2267)
```
旧挙動（数字桁を埋めると符号桁へ出る）を固定していたテスト。ACS は最終の数字桁に留まって次の文字を 0018 にする
（実機で確認）ので、そのように書き換え、符号桁に直接カーソルを置いた場合の拒否は別のテストに分けた。

### 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

### 受け入れ基準ごとの判定（ラウンド 2）
- AC4: pass — タブを切り替えて戻る・裏のタブに届いてから切り替える・ペインを作り直す、のどれでも食い違わない。CLEAR UNIT で
  ホストのエラー（コアが捨てる）も操作員エラー（`lastWrite.cleared`）も抜ける。同じレコードの CLEAR UNIT＋WEC では入る。
- AC5: pass — エラー中の Field Exit・Erase EOF・Erase Input・Field−・Dup は欄を変えずエラーのまま。空白だけの WEC でも番号が付く。
- AC3: pass — mutation H-a〜H-f の 6 通りすべて検出（エラー判定をペインだけに戻す 12 件・CLEAR UNIT で抜けない 1 件・編集キーを
  通す 5 件・CLEAR UNIT でホストのエラーまで隠す 1 件・隠した番号をペインに持つ 1 件・空白の WEC を無視 1 件）。

### 未検証の穴
- 実ブラウザでの操作確認は未実施（jsdom）。SAVE SCREEN で操作員エラーを抜ける経路は未対応（スナップショットに印が無い）。
