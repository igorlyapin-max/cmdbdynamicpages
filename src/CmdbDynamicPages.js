function cmdbDynamicPagesClientLog(stage, message) {
    try {
        var image = new Image();
        image.src = '/cmdbuild/custom-api/client-log?stage=' + encodeURIComponent(stage || '') +
            '&message=' + encodeURIComponent(message || '') +
            '&href=' + encodeURIComponent(window.location.href || '') +
            '&_=' + String(new Date().getTime());
    } catch (error) {
    }
}

function cmdbDynamicPagesParseParams(query) {
    var params = {};
    var text = (query || '').replace(/^\?/, '');
    var parts = text ? text.split('&') : [];
    for (var index = 0; index < parts.length; index += 1) {
        var part = parts[index];
        if (!part) continue;
        var separator = part.indexOf('=');
        var rawKey = separator === -1 ? part : part.slice(0, separator);
        var rawValue = separator === -1 ? '' : part.slice(separator + 1);
        var key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        if (!key) continue;
        params[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    }
    return params;
}

function cmdbDynamicPagesBuildQuery(params) {
    var pairs = [];
    Object.keys(params || {}).forEach(function (key) {
        if (params[key] === undefined || params[key] === null) return;
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
    });
    return pairs.join('&');
}

function cmdbDynamicPagesReadHashRoute() {
    var hash = window.location.hash || '';
    var marker = 'custompages/CmdbDynamicPages';
    var markerIndex = hash.indexOf(marker);
    if (markerIndex === -1) return {};
    var suffix = hash.slice(markerIndex + marker.length).replace(/^\/+/, '');
    var query = '';
    var queryIndex = suffix.indexOf('?');
    if (queryIndex !== -1) {
        query = suffix.slice(queryIndex + 1);
        suffix = suffix.slice(0, queryIndex);
    }
    var parts = suffix.split('/').filter(Boolean).map(decodeURIComponent);
    return {
        path: parts,
        params: cmdbDynamicPagesParseParams(query)
    };
}

function cmdbDynamicPagesBuildTargetUrl() {
    var queryParams = cmdbDynamicPagesParseParams(window.location.search || '');
    var hashRoute = cmdbDynamicPagesReadHashRoute();
    var params = {};
    Object.keys(hashRoute.params || {}).forEach(function (key) {
        params[key] = hashRoute.params[key];
    });
    Object.keys(queryParams || {}).forEach(function (key) {
        params[key] = queryParams[key];
    });

    var mode = params.cmdpMode || '';
    var templateCode = params.cmdpTemplate || '';
    delete params.cmdpMode;
    delete params.cmdpTemplate;

    if (!templateCode && hashRoute.path && hashRoute.path.length) {
        if (hashRoute.path[0] === 'designer') {
            mode = 'designer';
        } else {
            templateCode = hashRoute.path[0];
        }
    }

    if (mode === 'designer' || !templateCode) {
        var designerQuery = cmdbDynamicPagesBuildQuery(params);
        return '/cmdbuild/dynamicpages/ui/designer' + (designerQuery ? '?' + designerQuery : '');
    }

    var runtimeQuery = cmdbDynamicPagesBuildQuery(params);
    return '/cmdbuild/dynamicpages/ui/run/' + encodeURIComponent(templateCode) + (runtimeQuery ? '?' + runtimeQuery : '');
}

function cmdbDynamicPagesOpenExternalUi() {
    var target = cmdbDynamicPagesBuildTargetUrl();
    cmdbDynamicPagesClientLog('launcher-redirect', target);
    window.location.replace(target);
}

function cmdbDynamicPagesShouldAutoOpen() {
    var params = cmdbDynamicPagesParseParams(window.location.search || '');
    var hash = window.location.hash || '';
    return Boolean(
        params.cmdpMode ||
        params.cmdpTemplate ||
        hash.indexOf('custompages/CmdbDynamicPages') !== -1
    );
}

cmdbDynamicPagesClientLog('script-loaded', 'launcher');

if (cmdbDynamicPagesShouldAutoOpen()) {
    window.setTimeout(cmdbDynamicPagesOpenExternalUi, 0);
}

Ext.define('CMDBuildUI.view.custompages.CmdbDynamicPages.CmdbDynamicPages', {
    extend: 'Ext.panel.Panel',
    alias:'widget.cmdb-dynamic-pages',
    mixins:['CMDBuildUI.mixins.CustomPage'],

    bodyPadding: 16,
    scrollable: true,
    title: 'CMDB Dynamic Pages',

    initComponent: function () {
        cmdbDynamicPagesClientLog('initComponent', 'launcher');
        this.html = [
            '<div style="font-family:Arial,sans-serif;line-height:1.45">',
            '<h2 style="font-size:20px;margin:0 0 8px">CMDB Dynamic Pages</h2>',
            '<p style="margin:0;color:#52606d">Opening dynamic pages UI...</p>',
            '</div>'
        ].join('');
        this.callParent(arguments);
        this.on('afterrender', function () {
            cmdbDynamicPagesClientLog('afterrender', 'launcher');
            window.setTimeout(cmdbDynamicPagesOpenExternalUi, 0);
        }, this, { single: true });
    }
});
