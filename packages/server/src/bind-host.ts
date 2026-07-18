/**
 * HTTP サーバーのバインド先を決める。
 *
 * 認証オフ（`--users` 無し）はコード全体で「**単一の信頼ユーザー**」を前提にしており、
 * `canEditProfiles` は全通過・`assertProfileAccess` も素通しになる。その状態を全インターフェースで
 * 公開すると、同一 LAN の誰でもサーバー設定を編集でき、`autoPdfDir` で任意パスへ書き込ませたり
 * `autoPrint` で `lp` を実行させたりできてしまう。
 *
 * よって**認証オフなら既定でループバックのみ**を待ち受ける。公開は明示操作（`--host`）を要求し、
 * それでも認証が無いままなら警告する（禁止はしない——リバースプロキシ配下等の正当な構成もあるため）。
 */
export interface BindDecision {
  /** 実際に listen するアドレス */
  host: string;
  /** 警告があれば理由（認証オフのまま外部公開しようとしている場合） */
  warn?: string;
}

/** ループバックか（IPv4 の 127.0.0.0/8・IPv6 の ::1・localhost） */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  return /^127\./.test(h);
}

/**
 * @param explicitHost `--host` で明示された値（未指定なら undefined）
 * @param authEnabled 認証が有効か（`--users` 指定時 true）
 */
export function resolveBindHost(explicitHost: string | undefined, authEnabled: boolean): BindDecision {
  if (explicitHost === undefined) {
    // 既定: 認証オフはループバックのみ。認証オンは従来どおり全インターフェース
    return { host: authEnabled ? "0.0.0.0" : "127.0.0.1" };
  }
  if (!authEnabled && !isLoopback(explicitHost)) {
    return {
      host: explicitHost,
      warn:
        `認証なしで ${explicitHost} を待ち受けます。` +
        "接続設定の編集・PDF 出力先の指定（サーバーへの書き込み）・自動印刷の実行が、" +
        "到達できる全員に開放されます。--users でユーザー認証を有効にすることを強く推奨します。"
    };
  }
  return { host: explicitHost };
}
