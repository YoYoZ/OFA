#!/bin/bash
# Full hard reset: rebuilds the image from scratch and WIPES ALL DATA (projects, comments, secrets).
set -e
cd "$(dirname "$0")"

read -r -p "This deletes ./data (all projects and comments). Type 'yes' to continue: " answer
[ "$answer" = "yes" ] || { echo "Aborted."; exit 1; }

echo "1) Stopping containers..."
docker compose down -v --remove-orphans

echo "2) Removing data..."
rm -rf data/
mkdir -p data/

echo "3) Rebuilding image without cache..."
docker compose build --no-cache --pull

echo "4) Starting..."
docker compose up -d

echo ""
echo "Ready. Logs:  docker compose logs -f"
echo "If ADMIN_PASSWORD is not set, the generated password is printed in the logs."
