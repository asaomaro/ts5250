//! ts5250 の **HLLAPI / EHLLAPI 接続層**。
//!
//! ## この層は薄い
//!
//! やることは 3 つだけ:
//!
//! 1. C ABI で渡された 4 つのポインタを読む
//! 2. JSON にして ts5250 サーバーへ HTTP で投げる
//! 3. 返ってきたものを呼び出し側のバッファへ書き戻す
//!
//! **機能番号が何を意味するかを、このクレートは一切知らない。**
//! 画面の解釈も、どの戻り値を返すかも、すべて TypeScript 側
//! （`packages/server/src/hllapi.ts`）が決める。
//!
//! こうしてある理由:
//!
//! - **対応機能を増やすのに、利用者がネイティブの部品を再ビルドしなくて済む。**
//!   HLLAPI 資産は Windows の DLL を動的リンクするので、そこを差し替えるのは重い。
//! - ロジックが 1 か所にまとまる（TypeScript 側にテストも集められる）。
//!
//! この不変条件は `tests/no_logic.rs` が**ソースを走査して固定**している。
//!
//! ## エントリポイント
//!
//! HLLAPI の署名は実装をまたいで共通（**4 引数すべてポインタ**）:
//!
//! ```c
//! void hllapi(int *function, char *data_string, int *length, int *return_code);
//! ```
//!
//! 名前だけが実装ごとに違う（Sun は `hllc`、IBM PCOMM の Windows 版は
//! `hllapi` / `HLLAPI` / `WinHLLAPI`）ので、**別名をまとめて出す**。
//!
//! 出典: SunLink SNA 3270 9.1 EHLLAPI Programmer's Manual（3.4 Function Parameters）。

mod b64;
mod http;
mod json;
#[cfg(any(test, feature = "selftest"))]
mod selftest;

use std::ffi::c_char;
use std::ffi::c_int;

/// パラメータの誤り（ヌルポインタ等）。
///
/// **ここだけは数値を持つ。** 呼び出し側のポインタが無効だとサーバーへ問い合わせようがなく、
/// 何かを返さないと HLLAPI の規約を満たせないため。値は規約の
/// `HRC_PARAMETER_ERROR`（`hllapi-types.ts` と一致）。
pub(crate) const RC_PARAMETER_ERROR: c_int = 2;
/// サーバーへ届かない／応答が壊れている。規約の `HRC_SYSTEM_ERROR`。
const RC_SYSTEM_ERROR: c_int = 9;
/// バッファに収まらず切り詰めた。規約の `HRC_DATA_ERROR`。
const RC_DATA_ERROR: c_int = 6;

/// バッファを `len` バイトだけ読む。
///
/// **ヌル終端に頼らない。** HLLAPI の `data_string` は長さで区切る規約で、
/// 途中にヌルが入りうる（画面の空きが埋まっていない場合など）。
/// **文字として解釈しない**——中身は CP932 のバイト列で、解釈はサーバー側の仕事。
///
/// # Safety
/// `data` は `len` バイト以上の読み取り可能な領域を指していること。
pub(crate) unsafe fn read_bytes(data: *const u8, len: usize) -> Vec<u8> {
    if data.is_null() || len == 0 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(data, len) }.to_vec()
}

/// 応答のバイト列を呼び出し側のバッファへ書き戻す。**`cap` を超えて書かない**。
///
/// 収まらなければ `true`（切り詰めた）を返す——呼び出し側が `rc=6` に落とす。
///
/// # Safety
/// `data` は `cap` バイト以上の書き込み可能な領域を指していること。
pub(crate) unsafe fn write_bytes(data: *mut c_char, cap: usize, value: &[u8]) -> bool {
    if data.is_null() || cap == 0 {
        return !value.is_empty();
    }
    let n = value.len().min(cap);
    unsafe { std::ptr::copy_nonoverlapping(value.as_ptr(), data as *mut u8, n) };
    // **ヌル終端は付けない**（長さで区切る規約。付けると 1 バイト分の情報が消える）
    value.len() > cap
}

