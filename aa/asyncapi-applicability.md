# AsyncAPI применимость

В текущей версии `cmdbdynamicpages` нет асинхронного обмена через Kafka, RabbitMQ или аналогичные брокеры.

Следовательно:

- AsyncAPI artifact не требуется;
- topic/queue registry отсутствует;
- все интеграции проекта являются синхронными HTTP/Redis/CMDBuild REST потоками и описаны в [information-model.md](information-model.md) и [openapi.yaml](openapi.yaml).

Если в будущем появится Kafka/RabbitMQ обмен, необходимо добавить:

- `aa/asyncapi.yaml`;
- описание topic/queue names;
- структуру сообщений, полностью совпадающую с фактическим payload;
- карту доступов Kafka/RabbitMQ;
- ссылки на новые flow IDs в информационной модели.
