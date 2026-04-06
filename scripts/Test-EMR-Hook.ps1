# EMR_COM_Hook_Test.ps1
# EMR 프로그램의 'Internet Explorer_Server' 컴포넌트에 접근 가능한지 (보안 막힘 여부) 테스트하는 스크립트

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class IEHook {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint RegisterWindowMessage(string lpString);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("oleacc.dll", PreserveSig = false)]
    [return: MarshalAs(UnmanagedType.Interface)]
    public static extern object ObjectFromLresult(IntPtr lResult, [MarshalAs(UnmanagedType.LPStruct)] Guid refiid, IntPtr wParam);
}
"@

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "EMR 인터넷 익스플로러 DOM 후킹 보안 테스트" -ForegroundColor Cyan
Write-Host "============================================="

$WM_HTML_GETOBJECT = [IEHook]::RegisterWindowMessage("WM_HTML_GETOBJECT")
$IID_IHTMLDocument = New-Object Guid("626FC520-A41E-11CE-828B-00AA004BA90B")

# 화면에 떠있는 모든 창 중에서 'Internet Explorer_Server'가 들어간 창 핸들을 재귀적으로 찾는 함수 (간이 버전)
# 실제 EMR에서는 부모 클래스 이름이나 정확한 창 구조를 알아야 하지만, 여기서는 일반적인 IE 창클래스를 타겟합니다.
# 주의: 이 스크립트는 테스트용이므로, 열려있는 다른 IE/도움말 창이 우선 잡힐 수 있습니다. EMR만 단독 실행 후 테스트를 권장합니다.

function Find-IEServerHwnd($hwndChildAfter = [IntPtr]::Zero) {
    return [IEHook]::FindWindowEx([IntPtr]::Zero, $hwndChildAfter, "Internet Explorer_Server", $null)
}

$ieServerHwnd = Find-IEServerHwnd
if ($ieServerHwnd -eq [IntPtr]::Zero) {
    Write-Host "[실패] 화면에서 Internet Explorer_Server 요소를 찾지 못했습니다." -ForegroundColor Red
    Write-Host "EMR 창의 구조가 일반적인 IE_Server 형태가 아니거나 닫혀있습니다."
    Exit
}

Write-Host "[성공] EMR 화면 요소 발견! (HWND: $ieServerHwnd)" -ForegroundColor Green
Write-Host "보안 프로그램 차단 여부를 테스트 중..." -ForegroundColor Yellow

$lRes = [IntPtr]::Zero
$smRes = [IEHook]::SendMessageTimeout($ieServerHwnd, $WM_HTML_GETOBJECT, [IntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$lRes)

if ($smRes -eq [IntPtr]::Zero -or $lRes -eq [IntPtr]::Zero) {
    Write-Host "[보안 차단됨] EMR에 메시지를 전송했으나 응답이 거부되었습니다." -ForegroundColor Red
    Write-Host "권한(UIPI) 문제이거나 병원 보안 프로그램이 API 후킹을 막고 있을 가능성이 큽니다."
    Write-Host "조치: 파워셸(또는 향후 프로그램)을 '관리자 권한'으로 실행해보시길 권장합니다."
} else {
    try {
        $htmlDoc = [IEHook]::ObjectFromLresult($lRes, $IID_IHTMLDocument, [IntPtr]::Zero)
        Write-Host "=============================================" -ForegroundColor Cyan
        Write-Host "[최종 성공] 보안을 뚫고 EMR 내부 HTML DOM 객체를 확보했습니다!!" -ForegroundColor Green
        Write-Host "EMR 안의 실제 페이지 Title: $($htmlDoc.title)" -ForegroundColor Yellow
        Write-Host "이제 Electron 프로그램에서 EMR 화면을 마음대로 제어(자동입력)할 수 있습니다." -ForegroundColor Green
        Write-Host "=============================================" -ForegroundColor Cyan
    } catch {
        Write-Host "[접근 실패] 객체는 얻었으나 권한 부족으로 DOM을 읽을 수 없습니다." -ForegroundColor Red
        Write-Host "에러: $_"
    }
}
Read-Host "엔터를 누르면 종료됩니다"
