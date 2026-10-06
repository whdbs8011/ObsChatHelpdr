param([ValidateSet('Protect','Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$dockInput = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
if ($Mode -eq 'Protect') {
  $dockOutput = [Security.Cryptography.ProtectedData]::Protect($dockInput, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $dockOutput = [Security.Cryptography.ProtectedData]::Unprotect($dockInput, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($dockOutput))
