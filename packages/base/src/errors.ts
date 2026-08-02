/**
 * 共通エラーコード（spec「エラー処理 / 異常系」。server が MCP/WS 形式へ変換する）。
 *
 * **各コードに「どういうときに使うか」を書く。** 意味が書かれていないコードには、
 * 呼び出し側が「近そうなもの」を選ぶ——実際に `CONNECT_FAILED` が
 * 「セッション上限」「設定ファイルが読めない」にまで広がっていた
 * （`20260729-connect-failed-semantics` research F1・F7）。
 *
 * 受け取った側が知りたいのは**誰が直せる問題か**なので、
 * 似ているコードとの**使い分け**まで書く。server の `statusOf`（`host-api.ts`）が
 * この意味に依存して HTTP ステータスを決めている。
 */
export type ErrorCode =
  /**
   * **IBM i へ繋げなかった**（ソケットが張れない・ポートマッパーが引けない・
   * ネゴシエーション中に閉じられた）。投げるのは各パッケージの `transport/` だけ
   * （`@ts5250/tn5250` の `tcp.ts`＝TN5250 側と、`@ts5250/hostserver` の
   * `host-connection.ts` / `ddm-transport.ts`＝ホストサーバー側。分割前は core の
   * `transport/` に同居していた）。`packages/server` からは 0 件——これは
   * `20260729-connect-failed-semantics` が走査で不変条件にしている。
   *
   * `describeSocketError()` の日本語説明はこのコードに紐づく。
   * **接続以外に使ってはならない**——「ホストが落ちている」の意味が薄まる。
   * 自分側の都合で断るなら `SESSION_LIMIT`、設定の不備なら `CONFIG_ERROR`。
   */
  | "CONNECT_FAILED"
  /** 接続はできたが 5250 のネゴシエーション（端末タイプ交換）が時間内に終わらなかった */
  | "NEGOTIATION_TIMEOUT"
  /** TLS の証明書を検証できなかった（既定は検証する。`rejectUnauthorized:false` は明示オプトイン） */
  | "TLS_CERT_INVALID"
  /** 開いていたセッションが閉じた（ホスト側の切断・こちらからの `disconnect`）。以後は使えない */
  | "SESSION_CLOSED"
  /** その id のセッションが無い（閉じたあと・別のプロセス・打ち間違い）。HTTP では 404 */
  | "SESSION_NOT_FOUND"
  /**
   * **ホストがセッションを拒否した**（プリンターの起動応答コード 8925 等）。
   * `SESSION_LIMIT` と違い、断ったのは**ホスト**——装置記述や権限を直す必要がある。
   */
  | "SESSION_REJECTED"
  /**
   * 同時に開けるセッションの上限に達した（`maxSessions`。既定 8）。
   *
   * **`CONNECT_FAILED` と分ける理由**: あちらは「IBM i へ繋げなかった」。こちらは
   * **繋ぎに行く前に自分側で断っている**のでホストの状態とは無関係。混ぜると
   * 「ホストが落ちている」と「席が空いていない」を受け取った側が区別できない。
   *
   * **`RESOURCE_BUSY` と分ける理由**: あちらはホスト上の対象（IFS のファイル等）が
   * 他に掴まれている状態。こちらは**こちらのサーバーの席**で、対処は
   * 「使っていないセッションを閉じる」。HTTP では 409（閉じれば通る）。
   */
  | "SESSION_LIMIT"
  /** 認証が必要なのに資格情報が無い（Cookie セッション・API トークンのいずれも無い） */
  | "UNAUTHENTICATED"
  /**
   * **こちらの認可**で拒否した（所有者でない・admin 専用のルート・信頼設定の編集不可）。
   * ホスト側の権限で拒否されたなら `ACCESS_DENIED`。
   */
  | "FORBIDDEN"
  /**
   * **設定・指定の不備**（利用者が直せる）。設定ファイルが読めない・スキーマ違反・
   * 古い書式・環境変数が未設定・接続先の指定が足りない、など。
   *
   * `CONNECT_FAILED` と分ける理由: ホストへ行く前の話で、**直す先はこちら側**。
   * HTTP では 400。
   */
  | "CONFIG_ERROR"
  /** 保護フィールドへ書こうとした（ホストが入力を許していない欄） */
  | "FIELD_PROTECTED"
  /** フィールドの長さを超える値を書こうとした */
  | "FIELD_OVERFLOW"
  /** フィールドのシフト種別・DBCS 種別・コードページに合わない文字（`field-validate.ts`） */
  | "FIELD_TYPE"
  /** 指定した index / 座標にフィールドが無い */
  | "FIELD_NOT_FOUND"
  /** キーボード入力がロックされている（ホストの応答待ち・入力禁止状態） */
  | "KEYBOARD_LOCKED"
  /** 閲覧専用セッションで、書き込みや `PageUp`/`PageDown` 以外の AID を送ろうとした */
  | "READ_ONLY_SESSION"
  /**
   * **ホストとのやり取りが仕様どおりでない**（未知のオーダー・壊れたレコード・
   * 応答形式の不一致）。HTTP では 502＝**上流の障害**として扱われる。
   *
   * 利用者が直せる問題に使ってはならない。区別できるコードがあるならそちらを使う
   * （`NOT_FOUND` / `NOT_EMPTY` の JSDoc も同じ理由でそう書いてある）。
   */
  | "PROTOCOL_ERROR"
  /** ホストサーバーが要求する機能が未実装（例: DES ベースのパスワードレベル） */
  | "HOST_SERVER_UNSUPPORTED"
  /**
   * **利用者が指定したデータ**（表の列型・CCSID など）が対応範囲外。
   *
   * `HOST_SERVER_UNSUPPORTED` と分けている理由: あちらは「ホストが要求する機能を
   * こちらが実装していない」（利用者には直せない）。こちらは**対象を変えれば直る**。
   * 同じコードにすると、直せない問題を直せるかのように案内してしまう。
   */
  | "UNSUPPORTED_TYPE"
  /** SQL の実行エラー（構文誤り・存在しない表・権限不足など） */
  | "SQL_ERROR"
  /** CL コマンドの実行失敗（メッセージ付き） */
  | "COMMAND_FAILED"
  /**
   * 指定された対象が存在しない（IFS のパスなど）。
   *
   * `SESSION_NOT_FOUND` / `FIELD_NOT_FOUND` と同じく**区別できるコードを持つ**方針。
   * まとめて `PROTOCOL_ERROR` にすると server 側で 502 に落ち、
   * 「ホストが落ちている」と「指定が間違っている」を呼び出し側が区別できなくなる。
   */
  | "NOT_FOUND"
  /** 対象への権限が無い（IFS の rc=13 など）。ホスト側の権限であって、こちらの認可ではない */
  | "ACCESS_DENIED"
  /** 作ろうとした対象が既にある（IFS の mkdir で rc=4 など） */
  | "ALREADY_EXISTS"
  /**
   * 他が対象を掴んでいて今は操作できない（IFS の rc=1 使用中 / 32 共有違反 / 33 ロック違反）。
   *
   * `ACCESS_DENIED` と分けている理由: あちらは**権限**の問題で、待っても変わらない。
   * こちらは**時間**の問題で、待てば通りうる。同じにすると案内が変わってしまう。
   */
  | "RESOURCE_BUSY"
  /**
   * 中身が残っているので消せない（IFS の rmdir で rc=9）。
   *
   * `PROTOCOL_ERROR` に落とさない理由: server の `statusOf` が 502（ホストが落ちている）に写像するため、
   * 「フォルダが空ではありません」という**利用者が対処できる状況**が障害として伝わってしまう。
   */
  | "NOT_EMPTY";

