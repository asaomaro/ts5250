# 仕様: MSGW の検出と応答

## 概要

前作業のネットワーク印刷サーバー（`0xE003`）に `RETRIEVE_MESSAGE` / `ANSWER_MESSAGE` を足す。
新規ファイルは作らず、既存 `netprint-*` に追加する。

## 設計方針

### D1: 検証できないものを「検証済み」に見せない

research F3 のとおり **PUB400 では MSGW 状態を作れない**（writer を常駐させられない）。
要求/応答の形は正しいと確認できたが、メッセージが有る場合の解析は未検証。

→ **型ドキュメントに ⚠ で明示する**。「動くはず」を「動く」と書かない。

### D2: 応答はハンドル無しに呼べないようにする

`ANSWER_MESSAGE` は `RETRIEVE_MESSAGE` が返したハンドルを要る。
`SpoolMessage.handle` が無い状態で `answerMessage` を呼んだら `CONFIG_ERROR` にする。

### D3: 実装は残す

検証できないからといって捨てない。要求形が正しいことは分かっており、
権限のある環境では動く見込みで、次に必要になったとき調査をやり直さずに済む。

## 対象範囲

変更のみ（新規ファイルなし）:

- `spool/netprint-datastream.ts` — メッセージ属性 ID、`buildAttributeIdList`、`parseAttributeList`
- `spool/netprint-connection.ts` — `retrieveMessage` / `answerMessage`、`SpoolMessage` 型
- `index.ts` — 公開 API

## エラー処理

| 状況 | 扱い |
|---|---|
| メッセージが無い | `undefined` を返す（例外にしない）。`RET_SPLF_NO_MESSAGE` |
| ハンドル無しで応答 | `CONFIG_ERROR` |
| 権限不足 | ネットワーク印刷サーバーの戻りコードをそのまま `PROTOCOL_ERROR` に |
