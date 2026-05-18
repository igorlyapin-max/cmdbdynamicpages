# Архитектурные артефакты cmdbdynamicpages

Артефакты подготовлены по требованиям `../aa.txt`. Схемы ведутся как Mermaid/Markdown исходники, чтобы их можно было версионировать в git и экспортировать в vsdx/png при необходимости.

## Индекс

| Артефакт | Файл |
| --- | --- |
| Описание бизнес-процессов | [business-processes.md](business-processes.md) |
| Информационная модель | [information-model.md](information-model.md) |
| Схема развертывания | [deployment.md](deployment.md) |
| OpenAPI | [openapi.yaml](openapi.yaml) |
| Карта HealthCheck | [healthcheck-map.md](healthcheck-map.md) |
| Карта секретов | [secrets-map.md](secrets-map.md) |
| Карта регистрации событий | [event-logging-map.md](event-logging-map.md) |
| Схема потоков логирования | [logging-flow.md](logging-flow.md) |
| Карта метрик | [metrics-map.md](metrics-map.md) |
| AsyncAPI применимость | [asyncapi-applicability.md](asyncapi-applicability.md) |
| Карта доступов Kafka | [kafka-access-map.md](kafka-access-map.md) |

## Общие соглашения

- Все сетевые соединения на схемах и в таблицах указываются с портами.
- Идентификаторы информационных потоков имеют вид `IF-XXX` и используются в смежных картах.
- Production Redis считается обязательным и должен требовать пароль.
- Секреты не хранятся в git; runtime получает их из secret/env уровня деплоя.
- Асинхронного обмена Kafka/RabbitMQ в текущей версии проекта нет.
