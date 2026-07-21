# Историческое руководство: MediaWiki и CMDB Dynamic Pages

**Контекст:** этот документ задает поддерживаемую границу интеграции MediaWiki с динамическими страницами CMDBuild. Он не является контрактом runtime, proxy или владения портами `cmdbcustompages`; внешние сервисы разворачиваются отдельно.

**Статус:** поддерживаемый аутентифицированный поток - browser CMDBuild session на same-origin маршрутах проекта. Документ намеренно не задает протокол передачи credentials из MediaWiki.

## Поддерживаемая Browser Session

`CMDP_PUBLIC_ORIGIN` - единственный public browser origin для CMDBuild UI и маршрутов проекта под `/cmdbuild/*`. Внутренний `CMDBUILD_ORIGIN` используется только backend и не должен попадать в browser URL, redirect или cookie domain.

Поддерживаемая последовательность:

1. Пользователь входит в CMDBuild через `CMDP_PUBLIC_ORIGIN`.
2. Browser автоматически отправляет существующую HttpOnly session cookie `CMDBuild-Authorization` для совпадающих same-origin запросов к `/cmdbuild/*`.
3. `cmdbdynamicpages` проверяет эту существующую session и использует ее только в своих server-side CMDBuild REST requests.
4. Browser открывает `/cmdbuild/dynamicpages/ui/designer` или `/cmdbuild/dynamicpages/ui/run/<templateCode>`.

JavaScript и MediaWiki PHP не читают, не создают, не копируют и не пересылают CMDBuild session cookie. `cmdbdynamicpages` не принимает identity headers MediaWiki, group claims или пользовательские credentials, созданные MediaWiki.

## Роль MediaWiki

MediaWiki может отрисовать обычную browser-ссылку на поддерживаемый public route под `CMDP_PUBLIC_ORIGIN`. После перехода пользователь открывает CMDBuild и CMDB Dynamic Pages напрямую в browser, где действует уже установленная CMDBuild session.

MediaWiki не должен выполнять server-side backend requests от имени пользователя. Не добавляйте user или group identity headers, не пересылайте cookies и не передавайте authorization credentials из MediaWiki request в `cmdbdynamicpages`.

External TLS reverse proxy обязан сохранить public `Host`, `X-Forwarded-Host` и `X-Forwarded-Proto=https` для CMDBuild UI и маршрутов `cmdbdynamicpages`. MediaWiki-specific proxy path не заменяет поддерживаемый browser session path.

## Неподдерживаемые Потоки

Репозиторий не предоставляет протокол, который позволяет MediaWiki impersonate пользователя CMDBuild, обменять MediaWiki session на CMDBuild session или переслать пользовательские credentials в backend. Cross-system identity design требует отдельного implementation и review; его нельзя выводить из этого документа.

Server-rendered HTML fetch, MediaWiki API relay и custom token pass-through не входят в поддерживаемую integration surface `cmdbcustompages`.

## Проверка Оператора

1. Настроить единый `CMDP_PUBLIC_ORIGIN` для CMDBuild UI и project-owned маршрутов `/cmdbuild/*`.
2. Войти в CMDBuild через этот public origin.
3. Открыть в browser Designer или Runtime route и подтвердить, что существующая CMDBuild session принята.
4. Если session отсутствует или невалидна, направить пользователя на CMDBuild sign-in. Не добавлять MediaWiki server-side relay.
