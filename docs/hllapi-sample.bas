Attribute VB_Name = "Ts5250Hllapi"
'==============================================================================
' ts5250 HLLAPI サンプル（Excel VBA / VB6）
'
' VBE で 「ファイル」→「ファイルのインポート」からこのファイルを読み込む。
' あるいは crates\hllapi\tools\make-xlsm.ps1 が組み込んだ .xlsm を使う。
'
' ■ 事前に必要なもの
'   1. ts5250 サーバーが動いていること
'   2. **5250 セッションが開いていること**（HLLAPI の Connect はセッションを開かない）
'   3. ts5250hllapi.dll が下記 DLL_PATH の場所にあること
'
' ■ 32bit / 64bit
'   DLL のビット数と Office のビット数を合わせること。合っていないと
'   「指定されたモジュールが見つかりません」になる（パスの問題ではない）。
'   呼び出し規約は DLL 側が extern "system"（32bit では stdcall）なので、
'   VBA の Declare（既定 stdcall）とそのまま合う。
'
' ■ 他の HLLAPI 実装（PCOMM / 旧 iSeries Access）と比べるとき
'   下の Declare の Lib を相手の DLL 名に変えれば、**同じコードが動く**。
'     PCOMM              → "pcshll32.dll"（または "ehlapi32.dll"）
'     iSeries Access(旧) → PC5250 の EHLLAPI
'   どれが入っているかは crates\hllapi\tools\find-hllapi.ps1 が実際に調べる（記憶で決めない）。
'   ACS 本体（Java 版）は HLLAPI を持たない。
'
'   ただし **Connect の第 2 引数（セッション指定）は ts5250 独自**。
'   他の実装へ投げると短縮名として解釈されず失敗する。
'   両方で動かすなら Connect("A") と書くこと（標準どおりの動作になる）。
'
' ■ 文字コード
'   画面は **CP932（Shift-JIS）** で入出力する。1 桁 = 1 バイト、全角は 2 バイト。
'   24x80 の画面はちょうど 1920 バイトなので Space$(1920) の器に収まる。
'   VBA の Declare は ByVal String を自動で ANSI（日本語 Windows では CP932）へ
'   変換して渡し、戻りで書き戻すので、**変換コードを書く必要は無い**。
'==============================================================================
Option Explicit

' DLL の場所。フルパスにしておくのが確実（カレントに依存しない）
Private Const DLL_PATH As String = "C:\ts5250\ts5250hllapi.dll"

'------------------------------------------------------------------ 宣言
' 4 引数すべてポインタ。data だけ ByVal（VBA が ANSI バッファのポインタを渡す）
#If VBA7 Then
Private Declare PtrSafe Sub hllapi Lib "C:\ts5250\ts5250hllapi.dll" ( _
    ByRef func As Long, ByVal dataStr As String, ByRef length As Long, ByRef retCode As Long)
Private Declare PtrSafe Function SetEnvironmentVariableW Lib "kernel32" ( _
    ByVal lpName As LongPtr, ByVal lpValue As LongPtr) As Long
#Else
Private Declare Sub hllapi Lib "C:\ts5250\ts5250hllapi.dll" ( _
    ByRef func As Long, ByVal dataStr As String, ByRef length As Long, ByRef retCode As Long)
Private Declare Function SetEnvironmentVariableW Lib "kernel32" ( _
    ByVal lpName As Long, ByVal lpValue As Long) As Long
#End If

'------------------------------------------------------------------ 機能番号
Public Enum HllFunc
    hfConnect = 1
    hfDisconnect = 2
    hfSendKey = 3
    hfWait = 4
    hfCopyPS = 5
    hfSearchPS = 6
    hfQueryCursor = 7
    hfCopyPSToStr = 8
    hfQuerySessions = 10
    hfReserve = 11
    hfRelease = 12
    hfCopyStrToPS = 15
    hfPause = 18
    hfQuerySystem = 20
    hfSearchField = 30
    hfFindFieldPos = 31
    hfFindFieldLen = 32
    hfCopyStrToField = 33
    hfCopyFieldToStr = 34
    hfSetCursor = 40
