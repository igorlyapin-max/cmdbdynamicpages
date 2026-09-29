# Применимость AsyncAPI

Статус: неприменимо (not applicable).

Проект не использует Kafka, RabbitMQ или аналогичный брокер. Redis служит хранилищем кэша и snapshots, а не очередью сообщений; асинхронные Promise и checkpoint-запросы Assistant не являются брокерным обменом.

Основание: runtime-вызовы в `scripts/dev-proxy-server.mjs` и состав `docker-compose.runtime.yml`. Каналы описаны в [информационной модели](information-model.md), HTTP — в собственном и consumed OpenAPI.

При появлении producer/consumer необходимо добавить AsyncAPI с конкретными сообщениями, потоки с префиксом AAPI, карту доступов и применимый XLSX. Пустая спецификация сейчас не создаётся.
