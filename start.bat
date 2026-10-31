@echo off
cd /d "%~dp0"
py server.py
if errorlevel 1 (
  echo.
  echo Could not start with the Python launcher. Trying python...
  python server.py
)
