# Assistant Quality Lab

Автономный **abstract-stage-simulation**, не production baseline и не полноценное
A/B-сравнение pipeline Assistant. Скрипт не импортирует backend, не читает ключи
или `.env`, не обращается к CMDBuild. Production D2 binding replay реализуется
отдельно. Legacy-контракты не поддерживаются.

## Кейсы и варианты

12 компактных synthetic-сценариев: 6 development, 6 holdout. Проверяются AND/OR/NOT,
выбор reference, N:N, одинаковые labels, динамические copies, permutation candidates,
параллельные directed edges, пустая выборка и City -> Street -> Building.
Результаты oracle заданы вручную в fixture; до эксперимента они независимо
сравниваются с исполнением фиксированного reference candidate.

| Вариант | Стадии | Изменение |
| --- | --- | --- |
| A | binding, materialize | Current-style абстрактный candidate prompt, **не точный production prompt** |
| B | binding, materialize | Явное разделение обязательств стадий, запрет менять binding на materialize |
| C | binding, materialize | Дополнительный schema Help/domain context |
| D | binding, materialize | Явные business-result binding obligations |
| E | binding, deterministic compile | Исполнение выбранных решений и максимум один public-contract counterexample repair |

C является **knowledge-availability manipulation**, не equal-input сравнением
генерации: в `dev-reference-choice` поля `rA/rB` непрозрачны, их physical room/admin
team mapping доступен только C через schema Help. Остальные варианты должны
вернуть `unresolved`; даже случайно точный результат считается false acceptance
при недоступном знании. `semanticExact` сохраняет факт совпадения, а
`correctAbstention` показывает только валидный модельный ответ `unresolved`,
никогда transport/validation/budget failure. `exactRate = exact / evaluated`, где
`evaluated = total - failures`; при `evaluated=0` rate равен `null`, не нулю.
Это условная точность валидных конечных ответов, не общий end-to-end success rate.
Jobs с недоступным знанием остаются в `evaluated`, если модель дала валидный
ответ; смотрите также `available`, `correctAbstention`, `failures` и `total`.

Каждый candidate получает стабильный opaque SHA-ID. Seeded permutation общая для
всех вариантов; на каждом repeat список циклически сдвигается относительно seeded
порядка. После числа repeats, равного числу candidates, порядок повторяется.
Oracle, правильный candidate и grading metadata не включаются в requests.
Public input и schema Help являются доверенными **синтетическими** данными;
не передавайте сюда реальные CMDBuild данные или секреты.

E никогда не получает oracle в repair: только первое нарушение публичного
контракта identity/copies/parent depth/domain/direction. Он не исправляет ошибку
Boolean-фильтра по expected rows. Корректный выбор reference или бизнес-семантики
сам по себе не гарантируется компилятором.

## CLI

Node.js и встроенные модули, дополнительных зависимостей нет. Dry-run по умолчанию:

```bash
node scripts/assistant-quality-lab.mjs --mode dry-run --repeats 3 \
  --model corp-openai-gpt-4.1-mini --model-revision operator-pinned-v1 \
  --temperature 0.1 --max-output-tokens 2400 \
  --max-calls 648 --max-total-tokens 11923200

node scripts/assistant-quality-lab.mjs --mode offline --repeats 3 \
  --max-calls 648 --max-total-tokens 11923200 \
  --output-dir .omk/runs/assistant-quality-offline

node --test tests/unit/assistant-quality-lab.test.mjs
```

180 jobs = 12 cases x 5 variants x 3 repeats. A-D имеют две model-стадии, E одну:
324 базовых вызова; с одним repair на стадию максимум **648**. Default `maxCalls=360`
может остановить эксперимент раньше; для полного worst case задайте 648 явно.
Dry-run не импортирует `--adapter`, не вызывает `complete`, не создаёт artifacts;
показывает фактические ограничения и request/context hashes. `--split` принимает
`all`, `development`, `holdout`; `--variants` принимает, например, `A,C,E`.

Offline использует candidate-first stub и детерминированный fixture interpreter.
Это проверка механизмов harness; offline scores не являются результатами модели.
В offline/dry-run все model-quality hypotheses имеют статус `unavailable`.

## API и adapter

```js
import { runExperiment } from './scripts/assistant-quality-lab.mjs';
import { assistantQualityCases } from './tests/fixtures/assistant-quality-cases.mjs';

const report = await runExperiment({
  cases: assistantQualityCases,
  variants: ['A', 'B', 'C', 'D', 'E'],
  repeats: 3,
  seed: 'quality-lab-v1',
  mode: 'live',
  model: 'corp-openai-gpt-4.1-mini',
  modelRevision: 'operator-pinned-v1',
  temperature: 0.1,
  complete,
  outputDir: '.omk/runs/assistant-quality-live',
  resume: false,
  limits: {
    concurrency: 2, maxRepairs: 1, timeoutMs: 60000,
    maxCalls: 648, maxInputTokens: 16000, maxOutputTokens: 2400,
    maxTotalTokens: 11923200, maxResponseBytes: 65536,
  },
  price: { inputUsdPerToken: 4e-7, outputUsdPerToken: 1.6e-6 },
});
```

