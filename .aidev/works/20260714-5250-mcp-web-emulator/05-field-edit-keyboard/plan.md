# 計画: 05-field-edit-keyboard — web フィールド編集の忠実化・キーボード

親: 20260714-5250-mcp-web-emulator（04 decisions D4 で追加。分解のみ・再分割なし）
依存: 04-dbcs-tls-wide（review 承認済み）

## 実装方針

- web のフィールド編集を **native `<input>` の keydown 制御**方式で 5250 忠実化する（ユーザー選択）。
  `<input>` は残し、keydown を `preventDefault` して value・selection を自前管理する。caret 描画はブラウザ任せ。
  変更が小さく、IME・アクセシビリティ・Playwright 自動操作への影響を抑えられる。
- **コピー＆ペースト挙動に注意**: paste（複数文字挿入）・cut・native の選択削除でも上書き/型/バイト長の規則が
  破られないよう、`beforeinput`（insertFromPaste 等）と keydown の両方で検証・整形する。
- **Playwright への影響を検証**: `input.fill()` / `type()` / キー操作が新方式でも動くことを E2E で確認する
  （既存の verify-browser.mjs が壊れないこと＋上書きモードの新規検証）。
- カタカナ⇔英小文字の表示トグルは、**セルに生 EBCDIC バイトを保持**し、表示時に代替コードページ（US 037 の
  英小文字／Katakana 290 のカナ）で再解釈する。core の Cell に生バイトを持たせる小変更を伴う。

## 対象範囲（04 decisions D4）

1. web 自前フィールド編集: 上書きモード既定・Insert トグル・5250 流バックスペース・Delete・フィールド内カーソル
2. 入力検証の web 反映: 型（数値/A/O/J）・コードページ許容文字を入力時に拒否（core の validateFieldContent と整合）
3. DBCS バイト長の web 厳密化・入力中の桁維持
4. Insert/上書きモードの OIA 表示
5. キーバインド編集（localStorage・設定 UI・useKeymap 連動）
6. カタカナ⇔英小文字の表示トグル（生バイト保持＋代替解釈）

## リスク / 留意点

- **native input 制御の落とし穴**: keydown で全印字キーを捕捉すると IME（日本語変換）を壊す恐れ。
  composition 中は自前制御を無効化し、確定後に上書き規則を適用する（03 の composition ガードを踏襲）。
- **paste の整形**: 貼り付け文字列が型/バイト長違反や DBCS を含む場合の整形（切り詰め・拒否）を明確に。
- **Playwright**: 既存 E2E が `input.fill()` を使う。fill は value を直接セットするため keydown 制御を通らない可能性
  → E2E は `type()`/`press()` ベースの上書きモード検証を追加し、fill 依存を減らす。
- カタカナトグルは生バイト保持で core の Cell が肥大化しないよう SBCS のみ対象（DBCS は対象外）。

## テスト方針（protocol 2.8・この subtask の範囲）

- ユニット/コンポーネント: フィールド編集モデル（上書き/挿入/バックスペース/Delete/カーソル）、paste 整形、
  入力検証拒否、Insert トグル、キーバインドストア、カタカナ再解釈。
- Playwright: 上書きモードで途中入力しても後続桁がシフトしないこと、Insert トグル、バックスペース、
  型違反キーの拒否、コピペの整形、既存フローの非回帰。
- 実機は SBCS 操作の疎通確認まで。DBCS 入力中桁維持は合成/コンポーネントで検証。
- 受け入れ基準 13 項目の総点検は親の統合 test に委ねる。
