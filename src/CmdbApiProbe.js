Ext.define('CMDBuildUI.view.custompages.CmdbApiProbe.CmdbApiProbe', {
    extend: 'Ext.panel.Panel',
    alias:'widget.cmdb-api-probe',
    mixins:['CMDBuildUI.mixins.CustomPage'],

    bodyPadding: 16,
    scrollable: true,
    title: 'CMDBuild API session probe',

    initComponent: function () {
        this.html = this.renderResult({
            state: 'running',
            message: 'Running REST API calls with fetch credentials: include...'
        });
        this.callParent(arguments);
        this.on('afterrender', this.runProbe, this, { single: true });
    },

    runProbe: function () {
        var me = this;
        Promise.all([
            me.requestJson('/sessions/current'),
            me.requestJson('/classes?limit=1'),
            me.requestBackendJson('/cmdbuild/custom-api/session-probe'),
            me.requestBackendJson('/cmdbuild/custom-api/classes-probe')
        ]).then(function (results) {
            var sessionResult = results[0];
            var classesResult = results[1];
            var backendSessionResult = results[2];
            var backendClassesResult = results[3];
            var session = sessionResult.json && sessionResult.json.data ? sessionResult.json.data : {};
            var classes = classesResult.json && classesResult.json.data ? classesResult.json.data : [];
            var firstClass = classes.length ? classes[0] : null;
            var backendSession = backendSessionResult.json && backendSessionResult.json.session ? backendSessionResult.json.session : {};
            var backendClass = backendClassesResult.json && backendClassesResult.json.firstClass ? backendClassesResult.json.firstClass : {};
            var allOk = sessionResult.ok && classesResult.ok && backendSessionResult.ok && backendClassesResult.ok;

            me.update(me.renderResult({
                state: allOk ? 'ok' : 'error',
                message: allOk
                    ? 'Success. CMDBuild accepted browser cookies directly and through the proxy backend.'
                    : 'At least one REST API call failed.',
                sessionStatus: sessionResult.status,
                classesStatus: classesResult.status,
                backendSessionStatus: backendSessionResult.status,
                backendClassesStatus: backendClassesResult.status,
                username: session.username || '',
                role: session.role || '',
                sessionType: session.sessionType || '',
                firstClassName: firstClass ? firstClass.name : '',
                firstClassDescription: firstClass ? (firstClass._description_translation || firstClass.description || '') : '',
                firstClassCanRead: firstClass ? firstClass._can_read : '',
                firstClassCanCreate: firstClass ? firstClass._can_create : '',
                backendReceivedCookie: backendSessionResult.json ? backendSessionResult.json.receivedCmdbuildCookie : '',
                backendForwardedAs: backendSessionResult.json ? backendSessionResult.json.forwardedAs : '',
                backendUsername: backendSession.username || '',
                backendRole: backendSession.role || '',
                backendFirstClassName: backendClass.name || '',
                backendFirstClassCanRead: backendClass.canRead,
                backendFirstClassCanCreate: backendClass.canCreate
            }));
        }).catch(function (error) {
            me.update(me.renderResult({
                state: 'error',
                message: error && error.message ? error.message : String(error)
            }));
        });
    },

    requestBackendJson: function (path) {
        return fetch(path, {
            credentials: 'include',
            headers: {
                Accept: 'application/json'
            }
        }).then(function (response) {
            return response.text().then(function (body) {
                var json = null;
                try {
                    json = body ? JSON.parse(body) : null;
                } catch (error) {
                    json = null;
                }
                return {
                    ok: response.ok,
                    status: response.status,
                    json: json,
                    body: body
                };
            });
        }).catch(function (error) {
            return {
                ok: false,
                status: 'fetch failed',
                json: {
                    success: false,
                    message: error && error.message ? error.message : String(error)
                },
                body: ''
            };
        });
    },

    requestJson: function (path) {
        return fetch(this.getApiBaseUrl() + path, {
            credentials: 'include',
            headers: {
                Accept: 'application/json'
            }
        }).then(function (response) {
            return response.text().then(function (body) {
                var json = null;
                try {
                    json = body ? JSON.parse(body) : null;
                } catch (error) {
                    json = null;
                }
                return {
                    ok: response.ok,
                    status: response.status,
                    json: json,
                    body: body
                };
            });
        });
    },

    getApiBaseUrl: function () {
        var configured = null;
        if (window.CMDBuildUI && CMDBuildUI.util && CMDBuildUI.util.Config) {
            configured = CMDBuildUI.util.Config.baseUrl;
        }
        if (!configured && window.cmdbuildConfig) {
            configured = window.cmdbuildConfig.baseUrl;
        }
        configured = configured || '/cmdbuild/services/rest/v3';

        try {
            var parsed = new URL(configured, window.location.href);
            if (parsed.origin === window.location.origin) {
                return parsed.pathname.replace(/\/$/, '');
            }
        } catch (error) {
        }

        return configured.replace(/\/$/, '');
    },

    renderResult: function (data) {
        var ok = data.state === 'ok';
        var running = data.state === 'running';
        var color = ok ? '#16794c' : running ? '#6b5c00' : '#a4262c';
        var rows = [
            ['Direct session endpoint HTTP', data.sessionStatus],
            ['Direct classes endpoint HTTP', data.classesStatus],
            ['Direct username', data.username],
            ['Direct role', data.role],
            ['Direct session type', data.sessionType],
            ['Direct first class', data.firstClassName],
            ['Direct first class description', data.firstClassDescription],
            ['Direct first class _can_read', data.firstClassCanRead],
            ['Direct first class _can_create', data.firstClassCanCreate],
            ['Proxy backend session HTTP', data.backendSessionStatus],
            ['Proxy backend classes HTTP', data.backendClassesStatus],
            ['Proxy backend received CMDBuild cookie', data.backendReceivedCookie],
            ['Proxy backend forwarded auth as', data.backendForwardedAs],
            ['Proxy backend username', data.backendUsername],
            ['Proxy backend role', data.backendRole],
            ['Proxy backend first class', data.backendFirstClassName],
            ['Proxy backend first class _can_read', data.backendFirstClassCanRead],
            ['Proxy backend first class _can_create', data.backendFirstClassCanCreate]
        ];

        var html = [
            '<div style="font-family:Arial,sans-serif;line-height:1.45;max-width:900px">',
            '<h2 style="margin:0 0 12px;font-size:22px">CMDBuild API session probe</h2>',
            '<p style="margin:0 0 16px;color:', color, '">', this.escapeHtml(data.message || ''), '</p>',
            '<table style="border-collapse:collapse;width:100%;background:#fff">',
            '<tbody>'
        ];

        Ext.Array.forEach(rows, function (row) {
            if (row[1] !== undefined && row[1] !== null && row[1] !== '') {
                html.push(
                    '<tr>',
                    '<th style="text-align:left;border:1px solid #d8d8d8;padding:8px;background:#f5f5f5;width:240px">',
                    this.escapeHtml(row[0]),
                    '</th>',
                    '<td style="border:1px solid #d8d8d8;padding:8px">',
                    this.escapeHtml(String(row[1])),
                    '</td>',
                    '</tr>'
                );
            }
        }, this);

        html.push(
            '</tbody>',
            '</table>',
            '<p style="margin:16px 0 0;color:#555">The JavaScript code sends no CMDBuild-Authorization header. Direct calls and backend calls use only fetch credentials: include. The backend receives the HttpOnly cookie as an HTTP cookie and forwards it to CMDBuild as a server-side header.</p>',
            '</div>'
        );
        return html.join('');
    },

    escapeHtml: function (value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
});