Цена в примере предоставлена оператором для указанной модели, это не встроенный
тариф. `price` необязателен; при отсутствии цены или usage хотя бы одного вызова
`costUsd=null`. При полном usage получается estimate по переданной цене,
не billing reconciliation. Неуспешные вызовы тоже расходуют reservation.

Adapter экспортирует `async function complete(request)`:

```js
// request: { model, temperature, messages, maxOutputTokens, signal, metadata }
// metadata: { caseId, variant, repeat, stage, attempt, scope }
// return:
{
  content: '{"status":"unresolved","candidateId":null}',
  usage: { inputTokens: 123, outputTokens: 15 }, // необязательно, только фактическое usage
  providerModel: 'gpt-4.1-mini-2025-04-14' // необязательно; actual provider revision
}
```

`content` содержит strict JSON, не object и не markdown. Все лишние поля contract
отклоняются. При `binding` разрешены только `{status,candidateId}`; при
`materialize` только `{status,result}`. `status` равен `accepted` или `unresolved`;
при unresolved второе поле обязательно `null`. Полная схема результата включена
в системный prompt и проверяется runner: `rows`, `hierarchy`, `edges`, `identities`.

Adapter обязан соблюдать `signal`, передавать output-token bound провайдеру,
отключить собственные retries и маскировать диагностику. Конфигурация endpoint,
key-file и fetch принадлежит adapter, не runner. Optional ключ должен читаться
только при live invocation; offline/dry-run должны работать без него. Adapter
не должен импортировать fixtures/oracle. `modelRevision` является утверждением
оператора: alias без зафиксированного deployment не доказывает immutable модель.
При изменении реализации/config adapter меняйте `modelRevision`; исходный код
внешнего adapter автоматически не хешируется.

`providerModel` сохраняется в `call_finished` и агрегируется в `providerModels`.
Разрешён только безопасный model ID до 120 символов: буквы, цифры, `_`, `.`, `/`,
`-`, начало с буквы/цифры; URL/query/header и управляющие символы отклоняются.
После первого наблюдаемого providerModel его смена открывает circuit с
`model_mismatch`. Отсутствующий providerModel не выдумывается. Optional `model`
в ответе adapter, в отличие от `providerModel`, должен точно совпадать с alias
в request; proxy adapters обычно не возвращают `model` и используют providerModel.

```bash
node scripts/assistant-quality-lab.mjs --mode live \
  --adapter scripts/assistant-quality-openai.mjs \
  --model corp-openai-gpt-4.1-mini --model-revision operator-pinned-v1 \
  --repeats 3 --temperature 0.1 --max-output-tokens 2400 \
  --max-calls 648 --max-total-tokens 11923200 \
  --input-usd-per-token 0.0000004 --output-usd-per-token 0.0000016 \
  --output-dir .omk/runs/assistant-quality-live
```

Встроенный `scripts/assistant-quality-openai.mjs` читает `LITELLM_BASE_URL` и
`LITELLM_API_KEY_FILE` (либо `LITELLM_API_KEY`) только при live-вызове. Передавайте
существующий путь секрета через окружение; не включайте ключ в команду или отчет.
Для удаленного endpoint нужен HTTPS; HTTP разрешен только на loopback. Redirect
отклоняется, output bound передается провайдеру, HTTP body ограничен 256 KiB.
Live-вызовы unit-тестами или offline-командой не выполняются.

## Ограничения и evidence

- `concurrency` <= 2, `maxRepairs` <= 1, repeats <= 100; недопустимые настройки
  отклоняются, silent clamp отсутствует. Остальные bounds явно настраиваются
  API или CLI (`--timeout-ms`, `--max-input-tokens`, `--max-response-bytes` и т.д.).
- Admission использует UTF-8 bytes + 64/message как консервативную оценку input
  tokens, плюс полный output budget. Это не измерение tokenizer. Превышение
  фактического usage останавливает дальнейшие вызовы; adapter должен соблюдать
  protocol limits. Response bytes ограничиваются после ответа; ограничение
  чтения HTTP body до получения полного ответа принадлежит adapter.
- Таймаут abort-ит вызов и открывает общий circuit: новых вызовов/repair больше
  нет. Уже стартовавший второй вызов может завершиться. Adapter, игнорирующий
  AbortSignal, нельзя считать безопасным для live.
- `manifest.json` фиксирует cases/input/oracle hashes, model/revision, seed,
  temperature, limits, price и hash реализации runner. `events.jsonl` сохраняет
  call reservations, request hashes, sanitized stage checkpoints, usage и codes.
  `results.json` содержит итоговые metrics/report и заменяется атомарно.
