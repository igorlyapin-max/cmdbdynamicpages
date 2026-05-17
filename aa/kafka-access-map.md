# Карта доступов Kafka

Kafka/RabbitMQ в текущей версии проекта не используются.

| Topic/Queue | Producer | Consumer | Система | Статус |
| --- | --- | --- | --- | --- |
| Н/П | Н/П | Н/П | Н/П | Асинхронный обмен отсутствует |

При добавлении асинхронного обмена карта должна быть синхронизирована с:

- [information-model.md](information-model.md);
- будущим `aa/asyncapi.yaml`;
- [secrets-map.md](secrets-map.md);
- [event-logging-map.md](event-logging-map.md).
