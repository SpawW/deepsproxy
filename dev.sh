#!/usr/bin/env bash
# dev.sh — Sobe o deepsproxy em modo dev (headed browser visível na tela).
# Usa network_mode: host para acessar o X11 abstract socket do host.
#
# Uso:
#   ./dev.sh             → sobe em background
#   ./dev.sh rebuild     → rebuilda ambas as imagens e sobe
#   ./dev.sh logs        → acompanha logs (api|browser|all)
#   ./dev.sh down        → para os containers

set -e

CMD="${1:-up}"
TYPE="${2:-all}"

case "$CMD" in
  up)
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
    echo "Para ver logs: ./dev.sh logs [api|browser|all]"
    ;;
  rebuild)
    echo "Rebuilding all containers..."
    docker rm -f deepsproxy deepsproxy-playwright || true
    docker compose -f docker-compose.yml -f docker-compose.dev.yml build
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
    echo "Para ver logs: ./dev.sh logs [api|browser|all]"
    ;;
  logs)
    case "$TYPE" in
      api)
        docker logs -f deepsproxy
        ;;
      browser)
        docker logs -f deepsproxy-playwright
        ;;
      *)
        docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f
        ;;
    esac
    ;;
  down)
    docker compose -f docker-compose.yml -f docker-compose.dev.yml down
    ;;
  *)
    echo "Uso: ./dev.sh [up|rebuild|logs [api|browser|all]|down]"
    exit 1
    ;;
esac