End Enum

'------------------------------------------------------------------ 接続先
' ts5250 が別の機で動いているときに呼ぶ。**先に呼ぶこと**（DLL は毎回読み直す）。
' VBA の Environ() は起動時のコピーなので使えない。kernel32 を直に叩く。
Public Sub SetServer(ByVal url As String, Optional ByVal token As String = "")
    SetEnvironmentVariableW StrPtr("TS5250_HLLAPI_URL"), StrPtr(url)
    If Len(token) > 0 Then
        SetEnvironmentVariableW StrPtr("TS5250_API_TOKEN"), StrPtr(token)
    End If
End Sub

'------------------------------------------------------------------ 基本呼び出し
' rc を返す。buf は呼び出し前に必要な大きさへ広げておくこと（戻りはここに入る）。
Public Function Call5250(ByVal fn As HllFunc, ByRef buf As String, _
                         Optional ByVal length As Long = -1, _
                         Optional ByVal pos As Long = 0) As Long
    Dim f As Long, l As Long, r As Long
    f = fn
    If length < 0 Then l = Len(buf) Else l = length
    r = pos                       ' HLLAPI は入力時の retCode が位置を運ぶ機能がある
    hllapi f, buf, l, r
    Call5250 = r
End Function

'------------------------------------------------------------------ 便利ラッパ
' どのシステムのどのセッションかを指定して繋ぐ。
'   target を省くと「開いている順に A、B…」（従来の HLLAPI と同じ）
'   target には ts5250 のセッション名 / 設定参照 / セッション id が書ける
' 当たらなければ rc=1、同名が 2 つ開いていれば rc=11 で**繋がない**。
Public Function Connect(Optional ByVal psName As String = "A", _
                        Optional ByVal target As String = "") As Long
    Dim buf As String
    If Len(target) = 0 Then buf = psName Else buf = psName & " " & target
    buf = buf & Space$(128 - Len(buf))       ' 固定長で渡す（DLL は NUL/空白まで）
    Connect = Call5250(hfConnect, buf)
End Function

Public Function Disconnect(Optional ByVal psName As String = "A") As Long
    Dim buf As String
    buf = psName
    Disconnect = Call5250(hfDisconnect, buf, 1)
End Function

' 画面を丸ごと取る。戻りは 1920 バイト（24x80）の固定長。改行は入らない。
Public Function CopyScreen(Optional ByVal rows As Long = 24, _
                           Optional ByVal cols As Long = 80) As String
    Dim buf As String, rc As Long
    buf = Space$(rows * cols)
    rc = Call5250(hfCopyPS, buf)
    If rc <> 0 Then Err.Raise vbObjectError + 1, , "Copy PS が失敗しました rc=" & rc
    CopyScreen = buf
End Function

' 画面の n 行目を取り出す（1 起点）。CP932 は 1 桁 1 バイトなので Mid で切れる
Public Function ScreenLine(ByVal screen As String, ByVal row As Long, _
                           Optional ByVal cols As Long = 80) As String
    ScreenLine = Mid$(screen, (row - 1) * cols + 1, cols)
End Function

' キーを送る。"@E"=Enter "@1".."@9"=F1..F9 "@a".."@o"=F10..F24 "@T"=Tab
' 普通の文字はそのまま入力される（"ABC@E" = ABC と打って Enter）
Public Function SendKeys5250(ByVal mnemonics As String) As Long
    Dim buf As String
    buf = mnemonics
    SendKeys5250 = Call5250(hfSendKey, buf, Len(buf))
End Function

' キーボードのロックが解けるまで待つ（最大 30 秒）。rc=4 は時間切れ
Public Function WaitReady() As Long
    Dim buf As String
    buf = Space$(8)
    WaitReady = Call5250(hfWait, buf)
