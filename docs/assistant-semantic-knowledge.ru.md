# Семантическое знание и независимое сравнение Assistant

## Граница evidence

`scripts/assistant-quality-lab.mjs` сохраняет исторические abstract A-E. Их
значения не переименованы; старые отчеты читаются только как исторические
симуляции. Ни offline fixture scores, ни stage-only replay не доказывают качество
production pipeline.

`scripts/assistant-quality-comparison.mjs` отдельно определяет production plan и
оценивает предоставленные main снимки. Он не вызывает LLM, CMDB или браузер,
не изменяет templates/config и не рассчитывает выдуманную стоимость.

| Arm | Изменение относительно замороженного baseline |
| --- | --- |
| A | Baseline |
| B | Исправленные prompts + explicit bindings |
| C | Typed context из подтвержденных metadata/Help |
| D | Deterministic compile + внешний public-contract counterexample |
| E | B + C + D |

Каждый arm использует те же scenario data, модель и revision. C/E получают
дополнительные curated сведения; это отдельная интервенция, не equal-input
сравнение prompts. Default production budget: `maxCalls=40`, concurrency <= 2,
maxRepairs <= 1, timeout 60000 ms, input/output 16000/2400 tokens, суммарно
736000 reserved tokens. `limits` настраиваются; plan содержит
`5 * scenarios * repeats` jobs, theoretical и enforced call bounds. Вызовы
этот модуль не выполняет; admission должен применять live runner до каждого
вызова, включая repair. Нехватка бюджета не разрешает убирать job из знаменателя.
Full-row snapshots имеют отдельный frozen `maxSnapshotBytes`: default 16 MiB,
верхняя граница 64 MiB. `limits.maxResponseBytes` относится к LLM response и не
усекает oracle/actual rows. Превышение snapshot bound отклоняется явно.

## Metadata И Help

Curated контекст описывает семантику оператора, не ответы классов заказчика.
Оператор фиксирует provenance, revision/hash, class/attribute type, nullable,
reference target, направление domain, доступность поля после операции, row
grain и точный terminal card source. Help должен различать физическую связь,
владение и административную ответственность. Похожее имя поля не доказательство.

| Оператор/решение | Пример | Контрпример |
| --- | --- | --- |
| Reference traversal | Путь подтвержден reference target и Help | Выбор первого reference похожего класса |
| Equality / null | `null` проверяется отдельно; null не равен false | Подмена отсутствующего значения false или строкой `"null"` |
| AND / OR | Сохранять `A AND (B OR C)` | Переписать в `(A AND B) OR C` |
| IPv4 membership | Адрес сравнивается с CIDR по IPv4 | Сравнение строк/префиксов или адреса управления вместо основного |
| Candidate / edge | Отбор строки по source OR destination; стрелка требует двух доказанных концов | Заменить OR на AND для строк либо рисовать стрелку по одному концу |
| Pair / projection | Строка хранит обе стороны; `cardSourceId` явно выбирает отображаемую | Считать `current` правильным по имени класса или менять исходную строку |
| Copies / membership | Identity включает placement и родителя; членство доказано полями пары | Схлопнуть копии по record ID; принять lineage за membership |
| Hierarchy | Подтверждены каждый переход и непосредственный родитель | Пропуск промежуточного уровня или вывод родства из вложенности D2 |
| Directed multiedge | Сохранить ID связи, оба конца, направление и подпись | Дедупликация только по паре концов или разворот по диапазону сети |
| Label | Подпись выбранной отображаемой карточки | Подпись серверной стороны вместо приложения из той же пары |
| Missing candidate | Валидный `unresolved` с незакрытой обязанностью | Выдумать domain/field либо объявить сетевую ошибку корректным отказом |

Examples/counterexamples используют искусственные записи и описывают только
оператор. Не добавляйте customer IDs, готовые выборки, oracle candidate IDs или
ожидаемые строки в Help, prompts, typed context и repair feedback. Counterexample
для D/E проверяет публичный контракт; приватный oracle не участвует в repair.

## Freeze И Checkpoints

`createProductionComparisonPlan({freeze, scenarios, repeats, limits})` возвращает
deep-frozen plan. `freeze` обязателен: `schema`, `data`, `prompts`, `model`.
Первые два содержат snapshot/revision/provenance, `prompts` содержит точные
`intent` и `binding` строки для каждого A-E, `model` содержит `id`, `revision`
и фактические параметры модели. Не передавайте секреты. Для воспроизводимости
добавьте revision runtime/compiler к provenance. Plan хеширует содержимое
schema/data/prompts/model, сценарии вместе с oracle и implementation evaluator.

