# Руководство по интеграции внешних сервисов в MediaWiki

**Контекст:** интеграция динамических страниц CMDBuild (custompages) в MediaWiki.
**Дата:** 2026-06-02
**Статус:** архитектурная рекомендация (ADR).

---

## 1. Почему iframe считается устаревшим и небезопасным подходом

Использование HTML-тега `<iframe>` для встраивания одного корпоративного приложения в другое — это архитектурный антипаттерн.

### 1.1 Угрозы безопасности

| Угроза | Описание |
|--------|----------|
| **Clickjacking** | Злоумышленник накладывает прозрачный слой поверх iframe и перехватывает клики. |
| **XSS через postMessage** | Отсутствие валидации `event.origin` позволяет внедрить вредоносный код. |
| **Утечка referrer** | URL внутри iframe, содержащий токены, утекает в заголовке `Referer`. |
| **Cookie leaking** | При XSS на родительской странице возможен перехват сессии через side-channel. |

### 1.2 Технические ограничения современных браузеров

- **Third-party cookie deprecation** — Chrome, Safari и Firefox блокируют cross-site куки.
- **SameSite=Lax/Strict** — куки не будут отправлены во фрейм на другом поддомене.
- **CSP frame-ancestors** — требует явного белого списка; ошибка = чёрный экран.
- **Partitioned cookies (CHIPS)** — изолирует куки в iframe по top-level сайту.

---

## 2. Варианты интеграции с конкретной реализацией

### 2.1 Вариант B — Same-origin proxy через nginx

Все сервисы доступны через один домен с разными path. Браузер видит единый origin — нет CORS, куки шарятся.

#### Шаг 1. Конфигурация nginx

```nginx
server {
    listen 443 ssl http2;
    server_name corp.local;

    # MediaWiki
    location /wiki/ {
        proxy_pass http://mediawiki:8080/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # cmdbcustompages backend
    location /custom/ {
        proxy_pass http://cmdbcustompages:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-User-Name $http_x_user_name; # опционально
        proxy_set_header Cookie $http_cookie;
    }

    # CMDBuild REST API
    location /cmdb/ {
        proxy_pass http://cmdbuild:8080/;
        proxy_set_header Host $host;
        proxy_set_header Cookie $http_cookie;
    }
}
```

#### Шаг 2. Настройка MediaWiki

В `LocalSettings.php` укажите правильный base URL:

```php
$wgServer = 'https://corp.local/wiki';
$wgScriptPath = '/wiki';
$wgArticlePath = '/wiki/$1';
```

#### Шаг 3. Встраивание контента без iframe

В Special Page или JS-виджете обращайтесь к backend через `/custom/api/...` (тот же origin).

---

### 2.2 Вариант C — Special Page Extension (BEST PRACTICE)

Создаём PHP-расширение MediaWiki, которое делает server-side запрос к backend и рендерит HTML внутри вики-страницы.

#### Структура расширения

```
extensions/CmdbCustomPages/
├── extension.json
├── i18n/
│   └── ru.json
├── includes/
│   ├── SpecialCmdbCustomPages.php
│   └── ApiCmdbCustomPages.php
└── modules/
    ├── ext.cmdbcustompages.js
    └── ext.cmdbcustompages.css
```

#### Файл extension.json

```json
{
    "name": "CmdbCustomPages",
    "version": "1.0.0",
    "author": "Your Team",
    "url": "https://corp.local/wiki/Special:CmdbCustomPages",
    "descriptionmsg": "cmdbcustompages-desc",
    "license-name": "MIT",
    "type": "other",
    "requires": {
        "MediaWiki": ">= 1.39.0"
    },
    "AutoloadClasses": {
        "SpecialCmdbCustomPages": "includes/SpecialCmdbCustomPages.php",
        "ApiCmdbCustomPages": "includes/ApiCmdbCustomPages.php"
    },
    "SpecialPages": {
        "CmdbCustomPages": "SpecialCmdbCustomPages"
    },
    "APIModules": {
        "cmdbcustompages": "ApiCmdbCustomPages"
    },
    "ExtensionMessagesFiles": {
        "CmdbCustomPagesAlias": "i18n/CmdbCustomPages.alias.php"
    },
    "MessagesDirs": {
        "CmdbCustomPages": [
            "i18n"
        ]
    },
    "ResourceModules": {
        "ext.cmdbcustompages": {
            "scripts": [
                "modules/ext.cmdbcustompages.js"
            ],
            "styles": [
                "modules/ext.cmdbcustompages.css"
            ],
            "dependencies": [
                "mediawiki.api",
                "mediawiki.user"
            ]
        }
    },
    "ResourceFileModulePaths": {
        "localBasePath": "",
        "remoteExtPath": "CmdbCustomPages"
    },
    "GroupPermissions": {
        "*": {
            "cmdbcustompages-read": false
        },
        "user": {
            "cmdbcustompages-read": true
        },
        "sysop": {
            "cmdbcustompages-read": true,
            "cmdbcustompages-admin": true
        }
    },
    "AvailableRights": [
        "cmdbcustompages-read",
        "cmdbcustompages-admin"
    ],
    "manifest_version": 2
}
```

