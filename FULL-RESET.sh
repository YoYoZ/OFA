#!/bin/bash

echo "🔧 ПОЛНЫЙ ХАРДРЕЗЕТ"
echo "=================="

echo ""
echo "1️⃣ Останавливаем контейнеры..."
docker compose down -v --remove-orphans

echo ""
echo "2️⃣ Очищаем build кеш..."
docker compose build --no-cache --force-rm

echo ""
echo "3️⃣ Удаляем старую БД..."
rm -rf data/
mkdir -p data/

echo ""
echo "4️⃣ Запускаем свежую сборку..."
docker compose up -d --build

echo ""
echo "5️⃣ Ждём инициализации..."
sleep 5

echo ""
echo "✅ ГОТОВО!"
echo ""
echo "Проверь логи:"
echo "  docker-compose logs -f"
echo ""
echo "Открой браузер:"
echo "  http://localhost:3000"
