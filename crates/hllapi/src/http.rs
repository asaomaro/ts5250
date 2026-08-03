//! ts5250 サーバーへの同期 HTTP。**`std` だけで書く**。
//!
//! HLLAPI は同期 API——呼び出し側は `hllapi()` が返るまで止まる。
//! よってここもブロッキングでよく、**接続の使い回しもしない**（1 呼び出し 1 接続）。
//! 相手は localhost なので接続コストは小さく、**状態を持たない**ほうが
//! 「Rust に状態を置かない」という要件に忠実になる。
//!
//! TLS は張らない。**HLLAPI クライアントと ts5250 は同じ機の上**にいる前提で、
//! 既定の接続先も `127.0.0.1`。別の機を指したい場合は環境変数で上書きするが、
//! **その場合は経路を利用者が守ること**（`docs/HLLAPI.md` に明記）。

use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// 接続先。既定はサーバーの既定ポート（3400）。
const ENV_URL: &str = "TS5250_HLLAPI_URL";
/// 認証が有効なときの API トークン（`Authorization: Bearer`）。
const ENV_TOKEN: &str = "TS5250_API_TOKEN";
const DEFAULT_URL: &str = "http://127.0.0.1:3400/api/hllapi";

/// 応答を待つ上限。**サーバー側の Wait が最大 30 秒**なので、少し長く取る。
const TIMEOUT: Duration = Duration::from_secs(45);

/// `http://host:port/path` を分解する。**`https` は扱わない**（上の注記）。
pub(crate) fn split_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()?),
        None => (authority.to_string(), 80),
    };
    if host.is_empty() {
        return None;
    }
    Some((host, port, path.to_string()))
}

/// 応答本文（HTTP ヘッダを落としたもの）。届かなければ `None`。
///
/// **失敗の種類を区別しない**——呼び出し側は届かなければ一律で
/// `HRC_SYSTEM_ERROR` を返すので、ここで細かく分けても使い道が無い。
pub fn post_json(body: &str) -> Option<String> {
    let url = env::var(ENV_URL).unwrap_or_else(|_| DEFAULT_URL.to_string());
    let (host, port, path) = split_url(&url)?;
    let token = env::var(ENV_TOKEN).ok();

    let mut stream = TcpStream::connect((host.as_str(), port)).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;

    let auth = match &token {
        Some(t) => format!("Authorization: Bearer {t}\r\n"),
        None => String::new(),
    };
    let req = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {host}:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         {auth}\
         Connection: close\r\n\
         \r\n\
         {body}",
        len = body.len()
    );
    stream.write_all(req.as_bytes()).ok()?;
    stream.flush().ok()?;

    // `Connection: close` なので、相手が閉じるまで読めば全部届く
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8(raw).ok()?;
    body_of(&text)
}

/// HTTP 応答からヘッダを落として本文を返す。
///
/// **ステータス行は見ない。** サーバーは HLLAPI の失敗も `200` ＋ `rc` で返す設計なので、
/// 本文さえ読めればよい（`hllapi-routes.ts` の注記）。
pub fn body_of(response: &str) -> Option<String> {
    let at = response.find("\r\n\r\n").map(|i| i + 4).or_else(|| response.find("\n\n").map(|i| i + 2))?;
    Some(response[at..].to_string())
}
