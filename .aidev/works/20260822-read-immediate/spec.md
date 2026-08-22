# 仕様

## D1. 原典（GNU tn5250 `session.c`）

```c
static void tn5250_session_read_immediate(Tn5250Session* This) {
    old_opcode = This->read_opcode;
    This->read_opcode = CMD_READ_IMMEDIATE;
    tn5250_session_send_fields(This, 0);      // ← AID は 0
    This->read_opcode = old_opcode;
}

case CMD_READ_IMMEDIATE:
    if (tn5250_dbuffer_mdt(dbuffer)) {        // ← 画面単位の門番
        field = dbuffer->field_list;
        do { tn5250_session_send_field(...); field = field->next; }  // 欄ごとの MDT は見ない
        while (field != dbuffer->field_list);
    }
    break;
```

**backlog の要約は不正確だった**——「MDT の有無に関わらず全フィールド」ではなく、
**画面単位の MDT が門番**で、立っていなければ**欄を 1 つも送らない**。

`master_mdt` は「MDT の立った欄が 1 つでもあるか」と同値（`field.c` の
`tn5250_field_set_mdt` と同時に `tn5250_dbuffer_set_mdt` が呼ばれる）。

## D2. tn5250j との突き合わせ

tn5250j は **`0x72` を扱わず**、`0x83`（READ MDT IMMEDIATE ALT）だけを実装している。

**矛盾ではなく別のコマンド。** 名前どおり `0x83` は MDT の欄だけを送る（`sf.mdt` で絞る）。

**2 実装が一致する点**（＝実装してよい範囲）:

1. `masterMDT` が門番
2. 待たずに即送信
3. レコードの opcode は **PUT_GET**（tn5250j の `writeGDS(0, 3, …)`。
   tn5250(C) は NO_OP だが、当方の PUT_GET は実機で検証済みの経路なのでそちらに揃える）

## D3. `0x83` は入れない

2 実装で扱いが割れているうえ、tn5250j 側は**行・桁・AID の前置きを書いていない**
（同クラスの `sendAidKey` は書いている）。手落ちに見えるものを倣わない。警告に留める。

## D4. 実機の裏取りができないことを明記する

コード・試験・backlog の 3 か所に「**実機で届いたことは無い**」と書く。
2026-08-22 の census（20 画面 142 レコード）でも届いていない。