- Raw model responses, provider exception messages, headers, URLs, ключи и
  prompts не сохраняются. Сохраняемые model IDs сверяются с synthetic input;
  invalid JSON оставляет только фиксированный code. JSONL имеет последовательность
  и hash integrity, но не является криптографически доверенным remote журналом.
- Повторите ту же команду с `--resume`: завершённые стадии не вызывают модель
  снова; зарезервированные calls/tokens учитываются. Любое изменение freeze
  требует новой output directory. Незавершённый `call_started` становится
  `interrupted_call`, без скрытого повторного расходования. Truncated/corrupt
  journal отклоняется; не редактируйте его для обхода billing uncertainty.
- Один процесс-владелец на output directory. Concurrent writers не поддержаны.
  Выбирайте отдельные директории для независимых прогонов.
- stdout содержит JSON report; `--diagnostics Basic|Verbose` добавляет безопасные
  structured events в stderr, default `off`. `onEvent(event)` в API позволяет
  маршрутизировать тот же поток в основной logging pipeline. Callback обязан
  быть синхронным и не бросать исключений. Artifacts не заменяют operational
  log sink production backend; runtime/logging gates сервиса здесь не изменяются.
- Метрики раздельны по variant и development/holdout. Проверяются row-ID sets
  и multisets, cardinality, parent-child tuples, edge ID+ends+direction, instance
  identity, bindingExact, false acceptance, unresolved, first-pass exact, repairs.
  `callLatencyMs` содержит p50/p95 и сумму длительностей model calls, а не время
  UI или полного pipeline. `measuredUsage` по группе учитывает только полученное
  usage; полноту учета проверяйте по общему `budget.usageComplete`.
  Transport errors, invalid JSON/contract, exhausted repairs, timeout и admission
  denial имеют result `status=failed`, `evaluation.failed=true` и отдельный
  счётчик `failures`; `unresolved` и `correctAbstention` для них всегда false.
  `unresolved` учитывает только валидный ответ модели на binding или materialize.
  Ошибки формата модели остаются видимыми failures: условную `exactRate` нельзя
  интерпретировать без них. Sandbox network failures не являются свидетельством
  качества модели, даже если все calls исчерпаны. Старые artifacts сохраняются
  неизменными; пересчёт scoring требует отдельного отчёта с исходным hash и новым
  hash реализации scoring, без повторного обращения к модели.
  Claims productionPipeline/causalConclusion остаются `unavailable`, даже когда
  live stagePilot помечен `tested`. 12 кейсов и 3 repeats не дают сами по себе
  статистически обоснованного вывода о качестве production Assistant.

Acceptance scope: focused harness contracts. Unit-тесты проверяют вручную заданные
результаты, негативные мутации, leakage, permutation, budget/timeout, pricing,
resume и CLI. Browser/runtime smoke не требуется: production/UI-код не изменён.

## Повтор Настоящего Этапа Сопоставления

`scripts/assistant-binding-replay.mjs` использует production-функции подготовки
binding-intent messages, нормализации и проверки ответа. Это отдельный инструмент,
не synthetic runner. На вход подается замороженный JSON `mappingInput`: `prompt`,
`placements`, `relationRules`, `businessBlockManifest`, `d2StructuralModel`,
`d2SemanticModel`. Второй файл содержит снимок `assistant.prompt` runtime-конфига
без секретов. Не заменяйте их текущими данными посреди сравнения.

```bash
node scripts/assistant-binding-replay.mjs \
  --input .omk/runs/experiment/binding-input.json \
  --runtime-config .omk/runs/experiment/runtime-prompts.json \
  --output-dir .omk/runs/experiment/binding-dry

node scripts/assistant-binding-replay.mjs \
  --input .omk/runs/experiment/binding-input.json \
  --runtime-config .omk/runs/experiment/runtime-prompts.json \
  --output-dir .omk/runs/experiment/binding-batches \
  --batch-size 6 --max-output-tokens 2400 --timeout-ms 120000 --live
```

Без `--live` вызовов нет. `batch-size=0` повторяет единый запрос по незавершенным
целям; положительное число разделяет цели на пакеты, сохраняя общий контекст.
При объединении ответы ограничиваются целями запроса, как в production;
оставшиеся пропуски проверяются глобальным валидатором. Число пакетов ограничено
32; автоматических correction retries нет. Для второго прогона задайте другую
директорию: отчет существующего прогона не перезаписывается.

Инструмент не выполняет CMDB-запросы, Save, Apply, Publish или построение диаграммы.
Нормализованный ответ содержит имена и семантику реального шаблона, поэтому
отчеты храните в `.omk/runs` с ограниченным доступом, не в публичной документации.
`success=true` означает лишь принятие binding-контракта, не правильность строк,
подписей, иерархии или стрелок. Доказательство улучшения полного pipeline требует
отдельного исполнения и сравнения с независимым эталоном.