#### Файл includes/SpecialCmdbCustomPages.php

```php
<?php

class SpecialCmdbCustomPages extends SpecialPage {

    public function __construct() {
        parent::__construct('CmdbCustomPages', 'cmdbcustompages-read');
    }

    public function execute($subpage) {
        $this->setHeaders();
        $out = $this->getOutput();
        $user = $this->getUser();

        // Проверка прав
        if (!$user->isAllowed('cmdbcustompages-read')) {
            throw new PermissionsError('cmdbcustompages-read');
        }

        $page = $subpage ?: 'dashboard';
        $backendUrl = 'http://cmdbcustompages:3000/api/page/' . urlencode($page);

        // Server-side HTTP-запрос к backend
        $http = MediaWiki\\MediaWikiServices::getInstance()->getHttpRequestFactory();
        $req = $http->create(
            $backendUrl,
            ['method' => 'GET', 'timeout' => 30],
            __METHOD__
        );
        $req->setHeader('X-User-Name', $user->getName());
        $req->setHeader('X-Groups', implode(',', $user->getGroups()));
        $req->setHeader('Accept', 'application/json');

        $status = $req->execute();
        if (!$status->isOK()) {
            $out->addHTML('<div class="error">Сервис временно недоступен</div>');
            return;
        }

        $response = json_decode($req->getContent(), true);
        if (empty($response['html'])) {
            $out->addHTML('<div class="error">Пустой ответ от сервиса</div>');
            return;
        }

        // Подключаем CSS и JS через ResourceLoader
        $out->addModules('ext.cmdbcustompages');

        // Рендерим контент (фильтрация опциональна)
        $out->addHTML('<div class="cmdb-custompages-container">');
        $out->addHTML($response['html']);
        $out->addHTML('</div>');
    }

    protected function getGroupName() {
        return 'other';
    }
}
```

#### Файл includes/ApiCmdbCustomPages.php

```php
<?php

class ApiCmdbCustomPages extends ApiBase {

    public function execute() {
        $user = $this->getUser();
        $page = $this->getMain()->getVal('page', 'dashboard');

        $backendUrl = 'http://cmdbcustompages:3000/api/data/' . urlencode($page);
        $http = MediaWiki\\MediaWikiServices::getInstance()->getHttpRequestFactory();
        $req = $http->create($backendUrl, ['method' => 'GET', 'timeout' => 15], __METHOD__);
        $req->setHeader('X-User-Name', $user->getName());

        $status = $req->execute();
        if (!$status->isOK()) {
            $this->dieWithError('apierror-cmdbcustompages-unavailable');
        }

        $data = json_decode($req->getContent(), true);
        $this->getResult()->addValue(null, 'cmdb', $data);
    }

    public function getAllowedParams() {
        return [
            'page' => [
                ApiBase::PARAM_TYPE => 'string',
                ApiBase::PARAM_DEFAULT => 'dashboard',
            ],
        ];
    }

    public function mustBePosted() {
        return false;
    }
}
```

#### Файл modules/ext.cmdbcustompages.js

