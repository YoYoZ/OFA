#!/bin/bash

echo "🔧 Full hardreset"
echo "=================="

echo ""
echo "1️⃣ Stopping container..."
docker compose down -v --remove-orphans

echo ""
echo "2️⃣ Clearing build cache..."
docker compose build --no-cache --force-rm

echo ""
echo "3️⃣ Removing old database..."
rm -rf data/
mkdir -p data/

echo ""
echo "4️⃣ Building anew container..."
docker compose up -d --build

echo ""
echo "5️⃣ Waiting for initialising..."
sleep 5

echo ""
echo "✅ READY!"
echo ""
echo "To check logs:"
echo "  docker-compose logs -f"
echo ""
echo "Default address is:"
echo "  http://localhost:3000"
