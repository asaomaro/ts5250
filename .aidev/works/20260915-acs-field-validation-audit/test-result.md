# テスト結果: `field-validate.ts` を ACS の `Field5250` と突き合わせる

## 実行したもの

- `npm run lint`（`eslint .`、monorepo全体） — エラー・警告 0
- `npm run build`（`tsc -b && vue-tsc -b`、monorepo全体） — エラー 0
- `npm run test`（`--workspaces --if-present`、monorepo全体、CI と同一コマンド）
  - `@ts5250/tn5250`: 586 passed（`field-validate.test.ts` の既存テスト1件を
    新しい期待値に置き換えたのみで、テスト件数の増減は無い——`git stash` で
    確認したところ、本 work 適用前でも同じ 586 件だった）
  - `@ts5250/web-ui`: 2035 passed（無変更）
  - `@ts5250/tn3270`: 254 passed / 38 skipped（既存の環境依存skip、本work と無関係）
  - `@ts5250/vt`: 202 passed
  - `@ts5250/gen-tables`: 10 passed
  - 合計: 3087 passed（既存の環境依存skipのみ、本 work によるものではない）

## 受け入れ基準ごとの判定

- AC1（数値専用欄検証を ACS の `checkNumericOnlyChar()` と比較し対応方針を
  決める）: pass — 埋め込み空白を許容する方向で一致させた
  （`packages/tn5250/src/screen/field-validate.ts` の `numericOnly` ブロック）。
  修正前のコードに対して discrimination テストが実際に失敗すること
  （`git stash` で確認）、修正後は green であることを確認済み。
- AC2（数字のみ・英字専用・カタカナシフトの検証が ACS と一致していることを
  確認）: pass — `research.md` F1・F3〜F5 で確認済み。コードの変更は不要
  だった。
- AC3（比較過程・判断根拠の記録）: pass — `research.md` F1〜F6 に、
  デコンパイルしたコードの具体的な抜粋とともに記録済み。途中で発覚した
  F3 の書き写し誤り（NUL文字を空白と誤記）とその訂正過程も
  `decisions.md` D4 に記録済み。
- AC4（自己点検欄の実装可否の判断）: pass — `decisions.md` D2 で実装を
  見送ると判断し、理由（正確なFCW値が実機トレース無しでは確定できない、
  検証の粒度が異なる）を記録済み。`.aidev/backlog/acs-parity.md` への
  記録は deliver 工程（T4）で実施する。
- AC5（既存テストへの回帰が無いことを確認）: pass — `field-validate.ts` を
  対象にした5つの既存テストファイル（`field-validate.test.ts`,
  `field-validate-current.test.ts`, `field-digits-only.test.ts`,
  `signed-num-transmit.test.ts`, `field-ffw-bits.test.ts`）を実行し、
  合計55テスト全て green。

## 失敗の証跡

タスク単位点検（T1・T3）で、追加コメントと `research.md` F3 の引用コードとの
矛盾が2件独立に指摘され（いずれも `research.md` F3 のコード抜粋の書き写し
誤りに起因）、その場で修正した。テストの failed としては現れていない
（`review.md`「タスク点検ログ」参照）。このラウンドで実際にテストが red に
なった事例は、discrimination の確認過程（`git stash` による意図的な退行の
再現）のみで、実装ミスによる failed は無かった。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
{"level":40,"time":1789472650848,"msg":"AS400_SECRET_KEY not set: saved auto-signon passwords are disabled"}
{"level":30,"time":1789472650862,"host":"127.0.0.1","port":46281,"auth":false,"msg":"5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"}
smoke: /healthz ok, / が Web UI を返した (port 46281)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

この work は新しい入口（サブコマンド・オプション）を追加していないため、
`smokeCommands` の追加は不要。

## 未検証の穴（skip / 環境不足）

- **自己点検欄（モジュラス10/11）は実装を見送ったため、当然ながら検証も
  していない**（`decisions.md` D2）。実装する場合は、正確な FCW 値を実機で
  確認することから始める必要がある。
- この work は実機起動・ACS 実機のどちらも不要な、デコンパイル済みコードの
  静的な突き合わせに限定した——ACS の実際の見た目の挙動（UI層）は確認して
  いない（`requirements.md`「非機能要件」の通り、確認できていないことは
  確認済みと書いていない）。