```javascript
( function () {
    'use strict';

    var api = new mw.Api();

    /**
     * Монтирует виджет cmdbcustompages в указанный контейнер.
     * @param {string} containerId
     * @param {Object} options
     */
    function mount( containerId, options ) {
        var container = document.getElementById( containerId );
        if ( !container ) {
            return;
        }

        container.innerHTML = '<div class="cmdb-loading">Загрузка...</div>';

        api.get( {
            action: 'cmdbcustompages',
            page: options.page || 'dashboard',
            format: 'json'
        } ).then( function ( data ) {
            container.innerHTML = renderWidget( data.cmdb );
        } ).catch( function () {
            container.innerHTML = '<div class="error">Ошибка загрузки данных</div>';
        } );
    }

    function renderWidget( data ) {
        var html = '<table class="cmdb-data-table">';
        html += '<thead><tr><th>Параметр</th><th>Значение</th></tr></thead>';
        html += '<tbody>';
        Object.keys( data || {} ).forEach( function ( key ) {
            html += '<tr><td>' + mw.html.escape( key ) + '</td>' +
                    '<td>' + mw.html.escape( String( data[ key ] ) ) + '</td></tr>';
        } );
        html += '</tbody></table>';
        return html;
    }

    mw.cmdbCustomPages = { mount: mount };

}() );
```

#### Файл modules/ext.cmdbcustompages.css

```css
.cmdb-custompages-container {
    border: 1px solid #c8ccd1;
    padding: 1em;
    background: #f8f9fa;
}

.cmdb-data-table {
    width: 100%;
    border-collapse: collapse;
}

.cmdb-data-table th,
.cmdb-data-table td {
    border: 1px solid #a2a9b1;
    padding: 0.5em;
    text-align: left;
}

.cmdb-loading {
    color: #72777d;
    font-style: italic;
}
```

#### Активация расширения

В `LocalSettings.php`:

```php
wfLoadExtension('CmdbCustomPages');
```

После установки страница доступна по адресу:
`https://corp.local/wiki/Special:CmdbCustomPages/dashboard`

---

### 2.3 Вариант D — API-first + клиентский JS-виджет

Если контент сильно интерактивен (фильтры, поиск, real-time), backend отдаёт только JSON, а рендеринг происходит в браузере.

Используем тот же `ApiCmdbCustomPages` (см. выше), но без SpecialPage. Вместо этого создаём **Parser hook** — тег, который можно вставить прямо в вики-страницу:

#### Добавление тега `<cmdbwidget>`

В `extension.json` добавляем hooks:

```json
"Hooks": {
    "ParserFirstCallInit": [
        "CmdbCustomPagesHooks::onParserFirstCallInit"
    ]
}
```

Создаём `includes/CmdbCustomPagesHooks.php`:

```php
<?php

class CmdbCustomPagesHooks {

    public static function onParserFirstCallInit( Parser $parser ) {
        $parser->setHook('cmdbwidget', [self::class, 'renderCmdbWidget']);
    }

    public static function renderCmdbWidget( $input, array $args, Parser $parser, PPFrame $frame ) {
        $parser->getOutput()->addModules('ext.cmdbcustompages');
        $page = htmlspecialchars( $args['page'] ?? 'dashboard', ENT_QUOTES );
        $id = 'cmdb-widget-' . $page . '-' . wfRandomString( 4 );
        return '<div id="' . $id . '" class="cmdb-widget" data-page="' . $page . '"></div>' +
               '<script>(function(){ if(mw.cmdbCustomPages){ mw.cmdbCustomPages.mount("' . $id . '", {page:"' . $page . '"}); } })();</script>';
    }
}
```

Теперь редакторы могут вставлять в статью:

```wiki
== Мой дашборд ==
<cmdbwidget page="incidents" />
```

#### Обновление JS для авто-инициализации

```javascript
( function () {
    'use strict';

    var api = new mw.Api();

    function mount( containerId, options ) {
        var container = document.getElementById( containerId );
        if ( !container ) { return; }
        container.innerHTML = '<div class="cmdb-loading">Загрузка...</div>';

        api.get( {
            action: 'cmdbcustompages',
            page: options.page || 'dashboard',
            format: 'json'
        } ).then( function ( data ) {
            container.innerHTML = renderWidget( data.cmdb );
        } ).catch( function () {
            container.innerHTML = '<div class="error">Ошибка загрузки</div>';
        } );
    }

    function renderWidget( data ) {
        var html = '<table class="cmdb-data-table"><thead><tr>';
        html += '<th>Ключ</th><th>Значение</th>';
        html += '</tr></thead><tbody>';
        Object.keys( data || {} ).forEach( function ( key ) {
            html += '<tr><td>' + mw.html.escape( key ) + '</td>' +
                    '<td>' + mw.html.escape( String( data[ key ] ) ) + '</td></tr>';
        } );
        html += '</tbody></table>';
        return html;
    }

    // Авто-инициализация всех виджетов на странице
    function init() {
        var widgets = document.querySelectorAll('.cmdb-widget');
        widgets.forEach( function ( el ) {
            var page = el.getAttribute('data-page') || 'dashboard';
            mount( el.id, { page: page } );
        } );
    }

    mw.cmdbCustomPages = { mount: mount, init: init };

    // Запускаем после загрузки DOM
    if ( document.readyState === 'loading' ) {
        document.addEventListener( 'DOMContentLoaded', init );
    } else {
        init();
    }

}() );
```