End Function

' 文字列を探す。見つかった位置（1 起点）を返す。見つからなければ 0
Public Function Search(ByVal needle As String) As Long
    Dim buf As String, rc As Long
    buf = needle
    rc = Call5250(hfSearchPS, buf, Len(buf), 1)
    If rc = 7 Then Search = 0 Else Search = rc
End Function

' カーソルを置く（1 起点の通し番号）
Public Function SetCursorPos(ByVal pos As Long) As Long
    Dim buf As String
    buf = Space$(8)
    SetCursorPos = Call5250(hfSetCursor, buf, 0, pos)
End Function

' カーソル位置の入力欄へ書く
Public Function WriteField(ByVal text As String) As Long
    Dim buf As String
    buf = text
    WriteField = Call5250(hfCopyStrToField, buf, Len(buf))
End Function

' **自動操作の間、人間の入力を締め出す。** 必ず Release と対で使うこと
Public Function Reserve() As Long
    Dim buf As String
    buf = Space$(8)
    Reserve = Call5250(hfReserve, buf)
End Function

Public Function Release() As Long
    Dim buf As String
    buf = Space$(8)
    Release = Call5250(hfRelease, buf)
End Function

' 開いているセッションの一覧（Connect の target に書ける名前が出る）
Public Function QuerySessions() As String
    Dim buf As String
    buf = Space$(512)
    Call5250 hfQuerySessions, buf
    QuerySessions = Trim$(buf)
End Function

'==============================================================================
' 使用例
'==============================================================================

' 開いているセッションを調べる。**まずこれを実行して名前を確かめる**
Public Sub 例0_セッション一覧()
    MsgBox QuerySessions(), vbInformation, "開いているセッション"
End Sub

' 画面をシートへ写す
Public Sub 例1_画面をシートへ写す()
    Dim rc As Long, s As String, i As Long
    rc = Connect("A", "検証")          ' ← ts5250 のセッション名に変える
    If rc <> 0 Then MsgBox "Connect 失敗 rc=" & rc & vbCrLf & QuerySessions(): Exit Sub

    s = CopyScreen()
    With ActiveSheet
        .Cells.Clear
        For i = 1 To 24
            .Cells(i, 1).Value = "'" & ScreenLine(s, i)
        Next
        .Columns(1).Font.Name = "MS Gothic"
    End With
    Disconnect
End Sub

' **サインオンして、メニューまで進む。**
' 予約で囲うのが要点——囲まないと、人がブラウザで打ちかけている最中に画面が変わる
Public Sub 例2_サインオンする()
    Dim rc As Long, s As String

    rc = Connect("A", "検証")          ' ← セッション名
    If rc <> 0 Then MsgBox "Connect 失敗 rc=" & rc: Exit Sub

    rc = Reserve()
    If rc <> 0 Then MsgBox "他の自動化が使用中です rc=" & rc: Exit Sub

    On Error GoTo Cleanup              ' **途中で落ちても必ず Release する**

    If Search("サイン・オン") = 0 Then
        MsgBox "サインオン画面ではありません"
        GoTo Cleanup
    End If

    ' ユーザー欄へ移ってから打つ（画面によって位置が違うので Search で当てる）
    SendKeys5250 "MYUSER" & "@T" & "MYPASS" & "@E"
    WaitReady

    s = CopyScreen()
    MsgBox ScreenLine(s, 1) & vbCrLf & ScreenLine(s, 24), vbInformation, "結果"

Cleanup:
    Release
    Disconnect
    If Err.Number <> 0 Then MsgBox "エラー: " & Err.Description, vbCritical
End Sub

' 別の機のサーバーを使う場合
Public Sub 例3_リモートのサーバーを使う()
    SetServer "http://ts5250-server:3400/api/hllapi", "（API トークン）"
    MsgBox QuerySessions(), vbInformation, "リモート"
End Sub
