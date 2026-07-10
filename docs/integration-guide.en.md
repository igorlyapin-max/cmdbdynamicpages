# Integration Guide: Embedding External Services in MediaWiki

**Context:** Integration of CMDBuild dynamic pages (custompages) into MediaWiki.
**Date:** 2026-06-02
**Status:** Architectural recommendation (ADR).

---

## 1. Why iframe is considered outdated and unsafe

Using the HTML `<iframe>` tag to embed one enterprise application into another is an architectural anti-pattern.

### 1.1 Security threats

| Threat | Description |
|--------|-------------|
| **Clickjacking** | An attacker overlays a transparent layer on top of the iframe and intercepts user clicks. |
| **XSS via postMessage** | Missing `event.origin` validation allows malicious code injection. |
| **Referrer leakage** | The URL inside the iframe, containing tokens, leaks through the `Referer` header. |
| **Cookie leaking** | If XSS occurs on the parent page, session hijacking becomes possible via side-channels. |

### 1.2 Modern browser limitations

- **Third-party cookie deprecation** — Chrome, Safari, and Firefox are blocking cross-site cookies.
- **SameSite=Lax/Strict** — cookies will not be sent to a frame on a different subdomain.
- **CSP frame-ancestors** — requires an explicit whitelist; a misconfiguration results in a blank screen.
- **Partitioned cookies (CHIPS)** — isolates cookies inside an iframe by top-level site.

---

## 2. Integration options with concrete implementation

### 2.1 Option B — Same-origin proxy via nginx

All services are available through one domain with different paths. The browser sees a single origin — no CORS, cookies are shared natively.

#### Step 1. nginx configuration

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
        proxy_set_header X-User-Name $http_x_user_name; # optional
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

#### Step 2. MediaWiki configuration

In `LocalSettings.php`:

```php
$wgServer = 'https://corp.local/wiki';
$wgScriptPath = '/wiki';
$wgArticlePath = '/wiki/$1';
```

#### Step 3. Embedding content without iframe

In a Special Page or JS widget, call the backend via `/custom/api/...` (same origin).

---

### 2.2 Option C — Special Page Extension (BEST PRACTICE)

Create a MediaWiki PHP extension that makes a server-side request to the backend and renders HTML inside the wiki page.

#### Extension structure

```
extensions/CmdbCustomPages/
├── extension.json
├── i18n/
│   └── en.json
├── includes/
│   ├── SpecialCmdbCustomPages.php
│   └── ApiCmdbCustomPages.php
└── modules/
    ├── ext.cmdbcustompages.js
    └── ext.cmdbcustompages.css
```

#### File extension.json

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

