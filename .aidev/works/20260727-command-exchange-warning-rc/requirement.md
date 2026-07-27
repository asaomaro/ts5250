# 要件: コマンドサーバーの交換属性で「警告」の戻りコードを致命扱いしない

## 背景 / 課題

**他の実機環境**での不具合報告と修正差分を受領し、取り込む（Summary.pdf / Diff 1-3.pdf）。

### 事象

Web UI でジョブ一覧を取得すると
`command server exchange attributes failed (rc=0x106)` で失敗する。

### 原因

接続は signon サーバーで認証した後、コマンドサーバー（QZRCSRVS）に接続して
「交換属性」で言語設定（NLV）等をすり合わせる。本 PJ は既定で **NLV="2924"（英語）** を送る。

接続先に**英語 NLV が別途インストールされていない場合**（日本語がプライマリのシステムでは一般的）、
サーバーは `rc=0x106` を返す。これは

> 要求した NLV が未インストールのため、既定（プライマリ）NLV にフォールバックする

という**非致命的な警告**であり、本来は接続を続行できる。
しかし本 PJ の実装は `rc !== RC_OK` なら無条件に例外を投げていたため、接続自体が失敗していた。

コマンドサーバー接続は**ジョブ一覧に限らず、オブジェクト一覧・ユーザー一覧・CL 実行・
プログラム呼び出しで共有**されるため、これらも同様に落ちていた。

### 原典で確認した事実（AGENTS.md「原典を先に確認する」）

`git clone --depth 1 --sparse https://github.com/IBM/JTOpen.git` の
`archived/jtopenlite/com/ibm/jtopenlite/command/CommandConnection.java:166-178` を直読した。

```java
// We ignore the same return codes that JTOPEN ignores
if (rc != 0x0100 &&  // Limited user.
    rc != 0x0104 &&  // Invalid CCSID.
    rc != 0x0105 &&  // Invalid NLV, default to primary NLV:
    rc != 0x0106 &&  // NLV not installed, default to primary NLV
    rc != 0x0107 &&  // Error retrieving product information.  Can't validate NLV.
    rc != 0x0108 &&  // Error trying to add NLV library to system library list
    rc != 0 )
{
  throw DataStreamException.badReturnCode("commandExchangeAttributes", rc);
}
```

**受領した差分の内容と 6 件すべて一致**。推測ではなく原典に基づく変更であることを確認した。

## スコープ

### 対象
- `packages/core/src/hostserver/command/command-datastream.ts`
  警告扱いの戻りコード表と `CommandServerInfo.warning`、判定の分岐
- `packages/core/src/hostserver/command/command-connection.ts`
  警告発生時の `log.warn` 出力
- `packages/core/test/command-datastream.test.ts` 回帰テスト

### 対象外
- 送信する NLV の既定値（"2924"）の変更——**原典も既定を送って警告を受ける前提**であり、
  変えると別の環境で挙動が変わる
- signon サーバー側の戻りコード解釈
- コマンド実行（0x1002）・プログラム呼び出しの戻りコード解釈

## 機能要件

- 交換属性の応答で 0x0100 / 0x0104 / 0x0105 / 0x0106 / 0x0107 / 0x0108 を**警告として許容**し、
  接続を継続する
- 上記以外の未知の戻りコードは**従来どおりエラー**（安全側の挙動を維持）
- 警告が出た場合、**握りつぶさず `log.warn` に出す**
- 警告の内容を `CommandServerInfo.warning` で呼び出し側へ渡す（成功時は `undefined`）

## 完了条件

- [ ] `rc=0x0106` で例外にならず、`warning` に内容が入り、`ccsid` 等が従来どおり読める
- [ ] `rc=0x0100` も警告として許容される
- [ ] `rc=0` のとき `warning` は `undefined`
- [ ] 未知の戻りコード（例 0x1234）は**従来どおり例外**
- [ ] 警告時に `log.warn` が出る
- [ ] 修正前に落ちる回帰テストがある
- [ ] build / test / lint が通る
