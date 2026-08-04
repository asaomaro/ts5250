# タスク: 欄の指し方

- [x] T1: `Field.id`（`f<row>c<col>`）と一意性の検査
- [x] T2: `screen/search.ts` に桁位置・欄の関数を持ち上げ（依存: なし）
- [x] T3: 文字列検索と厳格モード（`AmbiguousMatchError`）（依存: T2）
- [x] T4: `hllapi-ps.ts` を再輸出に付け替え。呼び出し側は触らない（依存: T2）
- [x] T5: web-ui が `data-field` を出す（依存: T1）
- [x] T6: 実機で HLLAPI 33/33 と Playwright の id 指定を確認（依存: T4,T5）
