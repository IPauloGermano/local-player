#!/usr/bin/env bash
# Encerra graciosamente o Local Player enviando SIGTERM (drenando filas e salvando progresso)
PIDS=$(pgrep -f "node server.js" || true)
if [ -n "$PIDS" ]; then
  echo "Encerrando Local Player (PID: $PIDS)..."
  kill -SIGTERM $PIDS 2>/dev/null || true
  sleep 1
  echo "Local Player encerrado com sucesso."
else
  echo "Local Player não está em execução."
fi