Scenario: `{id, taskId, domain, split, evidenceKind, input, expected}`.
`split` = `development|holdout`, `evidenceKind` = `synthetic|production`.
Одинаковый `taskId` в разных splits отклоняется; оператор дополнительно проверяет
смысловую независимость задач. Development и holdout fixtures содержат разные
домены/записи: city/street/building и campus/wing/room, неоднозначные references,
pairs/copies, null AND/OR, IPv4, missing candidate. Holdout не используется для
настройки prompts. Fixtures всегда `synthetic`; их метрики не входят в
`productionMetrics`. Только реальные UI/runtime captures маркируются production.

`input` содержит `{request, schema, data, explicitBindings, typedContext}`.
`productionScenarioInput(plan, caseId, arm)` возвращает только публичную часть,
добавляя explicitBindings для B/E и typedContext для C/E. Не отправляйте LLM
сам plan, `expected`, manifest с provenance приватного oracle или отчеты.

`compareProductionSnapshots({plan,captures,outputDir,resume})` сохраняет
`manifest.json`, digest/sequence-проверяемый `events.jsonl` и `results.json`.
Стадии `intent`, `binding`, `compile`, `execute` фиксируются отдельно. Повторное
чтение stage не запускает вызов; изменять записанную stage нельзя. Незавершенный
job остается failure до появления недостающего checkpoint. Изменение freeze
требует нового каталога. Evidence приватное: каталоги 0700, файлы 0600; перед
публикацией требуется обезличивание. Это артефакты offline CLI, не новый сервис
и не замена основному runtime structured logging pipeline.

## Схема Результатов

`expected` = `{outcome:"accepted"|"unresolved", snapshot, knowledgeRequired?}`.
Для unresolved `snapshot=null`. Отсутствие Help с `knowledgeRequired=true`
не позволяет A/B/D засчитать случайно угаданную семантику.

Capture:

```json
{
  "fingerprint": "<plan fingerprint>",
  "caseId": "<scenario id>", "arm": "A", "repeat": 0,
  "stages": {
    "intent": {"transportCompleted": true, "contractValid": true, "status": "accepted"},
    "binding": {"transportCompleted": true, "contractValid": true, "status": "accepted"},
    "compile": {"transportCompleted": true, "contractValid": true, "status": "accepted"},
    "execute": {"transportCompleted": true, "contractValid": true, "status": "accepted"}
  },
  "snapshot": {"rows": [], "displayedCards": [], "placements": [], "hierarchy": [], "edges": [], "labels": []}
}
```

Статус stage = `accepted|unresolved|failed`. `transportCompleted` измеряет
модельный транспорт для intent/binding; локальные compile/execute могут ставить
true только после фактического завершения своей операции. `contractValid`
не означает правильную семантику. Валидный unresolved завершает последовательность:
последующих stages нет. Failure, timeout, невалидный ответ или отсутствующая stage
не превращаются в unresolved. Флаги берутся из реального результата, не из
видимости кнопки или одного HTTP 200.

Snapshot содержит ровно шесть массивов, в oracle и actual одна схема:

- `rows`: полные объекты строк, например `{blockId, row:{...}}`. Сохраняйте все
  поля и стороны пар без проекции/переименования; строки сравниваются как multiset.
- `displayedCards`: multiset `{className,id}` по фактическим отображениям.
- `placements`: `{id,structureItemId,card:{className,id},cardSourceId}`. ID уникален
  для occurrence, cardSourceId точный из terminal contract. Для структурной
  рамки без карточки `card=null`, `cardSourceId=null`.
- `hierarchy`: `{parent,child}`, оба значения являются placement IDs.
- `edges`: `{id,from,to,direction,label}`, from/to являются placement IDs,
  direction = `forward|reverse`. Параллельные связи и повторения не схлопываются.
- `labels`: `{targetId,text}`, targetId указывает placement или edge.

`results[]` содержит case/split/domain/arm/repeat/evidenceKind, `pass`, `status`
(`passed|mismatch|unresolved|failed`) и `evaluation` с отдельными transport,
contract, unresolved, semanticCorrect, executionCorrect, checks и failure.
Semantic/execution correctness здесь выводятся только из полного независимого
сравнения execution snapshot, не из подтверждения модели. Если execution не
доказан, correctness = null. Сравнение полей не меняет исходные data-only rows.

Основная метрика `success/total` = `exact/total`, включая missing capture,
failed phase и неправильный пустой diagram. `successRate`/`exactRate` одинаковы;
`exactPerEvaluated` отдельно показывает `exact/evaluated`. `falseAcceptance`,
`failures`, `unresolved`, `correctAbstention` разделены. Correct abstention не
считается exact execution. Настоящий ожидаемый пустой результат проходит только
после всех завершенных stages и совпадения всех шести массивов. Metrics разделены
по arm/split/evidenceKind; `productionMetrics` исключает synthetic целиком.

## Файловые Входы

CLI не имеет live-режима:

```bash
node scripts/assistant-quality-comparison.mjs --plan /tmp/comparison-options.json
node scripts/assistant-quality-comparison.mjs --plan /tmp/comparison-options.json --captures /tmp/ui-captures.json --output-dir /tmp/comparison-report
```