---

### 2.4 Вариант E — SSO + JWT (Keycloak / Active Directory)

Для распределённых команд с несколькими поддоменами.

#### Схема

1. Пользователь аутентифицируется в MediaWiki через SAML/OIDC (плагин PluggableAuth).
2. MediaWiki Extension получает JWT от IdP (или генерирует service token).
3. При server-side запросе к backend передаётся заголовок `Authorization: Bearer <JWT>`.
4. Backend валидирует JWT через JWKS endpoint IdP.

#### Пример передачи JWT в Special Page

```php
public function execute($subpage) {
    $user = $this->getUser();
    $jwt = $this->getUserJWT(); // получено из сессии или IdP callback

    $req = $http->create($backendUrl, ['method' => 'GET', 'timeout' => 30], __METHOD__);
    $req->setHeader('Authorization', 'Bearer ' . $jwt);
    $req->setHeader('X-User-Name', $user->getName());

    // ... остальная логика
}
```

#### Конфигурация backend (cmdbcustompages) для валидации JWT

```javascript
// middleware/auth.js (Node.js)
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const client = jwksClient({ jwksUri: 'https://keycloak.corp/realms/corp/protocol/openid-connect/certs' });

function getKey(header, callback) {
    client.getSigningKey(header.kid, function(err, key) {
        const signingKey = key.getPublicKey();
        callback(null, signingKey);
    });
}

function verifyToken(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).send('Unauthorized');

    jwt.verify(token, getKey, { algorithms: ['RS256'] }, (err, decoded) => {
        if (err) return res.status(403).send('Forbidden');
        req.user = decoded;
        next();
    });
}
```

---

## 2.5 Варианты для редактора: динамические ссылки и виджеты без администратора

Все варианты выше требуют правки PHP-кода со стороны администратора. Но редактору страницы нужно вставить ссылку на динамическую страницу cmdbcustompages с параметрами, которые зависят от контекста текущей статьи.

Ниже — решения, которые админ настраивает один раз, а редакторы используют через обычную вики-разметку.

### 2.5.1 Template + Magic Words (простейший)

Администратор создаёт шаблон Template:CmdbPage через вики-интерфейс. Редакторы вставляют его в статьи.

Template:CmdbPage:
```wiki
<includeonly>
<cmdbwidget page="{{{page|dashboard}}}" filter="{{{filter|}}}" context="{{{context|{{PAGENAME}}}}}" />
[https://custompages.corp/view/{{{page|dashboard}}}?ctx={{urlencode:{{PAGENAME}}}}&filter={{urlencode:{{{filter|}}}}}
 Открыть в CMDB]
</includeonly>
```

Редактор вставляет:
```wiki
{{CmdbPage
|page=incidents
|filter=status:open
|context={{PAGENAME}}
}}
```

Плюсы: Ноль правок extension.php. Параметры берутся из стандартных Magic Words.
Минусы: Нет валидации — редактор может вставить произвольный текст в filter. XSS-риск, если extension не делает htmlspecialchars на выходе.

---

### 2.5.2 Parser Function {{#cmdb:...}} (рекомендуется)

Администратор один раз добавляет Parser Function в extension. Редакторы пишут:

```wiki
{{#cmdb:
 |page=incidents
 |filter=status:open
 |parent={{PAGENAME}}
 |user={{CURRENTUSER}}
 |mode=widget
}}
```

#### Реализация в extension

Добавить в includes/CmdbCustomPagesHooks.php:

