# Карта доступов Kafka

Статус: неприменимо (not applicable).

В runtime проекта нет Kafka/RabbitMQ clients, topics, producers или consumers. Основание: `package.json`, `scripts/dev-proxy-server.mjs`, `docker-compose.runtime.yml`.

Выбор платформой Kafka как транспорта внешнего сборщика stdout не означает прямой Kafka-интеграции приложения. Такой транспорт согласуется платформой отдельно.

XLSX для Kafka не создаётся. При появлении прямого брокерного обмена требуются карта topics/ACL/контуров, XLSX и [AsyncAPI](asyncapi-applicability.md), согласованные с [информационной моделью](information-model.md).
