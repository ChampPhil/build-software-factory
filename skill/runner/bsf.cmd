@echo off
setlocal enableextensions
set "HERE=%~dp0"
if not defined TMPDIR set "TMPDIR=%TEMP%"
set "CACHE=%TMPDIR%\bsf-4de87c5a0ead"
if exist "%CACHE%\bsf.mjs" goto run
set "STAGE=%TMPDIR%\bsf-unpack.%RANDOM%%RANDOM%"
mkdir "%STAGE%" >nul 2>&1
tar -xzf "%HERE%runner.tgz" -C "%STAGE%"
if errorlevel 1 goto tarfail
mkdir "%CACHE%" >nul 2>&1
if errorlevel 1 goto loser
move /y "%STAGE%\schema" "%CACHE%\" >nul
move /y "%STAGE%\vendor" "%CACHE%\" >nul
move /y "%STAGE%\bsf.mjs" "%CACHE%\bsf.mjs" >nul
rmdir "%STAGE%" >nul 2>&1
goto run
:loser
node "%STAGE%\bsf.mjs" %*
exit /b %errorlevel%
:tarfail
echo bsf: could not unpack runner.tgz. It needs tar, which Windows has shipped since 10 1803. 1>&2
exit /b 1
:run
node "%CACHE%\bsf.mjs" %*
exit /b %errorlevel%