```php
<?php

class CmdbCustomPagesHooks {

    public static function onParserFirstCallInit( Parser $parser ) {
        $parser->setHook('cmdbwidget', [self::class, 'renderCmdbWidget']);
        $parser->setFunctionHook('cmdb', [self::class, 'renderCmdbParserFunction']);
    }

    public static function renderCmdbWidget( $input, array $args, Parser $parser, PPFrame $frame ) {
        $parser->getOutput()->addModules('ext.cmdbcustompages');
        $page = htmlspecialchars( $args['page'] ?? 'dashboard', ENT_QUOTES );
        $id = 'cmdb-widget-' . $page . '-' . wfRandomString( 4 );
        return '<div id="' . $id . '" class="cmdb-widget" data-page="' . $page . '"></div>';
    }

    public static function renderCmdbParserFunction( Parser $parser, PPFrame $frame, array $args ) {
        $params = self::parseArgs( $frame, $args );

        $allowedPages = ['dashboard', 'incidents', 'assets', 'contracts'];
        $page = in_array($params['page'] ?? '', $allowedPages) ? $params['page'] : 'dashboard';

        $filter = preg_replace('/[^a-zA-Z0-9_\-:]/', '', $params['filter'] ?? '');
        $parent = preg_replace('/[^a-zA-Z0-9_\-]/', '', $params['parent'] ?? '');
        $mode = in_array($params['mode'] ?? '', ['link', 'widget', 'both']) ? $params['mode'] : 'both';

        $secret = $GLOBALS['wgCmdbCustomPagesSecret'] ?? 'REPLACE_ME';
        $sig = hash_hmac('sha256', $page . '|' . $filter . '|' . $parent, $secret);

        $url = '/custom/api/page/' . urlencode($page)
             . '?filter=' . urlencode($filter)
             . '&parent=' . urlencode($parent)
             . '&sig=' . $sig;

        $html = '';
        if ($mode === 'link' || $mode === 'both') {
            $html .= '<a href="' . htmlspecialchars($url) . '" class="cmdb-external-link" target="_blank">'
                   . 'Открыть в CMDB'
                   . '</a>';
        }
        if ($mode === 'widget' || $mode === 'both') {
            $parser->getOutput()->addModules('ext.cmdbcustompages');
            $id = 'cmdb-pf-' . $page . '-' . wfRandomString( 4 );
            $html .= '<div id="' . $id . '" class="cmdb-widget" data-page="' . $page . '" '
                   . 'data-filter="' . htmlspecialchars($filter) . '" '
                   . 'data-parent="' . htmlspecialchars($parent) . '" '
                   . 'data-sig="' . $sig . '"></div>';
        }

        return [$html, 'noparse' => false, 'isHTML' => true];
    }

    private static function parseArgs( PPFrame $frame, array $args ): array {
        $params = [];
        foreach ($args as $arg) {
            $parts = explode('=', $frame->expand($arg), 2);
            if (count($parts) === 2) {
                $params[trim($parts[0])] = trim($parts[1]);
            }
        }
        return $params;
    }
}
```

В extension.json добавить:
```json
"Hooks": {
    "ParserFirstCallInit": [
        "CmdbCustomPagesHooks::onParserFirstCallInit"
    ]
}
```

В LocalSettings.php:
```php
$wgCmdbCustomPagesSecret = getenv('CMDB_CUSTOMPAGES_SECRET');
```

Почему это лучше Template: валидация whitelist, регулярки на параметры, HMAC-подпись. Редактор не может подменить URL на произвольный.

---

### 2.5.3 Interwiki link + динамический шаблон

Администратор добавляет Interwiki-префикс (через БД или LocalSettings.php):

```sql
INSERT INTO interwiki (iw_prefix, iw_url, iw_api, iw_wikiid, iw_local, iw_trans)
VALUES ('cmdb', 'https://custompages.corp/view/$1', '', 0, 1, 0);
```

Редактор может писать:
```wiki
[[cmdb:incidents|Инциденты]]
```

Но Magic Words ({{PAGENAME}}) внутри interwiki-URL не раскрываются автоматически. Поэтому interwiki работает только через шаблон-обёртку:

```wiki
{{CmdbLink
|page=incidents
|ctx={{PAGENAME}}
|user={{CURRENTUSER}}
}}
```

Плюсы: Стандартный вики-синтаксис.
Минусы: Нет встроенной валидации; не подходит для виджетов.

---

### 2.5.4 Semantic MediaWiki (SMW)

Если в вашей вики установлен Semantic MediaWiki (как в проекте wikiAI), параметры берутся из семантических свойств страницы.

