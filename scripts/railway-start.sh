#!/usr/bin/env sh
set -eu

mkdir -p /data/app-data /data/home

if [ ! -L /app/data ]; then
  rm -rf /app/data
  ln -s /data/app-data /app/data
fi

exec node dist/loop.js
