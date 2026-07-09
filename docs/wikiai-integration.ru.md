# Интеграция cmdbdynamicpages с WikiAI

## Назначение

Эта статья фиксирует deployment-договоренности между `cmdbdynamicpages`,
MediaWiki и WikiAI.

MediaWiki остается источником модерируемого статического текста и прав на
страницу. `cmdbdynamicpages` отдает business-data либо как явно опубликованный
`staticSnapshot`, либо live под текущей CMDBuild-сессией пользователя.

## Reverse Proxy

Все пользовательские маршруты должны быть доступны через один origin:

```text
/wiki/* или обычные wiki routes    -> MediaWiki
/api/v1/* и /api/*                 -> WikiAI Gateway
/cmdbuild/dynamicpages/*           -> cmdbdynamicpages
/cmdbuild/custom-api/*             -> cmdbdynamicpages
```

Proxy должен пробрасывать `Cookie`, `Authorization`, `X-Forwarded-*` и request
id/correlation id. Browser-код использует относительные URL и не обращается к
внутренним портам напрямую.

## Auth Model

`cmdbdynamicpages` не читает cookie из JavaScript. Backend получает
`CMDBuild-Authorization` на same-origin route и валидирует его через CMDBuild.

WikiAI Gateway валидирует пользователя отдельно через MediaWiki cookie или OIDC
Bearer. Нельзя передавать username/groups из frontend как доверенный источник
прав.

## Встраивание В MediaWiki

Динамический блок должен быть явным marker, а не произвольной ссылкой на
runtime URL:

```wiki
{{#cmdb:
 |template=AssetsByOwner
 |owner={{PAGENAME}}
 |mode=widget
}}
```

Допустим и template wrapper:

```wiki
{{CmdbPage
 |template=AssetsByOwner
 |owner={{PAGENAME}}
}}
```

WikiAI Syncer детектирует такие markers и пытается получить anonymous JSON
snapshot. Ссылки вида `/cmdbuild/dynamicpages/ui/run/...` сами по себе не
считаются индексируемым блоком.

## Anonymous Content

Anonymous content для WikiAI означает только опубликованный `staticSnapshot`.
При запросе без CMDBuild cookie runtime читает Redis snapshot и возвращает
`snapshotFound=true` или `snapshotFound=false`.

Если snapshot найден, WikiAI может записать его как дополнительный chunk
родительской MediaWiki-страницы. Chunk наследует доступ этой MediaWiki-страницы.
CMDBuild ACL для snapshot не проверяется, потому что результат уже был явно
опубликован в `cmdbdynamicpages`.

Если snapshot отсутствует, WikiAI индексирует только status/metadata, без
runtime rows.

## dynamicUser

`dynamicUser` страницы не синхронизируются в общий индекс ни под service user,
ни под admin, ни под произвольным пользователем. Причины:

- результат зависит от текущей CMDBuild-сессии;
- endpoint params могут менять набор данных;
- cache strategy может быть `permissionOnly`, `visibilityHash`, `privateUser`
  или `disabled`;
- запись результата одного пользователя в общий индекс нарушит ACL.

Live user-dependent runtime может использоваться только как transient context
для текущего пользователя и только через server-side adapter, который валидирует
CMDBuild session.

## Исключения

`endpoint.kind=baaVerification` является POST-only verification endpoint. Он не
является HTML/runtime page, не публикуется как static view snapshot и не
индексируется WikiAI как dynamic block.

## Diagnostics And Logs

Диагностический режим остается выключенным по умолчанию и включается
конфигурацией: `CMDP_DIAGNOSTIC_MODE=Basic|Verbose`. В логи нельзя писать
`cookie`, `authorization`, `CMDBuild-Authorization`, CSRF token, Redis password,
секретные query params и raw runtime rows.

Связанный контракт на стороне WikiAI: `docs/contracts/cmdbdynamicpages-wikiai.md`.
