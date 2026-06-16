@echo off
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist .env (
  echo.
  echo No .env found. Copying .env.example to .env — open it and add your API keys.
  copy .env.example .env
)
echo Starting AI Video Studio on http://localhost:4505 ...
call npm start
