# タスク: PDF 自動蓄積・自動印刷の UI 設定

## 1. server（受理・露出）
- [x] T1: `profiles.ts` `PublicProfile` に `printer?`、`profileInputSchema` に `printer` を追加
- [x] T2: `buildProfile` を printer 反映（未指定=保持/空=クリア/値=置換）にし、`buildPrinter()` 正規化ヘルパを追加（依存: T1）
- [x] T3: `listPublic({ includeSignon })` を editor 時に `printer` も含めるよう拡張（依存: T1）

## 2. server テスト
- [x] T4: app-profiles: editor(auth-off/admin) の PUT で printer 保存・profiles.json 反映（依存: T2）
- [x] T5: 一般ユーザー PUT は 403、GET の printer 露出は editor のみ、printer 全空でブロック消去（依存: T3,T4）

## 3. web-ui（printer 出力欄）
- [x] T6: `ConnectView` `ConnForm` に printer 出力フィールド（autoPdfDir/autoPrint/pdfFontPath/pdfFontName/pageSize/fontSize）追加（依存: T1）
- [x] T7: プロファイル編集フォームに「PDF 自動蓄積 / 自動印刷（サーバー設定）」セクション＋注意書き（isProfileForm のみ）（依存: T6）
- [x] T8: `editProfile` プレフィル＋`saveProfileForm` で printer 組み立て（全空なら送らない＝クリア）（依存: T6）

## 4. web-ui（種別ラベル）
- [x] T9: 種別ラベル「表示」→「5250端末」に変更（カード/一覧 `.kind` チップ・`infoRows`・`SessionInfo`・フォーム option）＋チップ配色調整

## 5. 検証・ドキュメント
- [x] T10: README のサーバー側 PDF セクションに「UI からの設定（認証オフ/admin）」を追記
- [x] T11: `npm run build`（tsc）・`npm run build -w @as400web/web-ui`（vue-tsc+vite）・`npm test`・`npm run lint` が全て green