/// HLLAPI の本体。名前つきの入口はすべてここへ来る。
///
/// # Safety
/// 4 つのポインタは有効な領域を指していること（ヌルは受け付けて `rc=2` を返す）。
pub(crate) unsafe fn dispatch(func: *mut c_int, data: *mut c_char, len: *mut c_int, rc: *mut c_int) {
    // **`rc` が無ければ何も返せない。** 落ちずに黙って戻るしかない
    if rc.is_null() {
        return;
    }
    if func.is_null() || len.is_null() {
        unsafe { *rc = RC_PARAMETER_ERROR };
        return;
    }

    let function = unsafe { *func };
    let length = unsafe { *len };
    // **`return_code` は入力では PS 位置を運ぶことがある**（HLLAPI の規約）。
    // 意味づけはサーバー側がするので、そのまま渡す
    let pos = unsafe { *rc };

    let cap = if length > 0 { length as usize } else { 0 };
    // **バイト列のまま運ぶ。** 文字として解釈すると全角の桁が崩れる（サーバー側の注記）
    let input = unsafe { read_bytes(data as *const u8, cap) };

    let body = json::build_request(function, &b64::encode(&input), length, pos);
    let Some(response) = http::post_json(&body) else {
        unsafe { *rc = RC_SYSTEM_ERROR };
        return;
    };
    let Some(server_rc) = json::number_field(&response, "rc") else {
        // 応答が壊れている
        unsafe { *rc = RC_SYSTEM_ERROR };
        return;
    };

    let mut result = server_rc as c_int;
    if let Some(encoded) = json::string_field(&response, "dataB64") {
        let Some(out) = b64::decode(&encoded) else {
            // 応答が壊れている
            unsafe { *rc = RC_SYSTEM_ERROR };
            return;
        };
        let truncated = unsafe { write_bytes(data, cap, &out) };
        // **切り詰めたことを黙らない。** ただしサーバーが既に誤りを返しているなら
        // そちらを優先する（上書きすると原因が消える）
        if truncated && result == 0 {
            result = RC_DATA_ERROR;
        }
        // **書き戻した長さは「実際にバッファへ入ったバイト数」**。
        // サーバーが言う長さをそのまま返すと、切り詰めたときに嘘になる
        // ——呼び出し側はその長さぶん読むので、埋まっていない領域を読むことになる
        unsafe { *len = out.len().min(cap) as c_int };
    }
    unsafe { *rc = result };
}

/// HLLAPI の標準エントリ（小文字）。
///
/// # 呼び出し規約に `extern "system"` を使う理由
///
/// **32 bit の Windows では `stdcall`、それ以外では `C`** になる。
/// WinHLLAPI と VB / VBA の `Declare` は既定が `stdcall` なので、`extern "C"`（cdecl）の
/// ままだと **32 bit Office からの呼び出しでスタックが壊れる**。64 bit では規約が 1 つしか
/// 無いので違いは出ず、Linux でも `C` と同じ——**どこでも正しくなる唯一の書き方**。
///
/// # Safety
/// 呼び出し規約は HLLAPI の標準に従う（4 引数すべてポインタ）。
#[unsafe(no_mangle)]
pub unsafe extern "system" fn hllapi(func: *mut c_int, data: *mut c_char, len: *mut c_int, rc: *mut c_int) {
    unsafe { dispatch(func, data, len, rc) }
}

/// 大文字の別名（実装によってはこちらを引く）。
///
/// # Safety
/// `hllapi` と同じ。
#[unsafe(no_mangle)]
#[allow(non_snake_case)]
pub unsafe extern "system" fn HLLAPI(func: *mut c_int, data: *mut c_char, len: *mut c_int, rc: *mut c_int) {
    unsafe { dispatch(func, data, len, rc) }
}

/// Windows の EHLLAPI が使う名前。
///
/// # Safety
/// `hllapi` と同じ。
#[unsafe(no_mangle)]
#[allow(non_snake_case)]
pub unsafe extern "system" fn WinHLLAPI(func: *mut c_int, data: *mut c_char, len: *mut c_int, rc: *mut c_int) {
    unsafe { dispatch(func, data, len, rc) }
}

/// Sun 系の名前。
///
/// # Safety
/// `hllapi` と同じ。
#[unsafe(no_mangle)]
pub unsafe extern "system" fn hllc(func: *mut c_int, data: *mut c_char, len: *mut c_int, rc: *mut c_int) {
    unsafe { dispatch(func, data, len, rc) }
}

/// 自己検査。**この環境ではテスト実行ファイルをリンクできない**（`crt1.o` が無い）ため、
/// 共有ライブラリ経由で検査を走らせる口を用意する。
///
/// 検査の中身は `#[cfg(test)]` のテストと**同じ関数**（`selftest::run`）なので、
/// 二重に書いていない。普通の環境では `cargo test` が同じものを実行する。
///
/// 戻り値は**失敗した検査の数**（0 なら全部通った）。
///
/// # Safety
/// 引数を取らないので安全だが、C ABI に合わせて `extern "C"`。
#[cfg(feature = "selftest")]
#[unsafe(no_mangle)]
pub extern "C" fn ts5250_hllapi_selftest() -> c_int {
    let failures = selftest::run();
    for f in &failures {
        eprintln!("selftest failed: {f}");
    }
    failures.len() as c_int
}

#[cfg(test)]
mod tests {
    /// **検査の実体は `selftest::run`**（環境によらず同じものを走らせる）
    #[test]
    fn selftest_passes() {
        let failures = super::selftest::run();
        assert!(failures.is_empty(), "{failures:?}");
    }
}