#### File includes/SpecialCmdbCustomPages.php

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

        // Permission check
        if (!$user->isAllowed('cmdbcustompages-read')) {
            throw new PermissionsError('cmdbcustompages-read');
        }

        $page = $subpage ?: 'dashboard';
        $backendUrl = 'http://cmdbcustompages:3000/api/page/' . urlencode($page);

        // Server-side HTTP request to backend
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
            $out->addHTML('<div class="error">Service temporarily unavailable</div>');
            return;
        }

        $response = json_decode($req->getContent(), true);
        if (empty($response['html'])) {
            $out->addHTML('<div class="error">Empty response from service</div>');
            return;
        }

        // Attach CSS and JS via ResourceLoader
        $out->addModules('ext.cmdbcustompages');

        // Render content (filtering is optional)
        $out->addHTML('<div class="cmdb-custompages-container">');
        $out->addHTML($response['html']);
        $out->addHTML('</div>');
    }

    protected function getGroupName() {
        return 'other';
    }
}
```

#### File includes/ApiCmdbCustomPages.php

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

#### File modules/ext.cmdbcustompages.js

```javascript
( function () {
    'use strict';

    var api = new mw.Api();

    /**
     * Mounts the cmdbcustompages widget into the specified container.
     * @param {string} containerId
     * @param {Object} options
     */
    function mount( containerId, options ) {
        var container = document.getElementById( containerId );
        if ( !container ) {
            return;
        }

        container.innerHTML = '<div class="cmdb-loading">Loading...</div>';

        api.get( {
            action: 'cmdbcustompages',
            page: options.page || 'dashboard',
            format: 'json'
        } ).then( function ( data ) {
            container.innerHTML = renderWidget( data.cmdb );
        } ).catch( function () {
            container.innerHTML = '<div class="error">Failed to load data</div>';
        } );
    }

    function renderWidget( data ) {
        var html = '<table class="cmdb-data-table">';
        html += '<thead><tr><th>Parameter</th><th>Value</th></tr></thead>';
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

#### File modules/ext.cmdbcustompages.css

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

#### Enabling the extension

In `LocalSettings.php`:

```php
wfLoadExtension('CmdbCustomPages');
```

The page is then available at:
`https://corp.local/wiki/Special:CmdbCustomPages/dashboard`

---

### 2.3 Option D — API-first + client-side JS widget

If the content is highly interactive (filters, search, real-time), the backend returns only JSON, and rendering happens in the browser.

Use the same `ApiCmdbCustomPages` (see above), but without the SpecialPage. Instead, create a **Parser hook** — a tag that can be inserted directly into a wiki page:

#### Adding the `<cmdbwidget>` tag

Add hooks to `extension.json`:

```json
"Hooks": {
    "ParserFirstCallInit": [
        "CmdbCustomPagesHooks::onParserFirstCallInit"
    ]
}
```

Create `includes/CmdbCustomPagesHooks.php`:

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

Editors can now insert into articles:

```wiki
== My dashboard ==
<cmdbwidget page="incidents" />
```

#### Updated JS for auto-initialization

```javascript
( function () {
    'use strict';

    var api = new mw.Api();

    function mount( containerId, options ) {
        var container = document.getElementById( containerId );
        if ( !container ) { return; }
        container.innerHTML = '<div class="cmdb-loading">Loading...</div>';

        api.get( {
            action: 'cmdbcustompages',
            page: options.page || 'dashboard',
            format: 'json'
        } ).then( function ( data ) {
            container.innerHTML = renderWidget( data.cmdb );
        } ).catch( function () {
            container.innerHTML = '<div class="error">Failed to load</div>';
        } );
    }

    function renderWidget( data ) {
        var html = '<table class="cmdb-data-table"><thead><tr>';
        html += '<th>Key</th><th>Value</th>';
        html += '</tr></thead><tbody>';
        Object.keys( data || {} ).forEach( function ( key ) {
            html += '<tr><td>' + mw.html.escape( key ) + '</td>' +
                    '<td>' + mw.html.escape( String( data[ key ] ) ) + '</td></tr>';
        } );
        html += '</tbody></table>';
        return html;
    }

    // Auto-initialize all widgets on the page
    function init() {
        var widgets = document.querySelectorAll('.cmdb-widget');
        widgets.forEach( function ( el ) {
            var page = el.getAttribute('data-page') || 'dashboard';
            mount( el.id, { page: page } );
        } );
    }

    mw.cmdbCustomPages = { mount: mount, init: init };

    if ( document.readyState === 'loading' ) {
        document.addEventListener( 'DOMContentLoaded', init );
    } else {
        init();
    }

}() );
```

---

### 2.4 Option E — SSO + JWT (Keycloak / Active Directory)

For distributed teams with multiple subdomains.

#### Architecture

1. The user authenticates to MediaWiki via SAML/OIDC (PluggableAuth plugin).
2. The MediaWiki Extension obtains a JWT from the IdP (or generates a service token).
3. During the server-side request to the backend, the `Authorization: Bearer <JWT>` header is passed.
4. The backend validates the JWT via the IdP JWKS endpoint.

#### Example JWT pass-through in Special Page

```php
public function execute($subpage) {
    $user = $this->getUser();
    $jwt = $this->getUserJWT(); // obtained from session or IdP callback

    $req = $http->create($backendUrl, ['method' => 'GET', 'timeout' => 30], __METHOD__);
    $req->setHeader('Authorization', 'Bearer ' . $jwt);
    $req->setHeader('X-User-Name', $user->getName());

    // ... remaining logic
}
```

#### Backend (cmdbcustompages) JWT validation configuration

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

## 2.5 Editor-facing options: dynamic links and widgets without admin intervention

All options above require PHP changes by an administrator. But a page editor needs to insert a link to a dynamic cmdbcustompages page with parameters that depend on the current article context ({{PAGENAME}}, {{CURRENTUSER}}, SMW properties).

Below are solutions that the admin sets up once, and editors use through regular wiki markup.

### 2.5.1 Template + Magic Words (simplest)

An administrator creates a template `Template:CmdbPage` through the wiki interface. Editors insert it into articles.

**`Template:CmdbPage`:**
```wiki
<includeonly>
<cmdbwidget page="{{{page|dashboard}}}" filter="{{{filter|}}}" context="{{{context|{{PAGENAME}}}}}" />
[https://custompages.corp/view/{{{page|dashboard}}}?ctx={{urlencode:{{PAGENAME}}}}&filter={{urlencode:{{{filter|}}}}}
 Open in CMDB]
</includeonly>
```

**Editor inserts:**
```wiki
{{CmdbPage
|page=incidents
|filter=status:open
|context={{PAGENAME}}
}}
```

**Pros:** Zero extension.php edits. Parameters come from standard Magic Words.
**Cons:** No validation — editor may insert arbitrary text into `filter`. XSS risk if extension does not do `htmlspecialchars` on output.

---

### 2.5.2 Parser Function `{{#cmdb:...}}` (recommended)

An administrator adds a Parser Function to the extension once. Editors write:

```wiki
{{#cmdb:
 |page=incidents
 |filter=status:open
 |parent={{PAGENAME}}
 |user={{CURRENTUSER}}
 |mode=widget
}}
```

#### Implementation in extension

Add to `includes/CmdbCustomPagesHooks.php`:

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

        // Whitelist of allowed pages
        $allowedPages = ['dashboard', 'incidents', 'assets', 'contracts'];
        $page = in_array($params['page'] ?? '', $allowedPages) ? $params['page'] : 'dashboard';

        // Sanitization
        $filter = preg_replace('/[^a-zA-Z0-9_\-:]/', '', $params['filter'] ?? '');
        $parent = preg_replace('/[^a-zA-Z0-9_\-]/', '', $params['parent'] ?? '');
        $mode = in_array($params['mode'] ?? '', ['link', 'widget', 'both']) ? $params['mode'] : 'both';

        // HMAC signature (protects against parameter tampering by editor)
        $secret = $GLOBALS['wgCmdbCustomPagesSecret'] ?? 'REPLACE_ME';
        $sig = hash_hmac('sha256', $page . '|' . $filter . '|' . $parent, $secret);

        $url = '/custom/api/page/' . urlencode($page)
             . '?filter=' . urlencode($filter)
             . '&parent=' . urlencode($parent)
             . '&sig=' . $sig;

        $html = '';
        if ($mode === 'link' || $mode === 'both') {
            $html .= '<a href="' . htmlspecialchars($url) . '" class="cmdb-external-link" target="_blank">'
                   . 'Open in CMDB'
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

In `extension.json` add:
```json
"Hooks": {
    "ParserFirstCallInit": [
        "CmdbCustomPagesHooks::onParserFirstCallInit"
    ]
}
```

In `LocalSettings.php`:
```php
$wgCmdbCustomPagesSecret = getenv('CMDB_CUSTOMPAGES_SECRET');
```

**Why this is better than Template:** whitelist validation, regex on parameters, HMAC signature. Editor cannot replace URL with an arbitrary one.

---

### 2.5.3 Interwiki link + dynamic template

An administrator adds an Interwiki prefix (via DB or `LocalSettings.php`):

```sql
INSERT INTO interwiki (iw_prefix, iw_url, iw_api, iw_wikiid, iw_local, iw_trans)
VALUES ('cmdb', 'https://custompages.corp/view/$1', '', 0, 1, 0);
```

Editor can write:
```wiki
[[cmdb:incidents|Incidents]]
```

But Magic Words (`{{PAGENAME}}`) are not automatically expanded inside interwiki URLs. Therefore interwiki only works through a **wrapper template**:

```wiki
{{CmdbLink
|page=incidents
|ctx={{PAGENAME}}
|user={{CURRENTUSER}}
}}
```

**Pros:** Standard wiki syntax.
**Cons:** No built-in validation; not suitable for widgets.

---

### 2.5.4 Semantic MediaWiki (SMW)

If your wiki has Semantic MediaWiki installed (as in the wikiAI project), parameters are taken from the page semantic properties rather than entered manually.

**Properties on the page:**
```wiki
[[Has asset type::Server]]
[[Has status::Active]]
[[Has owner::Ivanov]]
```

**Editor inserts (or the template auto-generates):**
```wiki
{{#cmdb:
 |page=assets
 |filter=type:{{#property:Has asset type}};status:{{#property:Has status}}
 |owner={{#property:Has owner}}
 |mode=widget
}}
```

Or via `#ask`:
```wiki
{{#ask:[[Has asset type::Server]]
 |?Has status
 |format=template
 |template=CmdbSmwWidget
}}
```

**Pros:** Full automation — editor does not specify parameters at all if the template is embedded in the page form.
**Cons:** Requires SMW and a configured semantic schema.

---

### 2.5.5 PageForms

If the PageForms extension is used (mentioned in the wikiAI roadmap):

**`Form:AssetCmdb`:**
```wiki
{{{for template|CmdbPage}}}
{{{field|page|hidden|default=assets}}}
{{{field|filter|hidden|default=type:{{#property:Has asset type}}}}}
{{{field|context|hidden|default={{PAGENAME}}}}}
{{{end template}}}
```

The editor clicks "Create with form" — parameters are auto-populated from page properties.

---

### 2.5.6 Comparison of editor-facing options

| Criterion | Template + Magic Words | Parser Function `{{#cmdb:}}` | Interwiki | SMW | PageForms |
|-----------|:----------------------:|:----------------------------:|:---------:|:---:|:---------:|
| PHP code needed | No | Once | Once | No | No |
| Parameter validation | No | Whitelist + regex | No | Via properties | Via form |
| URL tamper protection | No | HMAC | No | Via properties | Via form |
| Suitable for widgets | Yes | Yes | Link only | Yes | Yes |
| Context dependency | {{PAGENAME}} | {{PAGENAME}} | Via template | SMW properties | SMW properties |
| Editor complexity | Low | Low | Low | Medium | Low |

**Recommendation:** Use **Parser Function `{{#cmdb:...}}`** as the primary method. For SMW projects — combine with `#property`.

---

## 3. Decision matrix

| Criterion | iframe | Same-origin proxy (B) | Special Page (C) | API + JS (D) | SSO + JWT (E) |
|-----------|:------:|:---------------------:|:----------------:|:------------:|:-------------:|
| Security | 🔴 | 🟡 | 🟢 | 🟢 | 🟢 |
| Integration complexity | 🟢 | 🟡 | 🟡 | 🟡 | 🔴 |
| Unified UI style | 🔴 | 🔴 | 🟢 | 🟢 | 🟢 |
| Shared session | 🟡 | 🟢 | 🟢 | 🟡 | 🟢 |
| SEO / indexing | 🔴 | 🔴 | 🟢 | 🟡 | 🟡 |
| CSP compatibility | 🔴 | 🟢 | 🟢 | 🟢 | 🟢 |

---

## 4. Security checklist

- [ ] iframe is forbidden in wiki markup (HTML blacklist).
- [ ] The external service is not directly reachable from the browser.
- [ ] Authentication goes through MediaWiki (RBAC, groups).
- [ ] Cookies: `HttpOnly`, `Secure`, `SameSite=Strict`.
- [ ] CSP `frame-ancestors` forbids third-party domains.
- [ ] API verifies CSRF token on mutating operations.
- [ ] PII is not passed in URLs.
- [ ] Server-side logging (actor, action, timestamp).

---

## 5. Conclusions and recommendations

1. **Never use `<iframe>`** for corporate services in MediaWiki.
2. **For cmdbcustompages**, use the **Special Page Extension** (Option C): server-side proxy with RBAC.
3. **For interactive elements**, add the **API + JS widget** (Option D) via the `<cmdbwidget>` tag.
4. **Same-origin proxy** (Option B) is a transitional solution for legacy systems.
5. **SSO + JWT** (Option E) — when scaling beyond 3 services with distributed teams.

---

*Based on audits: cmdbcustompages, wikiAI, serviceDeskAgents.*
*Author: Kimi Code CLI (OMK)*