/**
 * このライブラリが投げる共通エラー。
 *
 * 名前が `As400Error` なのは、**TN5250 だけを扱う層ではなくなったため**。
 * ホストサーバー（SQL・コマンド・スプール・IFS）は 5250 の端末プロトコルとは別物で、
 * それらが `Tn5250Error` を投げるのは名が体を表していなかった。
 */
export class As400Error extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "As400Error";
  }
}

/**
 * 旧名の互換シム。**外部利用者のコードを壊さないためだけに残している**——
 * 同一クラスなので `instanceof` は新旧どちらでも通る。
 * このリポジトリ内の新しいコードでは `As400Error` を使うこと（新旧の混在を意図していない）。
 */
export { As400Error as Tn5250Error };

/**
 * OS のソケットエラーコードを、原因の見当がつく日本語にする。
 *
 * `EHOSTUNREACH` のような文字列だけでは、利用者は「自分の設定が悪いのか、
 * 相手が落ちているのか」を判断できない。**次に何を確かめればよいか**まで書く。
 *
 * 未知のコードは undefined を返す（元のメッセージだけを見せる。嘘の説明を足さない）。
 */
export function describeSocketError(code: string | undefined): string | undefined {
  switch (code) {
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "接続先へ到達できません。ホストが停止しているか、経路が遮断されています";
    case "ETIMEDOUT":
      return "応答がありません。ホスト名・ポート番号と、ファイアウォールの許可を確認してください";
    case "ECONNREFUSED":
      return "接続を拒否されました。そのポートでサーバーが動いていない可能性があります";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "ホスト名を解決できません。名前の綴りと DNS の設定を確認してください";
    case "ECONNRESET":
      return "接続が切断されました。TLS の要否（平文ポートに TLS で繋いでいないか）を確認してください";
    case "EPIPE":
      return "接続が閉じられました";
    default:
      return undefined;
  }
}

/** ソケットエラーに説明を添える。未知のコードなら元の文言のまま */
export function withSocketHint(message: string, code: string | undefined): string {
  const hint = describeSocketError(code);
  return hint ? `${message} — ${hint}` : message;
}
