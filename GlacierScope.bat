@echo off
cd /d "%~dp0"

set INGEST_PY=%~dp0viewer\runtime\python\python.exe

if not exist "%~dp0viewer\runtime\python\Lib\tkinter" (
    echo Fetching Tcl/Tk for the bundled Python runtime, one-time, ~3.4 MB from python.org...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0viewer\runtime\fetch_tkinter.ps1"
    if errorlevel 1 (
        echo.
        echo Failed to fetch Tcl/Tk -- the file picker needs it to start.
        echo Check your internet connection and try again.
        pause
        exit /b 1
    )
)

REM A source checkout (git clone, not the GitHub Release zip) ships the
REM bundled Python interpreter but not the packages it needs -- those are
REM too large to track in git (viewer\runtime\python\Lib\site-packages is
REM gitignored). Detect that one-time and pip install from requirements.txt
REM instead of failing deep inside ingest.py's first import.
if not exist "%~dp0viewer\runtime\python\Lib\site-packages\numpy" (
    echo Installing Python dependencies into the bundled runtime, one-time...
    "%INGEST_PY%" -m pip install -r "%~dp0viewer\runtime\requirements.txt"
    if errorlevel 1 (
        echo.
        echo Failed to install dependencies. Check your internet connection and try again.
        pause
        exit /b 1
    )
)

"%INGEST_PY%" ingest\ingest.py
pause
