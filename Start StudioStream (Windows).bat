@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODE_BIN="
if exist "runtime\node.exe" (
    set "NODE_BIN=%~dp0runtime\node.exe"
) else (
    for /f "delims=" %%I in ('where node 2^>nul') do (
        if not defined NODE_BIN set "NODE_BIN=%%I"
    )
)

if not defined NODE_BIN (
    echo [ERROR] Node.js tidak ditemukan ^(baik runtime\node.exe maupun di PATH^).
    echo Download versi Release siap-pakai dari GitHub atau install Node.js LTS dari https://nodejs.org
    pause
    exit /b 1
)

if not exist "build" mkdir "build"

if not exist "build\studio-stream-engine.exe" (
    echo Membangun Windows WASAPI Audio Engine...
    where g++ >nul 2>nul
    if !errorlevel! equ 0 (
        g++ -std=c++17 -O2 -Wall -Wextra engine\main.cpp engine\WinAudioBackend.cpp -lole32 -luuid -lavrt -lmmdevapi -o build\studio-stream-engine.exe
    ) else (
        where cl >nul 2>nul
        if !errorlevel! equ 0 (
            cl /std:c++17 /O2 /EHsc engine\main.cpp engine\WinAudioBackend.cpp /Fe:build\studio-stream-engine.exe ole32.lib uuid.lib avrt.lib mmdevapi.lib
        ) else (
            echo [WARNING] build\studio-stream-engine.exe dan compiler C++ ^(g++ / MSVC cl^) tidak ditemukan.
            echo Silakan download paket Release siap-pakai dari GitHub Actions / GitHub Releases.
            pause
            exit /b 1
        )
    )
)

echo ==================================================
echo   StudioStream Mixer ^(Fender Studio One Edition^)
echo   Menjalankan Server ^& Membuka Console UI...
echo ==================================================

start "" cmd /c "timeout /t 2 /nobreak >nul && (start msedge --app=http://127.0.0.1:8780 2>nul || start chrome --app=http://127.0.0.1:8780 2>nul || start http://127.0.0.1:8780)"
"%NODE_BIN%" server.mjs
pause
