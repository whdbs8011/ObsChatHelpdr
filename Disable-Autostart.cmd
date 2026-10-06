@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Control.ps1" -Action Uninstall
pause
