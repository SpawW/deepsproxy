#!/usr/bin/env bash
# dev.sh — Sobe o deepsproxy em modo dev (headed browser visível na tela).
# Usa network_mode: host para acessar o X11 abstract socket do host.
#
# Uso:
#   ./dev.sh          → sobe em background
#   ./dev.sh logs     → sobe e acompanha logs do playwright
#   ./dev.sh down     → para os containers

set -e

CMD="${1:-up}"

case "$CMD" in
  up)
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
    echo "Para ver logs: docker logs -f deepsproxy-playwright"
    ;;
  logs)
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
    docker logs -f deepsproxy-playwright
    ;;
  down)
    docker compose -f docker-compose.yml -f docker-compose.dev.yml down
    ;;
  *)
    echo "Uso: ./dev.sh [up|logs|down]"
    exit 1
    ;;
esac
