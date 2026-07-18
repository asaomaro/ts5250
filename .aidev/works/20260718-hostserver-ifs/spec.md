# 仕様: IFS ファイルの読み書き

## 設計方針

### D1: 既存資産をそのまま使う
認証・ヘッダー・ソケットはすべて既存。新規は要求の組み立てと応答の解析のみ。

### D2: 応答は ReqRep ID で分岐する
research F3 のとおり、応答の構造は ReqRep ID で変わる。
**共通の「戻りコード」位置を仮定しない。**

### D3: 上限を設ける
終端が返らない異常時に無限ループへ入らないよう、1 ファイルの上限を設ける。

## 対象範囲

新規: `packages/core/src/hostserver/ifs/`
- `ifs-datastream.ts` — 要求の組み立てと応答の解析
- `ifs-connection.ts` — 接続と読み書き・削除

## インターフェース

```ts
export class IfsConnection {
  static connect(opts: IfsConnectOptions): Promise<IfsConnection>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, opts?: { create?: boolean }): Promise<void>;
  deleteFile(path: string): Promise<void>;
  close(): void;
}
```

## エラー処理

戻りコードを `fileErrorText()` で意味の分かる文言にして `PROTOCOL_ERROR` にする。