На странице заданы свойства:
```wiki
[[Has asset type::Server]]
[[Has status::Active]]
[[Has owner::Ivanov]]
```

Редактор вставляет (или шаблон сам генерирует):
```wiki
{{#cmdb:
 |page=assets
 |filter=type:{{#property:Has asset type}};status:{{#property:Has status}}
 |owner={{#property:Has owner}}
 |mode=widget
}}
```

Или через #ask:
```wiki
{{#ask:[[Has asset type::Server]]
 |?Has status
 |format=template
 |template=CmdbSmwWidget
}}
```

Плюсы: Полная автоматизация — редактор вообще не указывает параметры.
Минусы: Требуется SMW и настроенная семантическая схема.

---

### 2.5.5 PageForms

Если используется расширение PageForms (упоминалось в roadmap wikiAI):

Форма Form:AssetCmdb:
```wiki
{{{for template|CmdbPage}}}
{{{field|page|hidden|default=assets}}}
{{{field|filter|hidden|default=type:{{#property:Has asset type}}}}}
{{{field|context|hidden|default={{PAGENAME}}}}}
{{{end template}}}
```

Редактор нажимает "Create with form" — параметры подставляются автоматически.

---

### 2.5.6 Сравнение вариантов для редактора

| Критерий | Template + Magic Words | Parser Function {{#cmdb:}} | Interwiki | SMW | PageForms |
|----------|:----------------------:|:--------------------------:|:---------:|:---:|:---------:|
| Нужен PHP-код | Нет | Один раз | Один раз | Нет | Нет |
| Валидация параметров | Нет | Whitelist + regex | Нет | Через свойства | Через форму |
| Защита от подделки URL | Нет | HMAC | Нет | Через свойства | Через форму |
| Подходит для виджетов | Да | Да | Только ссылка | Да | Да |
| Зависимость от контекста | {{PAGENAME}} | {{PAGENAME}} | Через шаблон | Свойства SMW | Свойства SMW |
| Сложность для редактора | Низкая | Низкая | Низкая | Средняя | Низкая |

Рекомендация: Используйте Parser Function {{#cmdb:...}} как основной способ. Для проектов с SMW — комбинируйте с #property.

---

## 3. Матрица выбора подхода

| Критерий | iframe | Same-origin proxy (B) | Special Page (C) | API + JS (D) | SSO + JWT (E) |
|----------|:------:|:---------------------:|:----------------:|:------------:|:-------------:|
| Безопасность | 🔴 | 🟡 | 🟢 | 🟢 | 🟢 |
| Сложность интеграции | 🟢 | 🟡 | 🟡 | 🟡 | 🔴 |
| Единый стиль UI | 🔴 | 🔴 | 🟢 | 🟢 | 🟢 |
| Shared session | 🟡 | 🟢 | 🟢 | 🟡 | 🟢 |
| SEO / индексация | 🔴 | 🔴 | 🟢 | 🟡 | 🟡 |
| Совместимость с CSP | 🔴 | 🟢 | 🟢 | 🟢 | 🟢 |

---

## 4. Чеклист безопасности

- [ ] iframe запрещён в wiki-тексте (чёрный список HTML).
- [ ] Внешний сервис недоступен напрямую из браузера.
- [ ] Аутентификация через MediaWiki (RBAC, группы).
- [ ] Куки: `HttpOnly`, `Secure`, `SameSite=Strict`.
- [ ] CSP `frame-ancestors` запрещает сторонние домены.
- [ ] API проверяет CSRF-токен на mutating операциях.
- [ ] PII не передаётся в URL.
- [ ] Server-side логирование (actor, action, timestamp).

---

## 5. Выводы и рекомендации

1. **Никогда не используйте `<iframe>`** для корпоративных сервисов в MediaWiki.
2. **Для cmdbcustompages** используйте **Special Page Extension** (Вариант C): server-side прокси с RBAC.
3. **Для интерактивных элементов** добавьте **API + JS виджет** (Вариант D) через `<cmdbwidget>` tag.
4. **Same-origin proxy** (Вариант B) — transition-решение для legacy.
5. **SSO + JWT** (Вариант E) — при масштабе >3 сервисов и распределённых командах.

---

*Составлено на основе аудитов: cmdbcustompages, wikiAI, serviceDeskAgents.*
*Автор: Kimi Code CLI (OMK)*
