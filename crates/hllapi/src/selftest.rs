//! **検査の実体。ここが唯一の場所。**
//!
//! 普通の環境では `cargo test` が `run()` を呼ぶ。
//! **テスト実行ファイルをリンクできない環境**（C コンパイラが無く `crt1.o` も無い等）では、
//! `selftest` フィーチャで C ABI の入口（`ts5250_hllapi_selftest`）が出て、
//! 共有ライブラリ経由で同じ `run()` を呼べる。
//!
//! こうしてあるのは、**「テストがあるが一度も走っていない」状態を作らない**ため。
//! 二重に書くと片方だけ直る事故が起きるので、実体は 1 つに保つ。

use crate::{b64, http, json, read_bytes, write_bytes, RC_PARAMETER_ERROR};
use std::ffi::{c_char, c_int};

/// 検査を全部走らせ、**失敗したものの名前**を返す（空なら全部通った）。
pub fn run() -> Vec<&'static str> {
    let mut bad = Vec::new();
    let mut check = |name: &'static str, ok: bool| {
        if !ok {
            bad.push(name);
        }
    };

    // ---- JSON: 書き出し ----
    check("escape:quote", json::escape("a\"b") == "\"a\\\"b\"");
    check("escape:backslash", json::escape("a\\b") == "\"a\\\\b\"");
    check("escape:newline", json::escape("a\nb") == "\"a\\nb\"");
    check("escape:tab", json::escape("a\tb") == "\"a\\tb\"");
    // 制御文字をそのまま出すと不正な JSON になる
    check("escape:control", json::escape("\u{01}") == "\"\\u0001\"");

    // ---- JSON: 往復（実際に通る経路と同じ形） ----
    let roundtrip = |s: &str| -> bool {
        let body = format!("{{\"rc\":0,\"data\":{}}}", json::escape(s));
        json::string_field(&body, "data").as_deref() == Some(s)
    };
    check("roundtrip:plain", roundtrip("HELLO WORLD"));
    check("roundtrip:quote", roundtrip("a\"b"));
    check("roundtrip:backslash", roundtrip("a\\b"));
    check("roundtrip:newline", roundtrip("line1\nline2"));
    check("roundtrip:control", roundtrip("\u{01}\u{02}"));
    // **画面に日本語が出た瞬間に壊れないこと**
    check("roundtrip:japanese", roundtrip("日本語のメッセージ"));
    check("roundtrip:fullwidth-space", roundtrip("全角　空白"));
    check("roundtrip:katakana", roundtrip("ｶﾀｶﾅ"));

    // ---- JSON: 読み取り ----
    check(
        "read:escaped-unicode",
        json::string_field("{\"data\":\"\\u65e5\\u672c\"}", "data").as_deref() == Some("日本"),
    );
    // 片割れだけ捨てると絵文字が黙って消える
    check(
        "read:surrogate-pair",
        json::string_field("{\"data\":\"\\ud83d\\ude00\"}", "data").as_deref() == Some("😀"),
    );
    check("read:number", json::number_field("{\"rc\":10}", "rc") == Some(10));
    check("read:negative", json::number_field("{\"n\":-1}", "n") == Some(-1));
    check("read:missing", json::string_field("{\"rc\":0}", "data").is_none());
    // 値の中の `"rc"` をキーと取り違えない
    check(
        "read:key-in-value",
        json::number_field("{\"data\":\"see \\\"rc\\\":99\",\"rc\":5}", "rc") == Some(5),
    );

    // ---- 要求の組み立て ----
    check(
        "request:basic",
        json::build_request(3, "QUJARQ==", 4, 0)
            == "{\"function\":3,\"dataB64\":\"QUJARQ==\",\"length\":4,\"pos\":0}",
    );

    // ---- base64（**バイト列を素通しする器**） ----
    check("b64:empty", b64::encode(&[]).is_empty());
    check("b64:one", b64::encode(&[0x41]) == "QQ==");
    check("b64:two", b64::encode(&[0x41, 0x42]) == "QUI=");
    check("b64:three", b64::encode(&[0x41, 0x42, 0x43]) == "QUJD");
    // **全バイト値の往復**（CP932 の 2 バイト目には 0x80 以上が来る）
    let all: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
    check("b64:roundtrip-all-bytes", b64::decode(&b64::encode(&all)).as_deref() == Some(&all[..]));
    // 日本語を CP932 にしたときの実際のバイト列（"日本" = 93 FA 96 7B）
    let ja = [0x93u8, 0xfa, 0x96, 0x7b];
    check("b64:roundtrip-cp932", b64::decode(&b64::encode(&ja)).as_deref() == Some(&ja[..]));
    // **壊れた入力は黙って途中まで返さない**
    check("b64:rejects-bad-length", b64::decode("QUJ").is_none());
    check("b64:rejects-bad-char", b64::decode("QU!D").is_none());
    check("b64:rejects-misplaced-pad", b64::decode("=QJD").is_none());

    // ---- URL の分解 ----
    check(
        "url:full",
        http::split_url("http://127.0.0.1:3400/api/hllapi")
            == Some(("127.0.0.1".to_string(), 3400, "/api/hllapi".to_string())),
    );
    check(
        "url:defaults",
        http::split_url("http://localhost") == Some(("localhost".to_string(), 80, "/".to_string())),
    );
    // TLS は張らない（同じ機の上を前提にしている）
    check("url:rejects-https", http::split_url("https://example.com/api").is_none());
    check("url:rejects-empty-host", http::split_url("http:///api").is_none());

    // ---- HTTP 応答から本文を取り出す ----
    check(
        "http:body",
        http::body_of("HTTP/1.1 200 OK\r\nX: y\r\n\r\n{\"rc\":0}").as_deref() == Some("{\"rc\":0}"),
    );
    check(
        "http:body-lf",
        http::body_of("HTTP/1.1 200 OK\nX: y\n\n{\"rc\":10}").as_deref() == Some("{\"rc\":10}"),
    );
    check("http:no-body", http::body_of("HTTP/1.1 500 Oops").is_none());

    // ---- バッファの読み書き（**バイト列。文字として解釈しない**） ----
    // ヌル終端に頼らない（途中にヌルが入りうる）
    let with_nul = b"AB\0CD";
    check("buffer:reads-by-length", unsafe {
        read_bytes(with_nul.as_ptr(), 5) == with_nul.to_vec()
    });
    check("buffer:null-is-empty", unsafe { read_bytes(std::ptr::null(), 10).is_empty() });
    check("buffer:zero-length-is-empty", unsafe {
        read_bytes(with_nul.as_ptr(), 0).is_empty()
    });
    // **0x80 以上のバイトもそのまま読む**（CP932 の 2 バイト目）
    let high = [0x93u8, 0xfa];
    check("buffer:reads-high-bytes", unsafe {
        read_bytes(high.as_ptr(), 2) == high.to_vec()
    });

    let mut buf = [0u8; 8];
    let truncated = unsafe { write_bytes(buf.as_mut_ptr() as *mut c_char, 8, b"HELLO") };
    check("buffer:writes", !truncated && &buf[..5] == b"HELLO");

    // **容量を超えて書かない**（超えたら切り詰めたと返す）
    let mut small = [0u8; 4];
    let truncated = unsafe { write_bytes(small.as_mut_ptr() as *mut c_char, 4, b"HELLO") };
    check("buffer:no-overflow", truncated && &small == b"HELL");

    check("buffer:null-write-reports", unsafe {
        write_bytes(std::ptr::null_mut(), 0, b"x") && !write_bytes(std::ptr::null_mut(), 0, b"")
    });

    // ---- ヌルポインタで落ちない ----
    let mut f: c_int = 1;
    let mut l: c_int = 0;
    let mut rc: c_int = 0;
    unsafe { crate::dispatch(&mut f, std::ptr::null_mut(), &mut l, std::ptr::null_mut()) };
    unsafe { crate::dispatch(std::ptr::null_mut(), std::ptr::null_mut(), &mut l, &mut rc) };
    check("null:function-is-parameter-error", rc == RC_PARAMETER_ERROR);
    rc = 0;
    unsafe { crate::dispatch(&mut f, std::ptr::null_mut(), std::ptr::null_mut(), &mut rc) };
    check("null:length-is-parameter-error", rc == RC_PARAMETER_ERROR);

    bad
}
