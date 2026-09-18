# testtemplate4: Локальная Ревизия Authoring

## Граница Изменений

`buildTesttemplate4Artifacts(spec)` из `scripts/assistant-quality-template-artifacts.mjs`
синхронно возвращает новый spec. Функция не читает файлы, не пишет CMDB, не вызывает
сеть, LLM, Apply, Save, preview или runtime. Имя `testtemplate4` обозначает ревизию
артефактов. На стенде отдельно создана и сохранена карточка `testtemplate4` через
обычный API шаблонов. Исходные `testtemplate2` и `testtemplate3` не изменены.

Вход: канонические `authoring.version=1`, `promptContractVersion=4`, 13 точно
именованных бизнес-блоков и плоские D2 class definitions с `style.*` и `Notes: |md`
из baseline. Неизвестный формат, отсутствующее или дублирующееся имя дают ошибку
без частичной записи. Это адресная ревизия, не универсальный D2 parser.
Legacy не поддержана/не запланирована для этого builder.

Разрешенные изменения:

- `authoring.assistant.objectFlowIntent.context` и `blocks[].description` известных блоков.
- `authoring.assistant.diagramIntentPrompt`: один фазозависимый текст для interpret и map.
- `authoring.assistant.systemPromptOverrides`: только `diagramSemantics`,
  `diagramBindingIntent`, `diagramPlacement`, `diagramConnections`, `diagramCritique`.
- Тела 15 class Notes в `authoring.d2.source`; остальной D2 побайтно сохранен.
- `authoring.d2.sourceHash`: SHA-256 UTF-8 source. При изменении source удаляются
  `analysisCheckpoint` и, если присутствует, `assistantCheckpoint` как устаревшие.

Не меняются `steps`, фильтры, `params`, `result`, `visualModel`, `visualModels`,
`publish`, `cache`, имена/ID/uses/resultKind блоков. Нет жестко заданных stage/card IDs.
Не затрагиваются глобальные runtime prompts и system/objectFlow overrides; вход
с такими overrides отклоняется, а не молча очищается. Повторный вызов идемпотентен.

## Усиление После Первого UI-Прогона

По сообщению оператора, первый полный live UI-прогон предыдущей ревизии завершился
неуспешно после трех repair: рамки оставались `structural`, хотя объяснение модели
называло их повторяемыми, а дочерние узлы оставались без materialized parent.
Это результат отдельного эксперимента, не новый прогон в этой artifacts-only работе.

Текущая ревизия усиливает Notes существующими machine directives:

| Роли | materialization | binding-result на уровне роли |
| --- | --- | --- |
| group_external, group_internal, group_target, group_dmz, applications_group | structural | отсутствует |
| scope_vlan | stage | VLAN целевой ИС |
| scope_server | stage | отсутствует: блок зависит от placement |
| application | stage | отсутствует: блок зависит от placement |
| external_system | stage | Внешние ИС |
| internal_system | stage | Внутренние ИС |
| vlan, server | parentCard | отсутствует |

Каждая directive находится на отдельной строке Notes. `replaceNotes` сохраняет
отступ всех строк и исходный LF/CRLF. Backend уже преобразует `materialization`
в одно допустимое значение `allowedMaterialization`, а `binding-result` в exact
block ID из manifest. Проверены существующие normalization, binding seed и поля
`fixedMaterializationIntent`/`requiredBusinessBlockId` в сообщении Assistant.
Ответ с ошибочным `structural` не переопределяет фиксированный режим. Backend
не изменен; новых JSON-полей, parser/engine или executable mapping не добавлено.

Это фиксирует режим и три однозначных источника, но не доказывает готовность
membership, endpoint fields, стороны пары или родителя с выбранным stage.
Естественные обязательства остаются pending для проверки; отсутствующий terminal
stage не превращается в готовую привязку. Названия ветвезависимых блоков не
закрепляются на уровне общей роли. Следующий шаг оператора: freeze этой ревизии
и три независимых UI-прогона; их успешность пока не подтверждена.

## Уточненный Смысл

