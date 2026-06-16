@echo off
REM Stops the AI Video Studio server started by the launcher.
REM It targets only the launcher's own node process (the --avs-launcher marker),
REM so any other Node apps you run are left untouched.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*--avs-launcher*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo AI Video Studio has been stopped.
timeout /t 2 >nul