Options могут ссылаться на `scenariosPath`; scenario может ссылаться на
`inputPath`/`expectedPath` вместо inline объектов. Относительные пути считаются
от options JSON; содержимое файлов входит в freeze. `--resume` возобновляет
тот же manifest. Capture JSON является массивом указанной выше схемы.

Существующие oracle/full-row artifacts, например под
`.omk/runs/2026-09-05-testtemplate4/`, остаются внешними входами. Если старый oracle
содержит participants/domain-specific hierarchy, main явно нормализует его в
шесть массивов и сохраняет отдельный expected JSON. Evaluator не угадывает эту
проекцию, не дополняет отсутствующие rows пустыми и не содержит template IDs.
Для свежих UI-копий сохраняйте отдельно input, независимый expected, actual
full-row snapshot и capture flags. Исходные templates и сохраненные prompts не
перезаписываются. Исправление эффективного default prompt фиксируется отдельной
runtime revision: остальные настройки сравниваются без этого единственного поля.

## Исполняемый Контракт

- `DataSemanticModel` v4 предоставляет каталог типизированных полей: reference и
  domain hops, направление, terminal class, тип, множественность и metadata Help.
  Сведения получаются из читаемого каталога, не из примеров бизнес-карточек.
  Поля ищутся по задаче и Notes; список всех колонок не является поисковым запросом.
  Лимиты глубины, сканирования и байтов обязательны. Даже маленький лимит не
  повышается скрыто. Усечение дает явное предупреждение, не доказательство полноты.
- `BusinessBlockManifest` v3 сохраняет terminal result и все доступные стороны
  строки. `D2BindingIntent` v2 явно выбирает `cardSourceId`. При нескольких сторонах
  имя класса, родитель или lineage не выбирают сторону вместо автора.
  `membershipCardSourceId` и `parentMembershipCardSourceId` независимо задают
  стороны сравнения с родителем; они не меняют отображаемую карточку.
- Подтвержденный terminal binding компилируется в размещения без повторного
  выбора стадий моделью. Неопределенный helper selection остается отдельной
  authoring-задачей. `parentCard` наследует Class + Id выбранного родителя через
  статические рамки, сохраняя каждую пользовательскую копию.
- Статическая рамка не создает сравнение данных. Карточки внутри такой рамки
  могут использовать `stage` с `membership=structural`. Независимый вложенный
  результат под материализованным родителем требует явного сравнения.
- Модель получает короткие request-local ссылки на placements. После ответа
  backend декодирует только поля ссылок, не literals и label templates. Неизвестная
  ссылка не исправляется догадкой. Короткие ссылки не сохраняются в Spec.
- Ledger сохраняет точные source spans требований и обнаруживает конфликты
  директив. Его `source-target-accountability-only` coverage не доказывает
  понимание произвольного текста. Semantic critic получает исходный ledger,
  выбранные стороны, подписи, filters и область стрелок. Финальное доказательство
  правильности остается за независимым выполнением и сравнением, не за critic.

## Необязательные Notes

Пользователь может описывать задачу обычным языком и редактировать результат в
детерминированном редакторе. Директивы ниже являются дополнительным способом
зафиксировать однозначный замысел, а не обязательным пользовательским метаязыком.
Placement Notes уточняют конкретную копию роли; Role Notes задают общий смысл.

```text
binding-result: Выбранные здания
card-source: relation-source
membership-card-source: current
parent-membership-card-source: current
required-membership: _id equals parent._id
label-template: ${Description}
```

Это пример уже подтвержденной строки-пары: отображается здание, а с родителем
сравнивается другая сохраненная сторона. Имена источников берутся только из
terminal contract; без такой стороны директива не исполнима. `label-template`
поддерживает статический текст, поля выбранной карточки и `${param.name}`.
`required-condition` фиксирует фильтр конкретной ветви, например `approved equals
true`. Отсутствующее значение не становится `false`. Machine directives не
заменяют проверки существования полей и исполнимости операторов.

Для типа стрелок, который должен оставаться внутри выбранной ветви:

```text
endpoint-scope: city_area
```

`city_area` является точным D2 element key контейнера. В ручном редакторе это
поле «Оба конца внутри контейнера» в «Связи D2»; пустое значение выбирает всю
диаграмму и явно отменяет Notes scope. Связь по атрибутам сначала сопоставляет
значения со всеми совместимыми объектами, затем оставляет только концы внутри
области. Это не список пар и не особая IPv4-логика: проверены также City/Building
и строковое равенство. Копии одного placement сохраняются; область не требует,
чтобы оба конца находились в одном runtime occurrence повторенного контейнера.
Неоднозначный key копий требует точного placement из редактора. Несуществующая
область не расширяется на всю диаграмму. Для других connection modes scope пока
отклоняется явно, а не игнорируется.

Новые authoring contracts не содержат автоматического legacy-подбора стороны
пары. Неоднозначное старое сопоставление требует явного выбора карточки.