Описания используют названия блоков вместо порядковых ссылок, отличают IPv4-сравнение
от CMDB relation, карточку от пары и основной объект от данных для проверки.
Технические схемы ответов находятся в system overrides, не в бизнес-описаниях.
Все пять overrides предметно нейтральны: конкретные поля, классы, роли и смысл
сторон пары задают только локальный diagramIntentPrompt, Notes и контракты блоков.
В описаниях Application/phServer/vServer сохранен точный пользовательский атрибут
`ipaddress.IP address value`, без подмены адресом управления. В описаниях пар
сохранены domain `phs` и `vs`: свежий snapshot содержит соответствующие
`expandRelations` к `phServer` и `vServer`. Это проверка снимка, не live-каталога.

`group_external`, `group_internal`, `group_target`, `group_dmz` являются одиночными
рамками в своей ветви. `applications_group` одна на каждый экземпляр сервера.
`scope_vlan` и `scope_server` повторяются по карточкам, хотя не участвуют в стрелках.
`vlan` и `server` показывают карточку родительской рамки. `vlan` не является ИС.

Подписи явно указаны локальным текстом Notes: `Внешние системы`, `Внутренние системы`,
`${param.isName}` для group_target, `DMZ`, `Приложения и среды`. Для scope_vlan и
scope_server используется `${Description}` собственной primary-карточки, не
родителя. Узлы используют Description своей карточки, с сохранением стороны пары.
Технический ключ роли не служит подписью. Это инструкции для существующего
`labelTemplate`, не новая label-directive и не детерминированная установка label
в executable spec. Их фактическое применение остается предметом UI-проверки.

Для VLAN явно различаются isNAT=true в DMZ и isNAT=false вне DMZ; null не считается
false. Сервер требует положительного условия принадлежности конкретному VLAN.
Для приложения в паре current является сервером, relation-source приложением.
Сторона приложения определяет identity, label и endpoint; серверная сторона
сравнивается с ближайшим materialized parent по Class + _id. Dependency/lineage
и D2-вложенность не доказывают membership, даже при прямой зависимости stage.

`endpointMode` выбирает attributeEndpoints, relationCard или deterministicEndpoints.
`dataFields` остается directionPolicy в существующем D2, не режимом сопоставления.
В локальном diagramIntentPrompt и Notes каждого ACL-класса источник соответствует
`ipaddress`, назначение `dipaddress`, не range. Эти имена отсутствуют в общих
overrides. Полный range-путь ИС не подставляется вместо отсутствующего
контекста. Адреса, имена и стрелки exemplar остаются только визуальными примерами.

«ACL внутри целевой ИС» предоставляет более широкий набор строк-кандидатов по
Source ИЛИ Destination. Внутренняя стрелка выводится только при положительном
сопоставлении обоих отображаемых концов с объектами целевой ИС. Несовпавший кандидат
остается строкой результата, но не становится внутренним ребром. Это разные уровни
проверки, не противоречие и не причина отвергать весь mapping. Исполняемый отбор
строк по ИЛИ сохранен; наличие готовой проверки обоих концов не утверждается.

Противоречия отражаются в существующих explanation/warnings/message. Binding и
placement используют собственный typed unresolved. Connections пропускает правило
с предупреждением, далее работает существующая coverage. Semantics не имеет
unresolved. Critique использует только существующие obligationId. Новых endpoint,
кнопки, validator/engine или runtime LLM эта ревизия не добавляет.

## Что Не Подтверждено

1. Путь VLAN к ipRange требует каталожного подтверждения. Прежнее название domain
   убрано из описания как недоказанное для этой пары классов; новый domain не угадан.
2. Для ИС в замороженном binding-контексте отсутствовал доступный terminal range-путь.
   Исторический ручной mapping не доказывает доступность поля сейчас. Builder
   не расширяет каталог или terminalFields и не добавляет этот путь в prompts.
3. Точный исполнимый путь для указанного `ipaddress.IP address value` приложения/
   сервера и membership server/VLAN должны присутствовать в предложенных полях/
   правилах. Явный пользовательский атрибут сохранен, но текст не создает поля.
