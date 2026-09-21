# テスト結果: 欄を出ないまま AID を押したら、送らずに操作員エラーにする（ACS の 0020）

## 実行したもの
- `cd packages/web-ui && npx vitest run test/aid-field-exit-required.test.ts` — 20 passed / 0 failed
- 送信・必須検査・ペイン・通知に関わる既存テスト（`sendKey|mandatory|updateScreen|EmulatorPane|opMessages` を含む
  55 ファイル）— 854 passed / 0 failed
- **全量（`npm test`）・lint・build は節目でまとめて回す**（利用者の指示）

## 受け入れ基準ごとの判定
- AC1: pass — RZ・符号付き数値・RB で Enter が送られず 0020 の文言が出る。F3・PageDown も止まる。
  エラー中は次の文字が入らない。キャレット位置（2）が変わらない。
- AC2: pass — Field Exit（複数欄・単独欄）・Tab→Shift+Tab・Erase Input（Ctrl+Backspace）・素の欄・未入力の RZ・
  自動 Enter の RZ・Help・Clear で送れる。欄の中の右矢印では止まる。エラーのあと Tab で抜ければ送れる。
- AC3: pass — `sendKey` を直接呼んでも止まり、エラー状態に入り、セッション側の通知は残らない。
  `updateScreen` で待ちが消える。
- AC4: pass — mutation 10 通りがすべて落ちた:
  M1 判定しない→8 件 / M2 待ちを付けない→9 / M3 カーソルが出ても外さない→2 / M4 Field Exit で外さない→1 /
  M5 Help・Clear も止める→2 / M6 新画面で捨てない→1 / M7 通知を移さない→3 / M8 カーソルを動かす→1 /
  M9 自動 Enter も対象→1 / M10 Erase Input で外さない→1。

## 失敗の証跡
テストを最初に書いたラウンドでは全件緑だったが、mutation で 2 通り（M4・M8）が生き残った:

```
M4 field-full で外さない
      Tests  19 passed (19)
M8 カーソルを動かす
      Tests  19 passed (19)
```

- M4: 単独欄で Field Exit すると、キャレットが欄の右端の外（境界）に着き、カーソル監視の側で待ちが外れていた。
  Field Exit **直後**（カーソル監視が走る前）に待ちが外れていることを見る形にした。
- M8: 同じ欄への `focusInput` はフォーカスイベントを出さず、キャレットを先頭へ戻すだけ。`activeElement` では
  見えないので、キャレット位置（`selectionStart`）を見る形にした。

Erase Input の場合を足した最初の形も、ScreenGrid を直接呼んでいてペインの経路を通らず落ちた:

```
 FAIL  test/aid-field-exit-required.test.ts > 送れる場合 > **Erase Input の後は送れる**（ACS は MDT ごと下ろすので 0020 の対象から外れる）
      Tests  1 failed | 19 passed (20)
```

既定の割り当て（Ctrl+Backspace）で押す形に直した。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- **実ブラウザでの操作確認は未実施**（jsdom のみ）。
- 符号付き数値の数字桁を満杯にしたとき（research F2 の場合 11）は ACS と違うまま（D4）。
