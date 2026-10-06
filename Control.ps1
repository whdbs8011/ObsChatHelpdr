param([ValidateSet('Setup','Uninstall','ObsStart','Start','Stop','Open')][string]$Action = 'Setup')
$ErrorActionPreference = 'Stop'
$dockRoot = $PSScriptRoot
$dockNode = Join-Path $dockRoot 'runtime\node.exe'
$dockServer = Join-Path $dockRoot 'server.mjs'
$dockStartup = [Environment]::GetFolderPath('Startup')
$dockShortcut = Join-Path $dockStartup 'Stream Dock.lnk'
function Test-DockRunning {
  $dockResponse = $null
  $dockReader = $null
  try {
    # Probe IPv4 directly; Windows PowerShell may stall resolving localhost via IPv6/proxy.
    # Preserve the Host value required by the local server's request guard.
    $dockRequest = [Net.HttpWebRequest]::Create('http://127.0.0.1:18765/api/status')
    $dockRequest.Host = 'localhost:18765'
    $dockRequest.Proxy = $null
    $dockRequest.Timeout = 1500
    $dockRequest.ReadWriteTimeout = 1500
    $dockRequest.KeepAlive = $false
    $dockResponse = $dockRequest.GetResponse()
    $dockReader = New-Object IO.StreamReader($dockResponse.GetResponseStream())
    $dockReply = $dockReader.ReadToEnd() | ConvertFrom-Json
    return ($null -ne $dockReply.loggedIn -and $dockReply.brokerMode -eq $true)
  } catch { return $false }
  finally {
    if ($dockReader) { $dockReader.Dispose() }
    if ($dockResponse) { $dockResponse.Dispose() }
  }
}
function Start-Dock {
  if (Test-DockRunning) { return }
  if (!(Test-Path -LiteralPath $dockNode) -or !(Test-Path -LiteralPath $dockServer)) { throw 'Stream Dock runtime or server is missing. Extract the entire ZIP first.' }
  Start-Process -FilePath $dockNode -ArgumentList ('"' + $dockServer + '"') -WorkingDirectory $dockRoot -WindowStyle Hidden | Out-Null
}
function Open-Dock {
  Start-Dock
  for ($dockAttempt = 0; $dockAttempt -lt 20; $dockAttempt++) {
    if (Test-DockRunning) { Start-Process 'http://localhost:18765/'; return }
    Start-Sleep -Milliseconds 500
  }
  throw 'Stream Dock did not start. Close an older version using port 18765 and try again.'
}
try {
switch ($Action) {
  'ObsStart' {
    if (Test-Path -LiteralPath $dockShortcut) {
      $dockShell = New-Object -ComObject WScript.Shell
      $dockLink = $dockShell.CreateShortcut($dockShortcut)
      if ($dockLink.Arguments -eq ('"' + (Join-Path $dockRoot 'Run.vbs') + '" Start')) { Remove-Item -LiteralPath $dockShortcut -Force }
    }
    Start-Dock
  }
  'Setup' {
    Open-Dock
    $dockMarker = Join-Path $dockRoot '.local\setup-complete'
    if (!(Test-Path -LiteralPath $dockMarker)) {
      Set-Clipboard -Value 'http://localhost:18765/'
      $dockPopup = New-Object -ComObject WScript.Shell
      $dockPopup.Popup("서버가 시작되었습니다. OBS 자동 실행은 스크립트를 등록하세요.`n`nOBS → 독 → 사용자 지정 브라우저 독`n주소: http://localhost:18765/`n주소를 클립보드에 복사했습니다. 붙여넣기 하세요.`n`n열린 화면에서 치지직 로그인만 하면 됩니다.`nOBS → 도구 → 스크립트 → + 에서 Stream-Dock-OBS.lua를 등록하세요.", 0, 'Stream Dock', 64) | Out-Null
      New-Item -ItemType Directory -Path (Split-Path $dockMarker) -Force | Out-Null
      Set-Content -LiteralPath $dockMarker -Value '1'
    }
  }
  'Uninstall' {
    if (Test-Path -LiteralPath $dockShortcut) {
      $dockShell = New-Object -ComObject WScript.Shell
      $dockLink = $dockShell.CreateShortcut($dockShortcut)
      if ($dockLink.Arguments -ne ('"' + (Join-Path $dockRoot 'Run.vbs') + '" Start')) { throw 'This shortcut belongs to another Stream Dock folder.' }
      Remove-Item -LiteralPath $dockShortcut -Force
    }
    Write-Output 'Autostart disabled.'
  }
  'Start' { Start-Dock }
  'Open' { Open-Dock }
  'Stop' {
    $dockExpected = '"' + $dockServer + '"'
    $dockProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -eq $dockNode -and $_.CommandLine -and $_.CommandLine.TrimEnd().EndsWith($dockExpected) }
    foreach ($dockProcess in $dockProcesses) { Stop-Process -Id $dockProcess.ProcessId }
    Write-Output 'This Stream Dock instance has stopped.'
  }
}
} catch {
  $dockPopup = New-Object -ComObject WScript.Shell
  $dockPopup.Popup($_.Exception.Message, 0, 'Stream Dock - Setup error', 16) | Out-Null
  exit 1
}