4. Backend содержит `primary.cardSource` во внутреннем mapping, но текущие typed
   binding/placement-ответы не имеют поля выбора стороны пары. Поэтому prompts
   не предлагают `pairSide`, `projection` или `primary.cardSource` как новый ключ.
   Без подтвержденной проекции приложение должно остаться unresolved.
5. Историческое описание «ACL внутри целевой ИС» содержало Description вместо
   Name. Описание исправлено на Name=isName, как в «Сети целевой ИС»; эта история
   документирована только здесь, без повторяющегося самоотклонения в live prompt.
   Сохраненный исполняемый поток не исправлялся. Полнота правил отображения обоих
   концов внутренней стрелки требует проверки отдельно от исходных строк по ИЛИ.
6. Совпадение числа строк не доказывает число карточек, узлов или стрелок. Нужен
   независимый oracle по identity, сторонам пар, ветвям и обоим концам ACL.
7. Critique может ссылаться только на supplied SemanticObligationMatrix. Пробел,
   отсутствующий в матрице, можно объяснить текстом, но нельзя гарантированно
   отклонить: approved=false без violations текущий backend не принимает.

Основание: [результаты проверки](assistant-quality-results-2026-09-05.ru.md),
восстановленные authoring/runtime-prompts и свежий локальный снимок
`.omk/runs/2026-09-05-testtemplate4/testtemplate3-before.json`.
Проверены ответы обычного UI, live-извлечение и read-only чтение участвующих
CMDB-карточек и relations. Наличие связи в CMDB не означает, что ее поля переданы
binding-этапу Assistant. Подробные результаты: [UI-проверка](assistant-quality-testtemplate4-results.ru.md).

## Ожидаемый Oracle

Ожидания вычислены до генерации по отдельно прочитанным карточкам и relations CMDB,
а не предоставлены пользователем и не получены из результата Assistant:
10 динамических участников, 2 VLAN, 6 parent-child memberships;
4 внешние, 8 внутренние и 4 внутрицелевые стрелки. Обе внешние ИС имеют одинаковый
range, но остаются разными объектами: ожидание 4 внешних ребра, не 2. У двух ACL
не сопоставлен один конец. Отсутствие подтвержденного совпадения должно оставаться
диагностикой отсутствующего совпадения, без ложного сопоставления ради достижения
чисел. Builder не кодирует эти количества как фильтры и не меняет данные. Oracle
не передавался LLM. Он ограничен выбранными карточками и не доказывает полноту CMDB.

## Проверка

```bash
node --check scripts/assistant-quality-template-artifacts.mjs
node --test tests/unit/assistant-quality-template-artifacts.test.mjs
node tests/unit/assistant-quality-template-artifacts.test.mjs
```

Тесты используют синтетический spec с непрозрачными IDs, канонические backend
normalization/validation/hash и compiler preprocessing. Проверяют точные имена
блоков, смысл Notes, отсутствие новых override keys, отсутствие изменений
executable hash, побайтную неизменность D2 вне Notes, CRLF и идемпотентность.
Дополнительно проверены многострочные Notes, точные подписи, нормализация
materialization, binding seed, отсутствие общего блока у ветвезависимых ролей
и сохранение pending для неподтвержденных обязательств.
Дополнительный тест свежего приватного baseline выполняется только при наличии
локального снимка; без него отмечается skip. Содержимое снимка не копируется в Git.
Прямой запуск test-файла на свежем baseline подтвердил 13 passed, 0 failed,
0 skipped.

Unit-тесты доказывают свойства артефактов, не качество LLM. Отдельные live-прогоны
Analyze/Interpret/Map/Save/preview описаны в отчете. Apply при невалидном mapping
недоступен; это зафиксированная незавершенность, не успешная полная диаграмма.
Runtime-код не менялся, поэтому rebuild/restart для этих сохраненных артефактов
не требуется. Сохраненный no-LLM runtime остается без изменений.
