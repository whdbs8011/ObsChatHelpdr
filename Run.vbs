Option Explicit
Dim shell, fso, root, action, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
action = "Setup"
If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\Control.ps1"" -Action " & action
shell.Run command, 0, False
