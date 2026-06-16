#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then echo "Installing dependencies..."; npm install; fi
if [ ! -f .env ]; then echo "No .env found — copying .env.example to .env. Open it and add your keys."; cp .env.example .env; fi
echo "Starting AI Video Studio on http://localhost:4505 ..."
npm start
