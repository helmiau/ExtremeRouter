@echo off
rem ExtremeRouter launcher: starts Brave with CDP remote debugging (port 9222)
rem so token capture can attach to the RUNNING instance and open a new tab.
setlocal
set "BRAVE=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
set "PORT=9222"

if not exist "%BRAVE%" goto :nobrave
netstat -ano | findstr ":%PORT%" >nul
if not errorlevel 1 goto :active
tasklist | findstr /i "brave.exe" >nul
if not errorlevel 1 goto :running
start "" "%BRAVE%" --remote-debugging-port=%PORT%
echo [OK] Brave started with remote debugging on port %PORT%.
echo      Pin this launcher to your taskbar and use it going forward.
goto :done

:active
echo [OK] Remote debugging already active on port %PORT% - just use ExtremeRouter capture.
goto :done

:running
echo [!] Brave is already running WITHOUT remote debugging.
echo     Close ALL Brave windows first, then run this launcher again.
echo     (From now on, start Brave from this launcher so capture can attach.)
goto :done

:nobrave
echo [!] Brave not found at %BRAVE%
goto :done

:done
endlocal
