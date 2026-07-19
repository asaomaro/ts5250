# 調査: MSGW の検出と応答

## 調査の問い

- Q1: `RETRIEVE_MESSAGE` / `ANSWER_MESSAGE` の要求形式は？
- Q2: PUB400 で MSGW 状態を作れるか？（`CHGWTR` とは別経路なら権限が足りるか）

## 判明した事実

### F1: 要求形式（原典から確定）

`RETRIEVE_MESSAGE`(0x0011):

```
コードポイント: スプール ID(0x0001) ＋ 属性 ID リスト(0x0007)
属性 ID リスト: 件数(2) ＋ 要素長(2、常に 2) ＋ [属性 ID(2)] × n
要求する属性: MSGID(0x0093) / MSGTEXT(0x0080) / MSGHELP(0x0081) /
              MSGTYPE(0x008E) / MSGREPLY(0x0082)
応答: 属性値(0x0008) ＋ メッセージハンドル(0x000D)
      メッセージが無ければ RET_SPLF_NO_MESSAGE(0x000E)
```

`ANSWER_MESSAGE`(0x0012): メッセージハンドル(0x000D) ＋ 応答文字列（属性 MSGREPLY）。
**ハンドルは `RETRIEVE_MESSAGE` の応答から得る**ため、取得なしに応答はできない。

### F2: API 経路は動作する（実機で確認）

既存の 3 件のスプールに対して `RETRIEVE_MESSAGE` を実行し、
**すべてで「メッセージなし」が正しく返った**（例外ではなく `RET_SPLF_NO_MESSAGE`）。

→ **要求/応答のバイト構成は妥当**。属性 ID リストの配置も正しい。

### F3【重要】PUB400 では MSGW 状態を作れない

MSGW を発生させるには writer が用紙交換等を尋ねる必要がある。試した結果:

| 試行 | 結果 |
|---|---|
| 特殊権限の確認 | **`*NONE`**（`QSYS2.USER_INFO`） |
| `STRPRTWTR DEV(PRT_TEST)` | `CPF3464 "Not authorized to output queue PRT_TEST in library QUSRSYS."` |
| `ENDWTR` / `CHGWTR` | `CPF3313 "Writer not active nor on job queue."` |
| **自分の OUTQ を作成**（`CRTOUTQ MYLIB/TESTQ`） | **成功** |
| 自分の OUTQ を指定して `STRPRTWTR` | **コマンドは成功するが writer が常駐しない** |
| 用紙タイプ不一致で誘発 | スプールは `READY` のまま。MSGW にならない |

**結論: PUB400 では MSGW を再現できない。**
以前のセッションで得た「権限上どうにもならない」という結論が、
`CHGWTR` とは別の経路からも裏付けられた。

> 収穫: **自分が所有する OUTQ を指定すれば `STRPRTWTR` の権限エラーは回避できる**
> （`CPF3464` が出ない）。ただし PRT_TEST は実体のある装置ではないため writer が続かない。
> 実装置を持つ環境なら、この方法で MSGW を作って検証できる可能性がある。

## 実現性 / リスク

**実装は可能。検証は環境に依存する。**

- 要求/応答の形が正しいことは F2 で確認済み
- ただし**実際に MSGW を取得・応答できるかは未検証**
- 権限のある環境では動く見込みだが、**保証はできない**

## spec への申し送り

- 実装は残す（要求形は正しく、次に必要になったとき調査をやり直さずに済む）
- **「未検証」であることを型ドキュメントと README に明示する**
- `ANSWER_MESSAGE` はハンドル無しでは呼べないよう型で縛る
- 実機の後片付けを忘れない（テスト中に作ったスプール・OUTQ は削除済み）
