Ext.define('CMDBuildUI.view.custompages.CmdbDynamicPages.CmdbDynamicPages', {
    extend: 'Ext.panel.Panel',
    alias:'widget.cmdb-dynamic-pages',
    mixins:['CMDBuildUI.mixins.CustomPage'],

    bodyPadding: 0,
    scrollable: true,
    title: 'CMDB Dynamic Pages',

    initComponent: function () {
        this.state = {
            root: 'Cst_QueryTool',
            templates: [],
            templateVersions: [],
            schema: null,
            config: null,
            selectedTemplate: null,
            selectedClass: null,
            classAttributes: [],
            result: null,
            runParams: {},
            builderKind: 'classes',
            message: null
        };
        this.html = this.renderShell('Loading...');
        this.callParent(arguments);
        this.on('afterrender', this.afterPageRender, this, { single: true });
        this.on('destroy', this.cleanupPage, this, { single: true });
    },

    afterPageRender: function () {
        this.mon(this.getEl(), 'click', this.handleClick, this);
        this.mon(this.getEl(), 'change', this.handleChange, this);
        this.hashHandler = Ext.Function.bind(this.loadRoute, this);
        window.addEventListener('hashchange', this.hashHandler);
        this.loadRoute();
    },

    cleanupPage: function () {
        if (this.hashHandler) {
            window.removeEventListener('hashchange', this.hashHandler);
            this.hashHandler = null;
        }
    },

    loadRoute: function () {
        var route = this.parseRoute();
        this.currentRoute = route;
        if (route.mode === 'designer') {
            this.loadDesigner();
        } else if (route.mode === 'runtime') {
            this.loadRuntime(route.templateCode, route.params);
        } else {
            this.loadHome();
        }
    },

    parseRoute: function () {
        var hash = window.location.hash || '';
        var marker = 'custompages/CmdbDynamicPages';
        var index = hash.indexOf(marker);
        var urlParams = this.parseParams((window.location.search || '').replace(/^\?/, ''));
        if (index === -1) {
            return { mode: 'home', params: urlParams };
        }

        var suffix = hash.slice(index + marker.length).replace(/^\/+/, '');
        var query = '';
        var queryIndex = suffix.indexOf('?');
        if (queryIndex !== -1) {
            query = suffix.slice(queryIndex + 1);
            suffix = suffix.slice(0, queryIndex);
        }

        var hashParams = this.parseParams(query);
        var params = this.mergeParams(hashParams, urlParams);
        var explicitMode = params.cmdpMode || '';
        var explicitTemplate = params.cmdpTemplate || '';

        if (explicitMode === 'designer') {
            return { mode: 'designer', params: this.stripRouteParams(params) };
        }
        if (explicitTemplate) {
            return {
                mode: 'runtime',
                templateCode: explicitTemplate,
                params: this.stripRouteParams(params)
            };
        }

        var parts = suffix.split('/').filter(Boolean).map(decodeURIComponent);
        if (!parts.length) {
            return { mode: 'home', params: params };
        }
        if (parts[0] === 'designer') {
            return { mode: 'designer', params: this.stripRouteParams(params) };
        }
        return {
            mode: 'runtime',
            templateCode: parts[0],
            params: this.stripRouteParams(params)
        };
    },

    parseParams: function (query) {
        var params = {};
        var search = new URLSearchParams(query || '');
        search.forEach(function (value, key) {
            params[key] = value;
        });
        return params;
    },

    mergeParams: function () {
        var merged = {};
        Ext.Array.forEach(arguments, function (params) {
            var source = params || {};
            Object.keys(source).forEach(function (key) {
                merged[key] = source[key];
            });
        });
        return merged;
    },

    stripRouteParams: function (params) {
        var cleaned = {};
        var routeKeys = {
            cmdpMode: true,
            cmdpTemplate: true
        };
        Object.keys(params || {}).forEach(function (key) {
            if (!routeKeys[key]) cleaned[key] = params[key];
        });
        return cleaned;
    },

    loadHome: function () {
        var me = this;
        me.update(me.renderHome({ loading: true }));
        Promise.all([
            me.requestBackendJson('/cmdbuild/custom-api/session'),
            me.requestBackendJson('/cmdbuild/custom-api/schema?root=' + encodeURIComponent(me.state.root)),
            me.requestBackendJson('/cmdbuild/custom-api/templates?limit=50')
        ]).then(function (results) {
            me.state.session = results[0].json ? results[0].json.session : null;
            me.state.schema = results[1].json ? results[1].json.schema : null;
            me.state.templates = results[2].json && results[2].json.data ? results[2].json.data : [];
            me.update(me.renderHome({ loading: false }));
        }).catch(function (error) {
            me.update(me.renderError(error));
        });
    },

    loadDesigner: function () {
        var me = this;
        me.update(me.renderDesigner({ loading: true }));
        Promise.all([
            me.requestBackendJson('/cmdbuild/custom-api/schema?root=' + encodeURIComponent(me.state.root)),
            me.requestBackendJson('/cmdbuild/custom-api/config?root=' + encodeURIComponent(me.state.root)),
            me.requestBackendJson('/cmdbuild/custom-api/templates?limit=100'),
            me.requestBackendJson('/cmdbuild/custom-api/model/classes?limit=100'),
            me.requestBackendJson('/cmdbuild/custom-api/model/domains?limit=100&details=true&maxDetails=100')
        ]).then(function (results) {
            me.state.schema = results[0].json ? results[0].json.schema : null;
            me.state.config = results[1].json ? results[1].json.config : null;
            me.state.templates = results[2].json && results[2].json.data ? results[2].json.data : [];
            me.state.classes = results[3].json && results[3].json.data ? results[3].json.data : [];
            me.state.domains = results[4].json && results[4].json.data ? results[4].json.data : [];
            if (!me.state.selectedTemplate && me.state.templates.length) {
                me.state.selectedTemplate = me.state.templates[0];
            }
            if (me.state.selectedTemplate && me.state.selectedTemplate.code) {
                return me.fetchTemplateVersions(me.state.selectedTemplate.code).then(function () {
                    me.update(me.renderDesigner({ loading: false }));
                });
            }
            me.update(me.renderDesigner({ loading: false }));
        }).catch(function (error) {
            me.update(me.renderError(error));
        });
    },

    loadClassAttributes: function (className) {
        var me = this;
        me.state.selectedClass = className;
        me.state.classAttributes = [];
        me.state.message = { type: 'info', text: 'Loading attributes for ' + className + '...' };
        me.update(me.renderDesigner({ loading: false }));
        me.requestBackendJson('/cmdbuild/custom-api/model/classes/' + encodeURIComponent(className) + '/attributes').then(function (result) {
            if (!result.ok) {
                throw new Error(me.extractError(result));
            }
            me.state.classAttributes = result.json && result.json.data ? result.json.data : [];
            me.state.message = { type: 'ok', text: 'Attributes loaded.' };
            me.update(me.renderDesigner({ loading: false }));
        }).catch(function (error) {
            me.state.message = { type: 'error', text: error.message };
            me.update(me.renderDesigner({ loading: false }));
        });
    },

    loadRuntime: function (templateCode, params) {
        var me = this;
        me.update(me.renderRuntime({
            loading: true,
            templateCode: templateCode,
            params: params
        }));
        me.requestBackendJson('/cmdbuild/custom-api/templates/' + encodeURIComponent(templateCode) + '/run', {
            method: 'POST',
            body: {
                params: params || {}
            }
        }).then(function (result) {
            me.update(me.renderRuntime({
                loading: false,
                templateCode: templateCode,
                params: params,
                result: result
            }));
        }).catch(function (error) {
            me.update(me.renderError(error));
        });
    },

    handleClick: function (event) {
        var target = event.getTarget('[data-action]');
        if (!target) return;
        event.preventDefault();
        var action = target.getAttribute('data-action');
        var code = target.getAttribute('data-code');
        var className = target.getAttribute('data-class');
        var versionId = target.getAttribute('data-version');
        if (action === 'go-home') {
            this.goTo('');
        } else if (action === 'go-designer') {
            this.goTo('designer');
        } else if (action === 'select-template') {
            this.selectTemplate(code);
        } else if (action === 'select-class') {
            this.loadClassAttributes(className);
        } else if (action === 'new-template') {
            this.newTemplate();
        } else if (action === 'save-template') {
            this.saveTemplate();
        } else if (action === 'validate-template') {
            this.validateTemplate();
        } else if (action === 'preview-template') {
            this.previewTemplate();
        } else if (action === 'run-template') {
            this.goTo(code || this.getEditorCode());
        } else if (action === 'apply-builder') {
            this.applyBuilderSpec();
        } else if (action === 'load-version') {
            this.loadVersionSpec(versionId);
        } else if (action === 'bootstrap-schema') {
            this.bootstrapSchema();
        } else if (action === 'save-config') {
            this.saveConfig();
        }
    },

    handleChange: function (event) {
        var target = event.getTarget('[data-field]');
        if (!target) return;
        if (target.getAttribute('data-field') === 'root') {
            this.state.root = target.value;
        } else if (target.getAttribute('data-field') === 'builderKind') {
            this.state.builderKind = target.value;
        }
    },

    goTo: function (path) {
        var base = '#custompages/CmdbDynamicPages';
        var hash = base;
        if (path === 'designer') {
            hash = base + '?cmdpMode=designer';
        } else if (path) {
            hash = base + '?cmdpTemplate=' + encodeURIComponent(path);
        }

        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, document.title, window.location.pathname + hash);
            if (path === 'designer') {
                this.loadDesigner();
            } else if (path) {
                this.loadRuntime(path, {});
            } else {
                this.loadHome();
            }
            return;
        }

        window.location.hash = hash;
    },

    selectTemplate: function (code) {
        var found = null;
        Ext.Array.forEach(this.state.templates || [], function (template) {
            if (template.code === code) found = template;
        });
        this.state.selectedTemplate = found;
        this.state.runParams = {};
        this.state.message = null;
        this.fetchTemplateVersions(code).then(function () {
            this.update(this.renderDesigner({ loading: false }));
        }.bind(this)).catch(function (error) {
            this.state.templateVersions = [];
            this.state.message = { type: 'error', text: error.message };
            this.update(this.renderDesigner({ loading: false }));
        }.bind(this));
    },

    newTemplate: function () {
        this.state.selectedTemplate = {
            code: '',
            description: '',
            active: true,
            spec: this.defaultSpec(),
            paramsSchema: {},
            resultSchema: {}
        };
        this.state.runParams = {};
        this.state.templateVersions = [];
        this.state.message = null;
        this.update(this.renderDesigner({ loading: false }));
    },

    saveTemplate: function () {
        var me = this;
        var payload;
        try {
            payload = me.readEditorPayload();
        } catch (error) {
            me.state.message = { type: 'error', text: error.message };
            me.update(me.renderDesigner({ loading: false }));
            return;
        }

        var exists = Boolean(me.state.selectedTemplate && me.state.selectedTemplate.id);
        var path = exists
            ? '/cmdbuild/custom-api/templates/' + encodeURIComponent(me.state.selectedTemplate.code)
            : '/cmdbuild/custom-api/templates';
        me.requestBackendJson(path, {
            method: exists ? 'PUT' : 'POST',
            body: payload
        }).then(function (result) {
            if (!result.ok) {
                throw new Error(me.extractError(result));
            }
            me.state.selectedTemplate = result.json.template;
            me.state.message = { type: 'ok', text: 'Saved.' };
            return me.requestBackendJson('/cmdbuild/custom-api/templates?limit=100');
        }).then(function (templates) {
            me.state.templates = templates.json && templates.json.data ? templates.json.data : [];
            return me.fetchTemplateVersions(me.state.selectedTemplate && me.state.selectedTemplate.code).then(function () {
                me.update(me.renderDesigner({ loading: false }));
            });
        }).catch(function (error) {
            me.state.message = { type: 'error', text: error.message };
            me.update(me.renderDesigner({ loading: false }));
        });
    },

    validateTemplate: function () {
        this.runEditorAction('validate');
    },

    previewTemplate: function () {
        this.runEditorAction('preview');
    },

    fetchTemplateVersions: function (code) {
        var me = this;
        if (!code) {
            me.state.templateVersions = [];
            return Promise.resolve([]);
        }
        return me.requestBackendJson('/cmdbuild/custom-api/templates/' + encodeURIComponent(code) + '/versions?limit=20').then(function (result) {
            if (!result.ok) {
                throw new Error(me.extractError(result));
            }
            me.state.templateVersions = result.json && result.json.data ? result.json.data : [];
            return me.state.templateVersions;
        });
    },

    loadVersionSpec: function (versionId) {
        var version = null;
        Ext.Array.forEach(this.state.templateVersions || [], function (item) {
            if (String(item.id) === String(versionId)) version = item;
        });
        if (!version) {
            this.state.message = { type: 'error', text: 'Template version not found.' };
            this.update(this.renderDesigner({ loading: false }));
            return;
        }
        var selected = this.state.selectedTemplate || {};
        this.state.selectedTemplate = {
            id: selected.id,
            code: selected.code,
            description: selected.description,
            active: selected.active !== false,
            spec: version.spec || selected.spec || this.defaultSpec(),
            paramsSchema: selected.paramsSchema || {},
            resultSchema: selected.resultSchema || {}
        };
        this.state.message = { type: 'ok', text: 'Version loaded into editor.' };
        this.update(this.renderDesigner({ loading: false }));
    },

    applyBuilderSpec: function () {
        var kind = this.getInputValue('cmdp-builder-kind') || this.state.builderKind || 'classes';
        var selected = this.state.selectedTemplate || {};
        var built = this.buildBuilderTemplate(kind, {
            attrType: this.getInputValue('cmdp-builder-attr-type') || 'reference',
            className: this.getInputValue('cmdp-builder-class-name') || this.state.selectedClass || 'Asset',
            depth: this.getInputValue('cmdp-builder-depth') || '1',
            referenceClass: this.getInputValue('cmdp-builder-reference-class') || this.state.selectedClass || 'Asset',
            rightType: this.getInputValue('cmdp-builder-right-type') || 'string'
        });
        var currentCode = this.getEditorCode();
        this.state.builderKind = kind;
        this.state.selectedTemplate = {
            id: selected.id,
            code: currentCode || selected.code || built.code,
            description: built.description,
            active: selected.active !== false,
            spec: built.spec,
            paramsSchema: selected.paramsSchema || {},
            resultSchema: selected.resultSchema || {}
        };
        this.state.runParams = built.params;
        this.state.message = { type: 'ok', text: 'Builder applied.' };
        this.update(this.renderDesigner({ loading: false }));
    },

    runEditorAction: function (action) {
        var me = this;
        var code = me.getEditorCode();
        if (!code) {
            me.state.message = { type: 'error', text: 'Template code is required.' };
            me.update(me.renderDesigner({ loading: false }));
            return;
        }
        me.requestBackendJson('/cmdbuild/custom-api/templates/' + encodeURIComponent(code) + '/' + action + '?maxRows=25', {
            method: 'POST',
            body: {
                params: me.readJsonField('cmdp-params', {})
            }
        }).then(function (result) {
            me.state.result = result;
            me.state.message = {
                type: result.ok ? 'ok' : 'error',
                text: result.ok ? action + ' completed.' : me.extractError(result)
            };
            me.update(me.renderDesigner({ loading: false }));
        }).catch(function (error) {
            me.state.message = { type: 'error', text: error.message };
            me.update(me.renderDesigner({ loading: false }));
        });
    },

    bootstrapSchema: function () {
        var me = this;
        var root = me.getInputValue('cmdp-root') || me.state.root;
        me.requestBackendJson('/cmdbuild/custom-api/schema/bootstrap', {
            method: 'POST',
            body: { root: root }
        }).then(function (result) {
            me.state.schema = result.json ? result.json.schema : null;
            me.state.message = {
                type: result.ok ? 'ok' : 'error',
                text: result.ok ? 'Schema is ready.' : me.extractError(result)
            };
            me.update(me.renderDesigner({ loading: false }));
        }).catch(function (error) {
            me.state.message = { type: 'error', text: error.message };
            me.update(me.renderDesigner({ loading: false }));
        });
    },

    saveConfig: function () {
        var me = this;
        var root = me.getInputValue('cmdp-root') || me.state.root;
        var runtimeConfig;
        try {
            runtimeConfig = me.readJsonField('cmdp-runtime-config', me.defaultRuntimeConfig());
        } catch (error) {
            me.state.message = { type: 'error', text: error.message };
            me.update(me.renderDesigner({ loading: false }));
            return;
        }
        me.requestBackendJson('/cmdbuild/custom-api/config?root=' + encodeURIComponent(root), {
            method: 'PUT',
            body: {
                active: true,
                runtimeConfig: runtimeConfig
            }
        }).then(function (result) {
            me.state.config = result.json ? result.json.config : null;
            me.state.message = {
                type: result.ok ? 'ok' : 'error',
                text: result.ok ? 'Config saved.' : me.extractError(result)
            };
            me.update(me.renderDesigner({ loading: false }));
        }).catch(function (error) {
            me.state.message = { type: 'error', text: error.message };
            me.update(me.renderDesigner({ loading: false }));
        });
    },

    readEditorPayload: function () {
        var code = this.getEditorCode();
        if (!code) throw new Error('Template code is required.');
        return {
            code: code,
            description: this.getInputValue('cmdp-description') || code,
            active: this.getCheckboxValue('cmdp-active'),
            spec: this.readJsonField('cmdp-spec', null),
            paramsSchema: this.readJsonField('cmdp-params-schema', {}),
            resultSchema: this.readJsonField('cmdp-result-schema', {})
        };
    },

    getEditorCode: function () {
        return this.getInputValue('cmdp-code').trim();
    },

    getInputValue: function (id) {
        var el = document.getElementById(id);
        return el ? el.value : '';
    },

    getCheckboxValue: function (id) {
        var el = document.getElementById(id);
        return el ? Boolean(el.checked) : false;
    },

    readJsonField: function (id, fallback) {
        var value = this.getInputValue(id);
        if (!value) return fallback;
        try {
            return JSON.parse(value);
        } catch (error) {
            throw new Error(id + ' must contain valid JSON.');
        }
    },

    defaultSpec: function () {
        return {
            version: 1,
            params: {
                attrType: {
                    type: 'string',
                    required: true
                }
            },
            steps: [
                {
                    type: 'findClassesByAttributeType',
                    attributeTypeParam: 'attrType',
                    as: 'classes'
                }
            ],
            result: {
                tables: [
                    {
                        name: 'classes',
                        columns: ['Class', 'Description', 'Attribute']
                    }
                ]
            }
        };
    },

    buildBuilderTemplate: function (kind, values) {
        var attrType = values.attrType || 'reference';
        var className = values.className || 'Asset';
        var depth = values.depth || '1';
        var referenceClass = values.referenceClass || className;
        var rightType = values.rightType || 'string';
        if (kind === 'domainTraversal') {
            return {
                code: 'BuilderDomainTraversal',
                description: 'Domain traversal template',
                params: {
                    attrType: attrType,
                    className: className,
                    depth: depth
                },
                spec: {
                    version: 1,
                    params: {
                        attrType: { type: 'string', required: true },
                        className: { type: 'string', required: true },
                        depth: { type: 'string', required: false }
                    },
                    steps: [
                        { type: 'findClassesByAttributeType', attributeTypeParam: 'attrType', as: 'classes' },
                        {
                            type: 'filterRows',
                            from: 'classes',
                            filters: [{ column: 'Class', op: 'equals', valueParam: 'className' }],
                            as: 'filteredClasses'
                        },
                        {
                            type: 'traverseDomains',
                            from: 'filteredClasses',
                            direction: 'both',
                            depthParam: 'depth',
                            as: 'domains'
                        }
                    ],
                    result: {
                        tables: [
                            { name: 'filteredClasses', columns: ['Class', 'Description', 'Attribute', 'AttributeType'] },
                            { name: 'domains', columns: ['Depth', 'Class', 'Domain', 'Source', 'Destination', 'Direction', 'RelatedClass', 'Cardinality'] }
                        ]
                    }
                }
            };
        }
        if (kind === 'attributeComparison') {
            return {
                code: 'BuilderAttributeComparison',
                description: 'Attribute comparison template',
                params: {
                    attrType: attrType,
                    referenceClass: referenceClass
                },
                spec: {
                    version: 1,
                    params: {
                        attrType: { type: 'string', required: true },
                        referenceClass: { type: 'string', required: true }
                    },
                    steps: [
                        { type: 'findClassesByAttributeType', attributeTypeParam: 'attrType', as: 'classes' },
                        {
                            type: 'compareClassAttributes',
                            from: 'classes',
                            referenceClassParam: 'referenceClass',
                            compareBy: ['name', 'type'],
                            as: 'attributeComparison'
                        }
                    ],
                    result: {
                        tables: [
                            {
                                name: 'attributeComparison',
                                columns: ['Class', 'ComparedClass', 'CompareBy', 'CommonCount', 'ClassOnlyCount', 'ComparedClassOnlyCount', 'CommonAttributes']
                            }
                        ]
                    }
                }
            };
        }
        if (kind === 'setOperations') {
            return {
                code: 'BuilderClassSetOperations',
                description: 'Class set operations template',
                params: {
                    leftType: attrType,
                    rightType: rightType
                },
                spec: {
                    version: 1,
                    params: {
                        leftType: { type: 'string', required: true },
                        rightType: { type: 'string', required: true }
                    },
                    steps: [
                        { type: 'findClassesByAttributeType', attributeTypeParam: 'leftType', as: 'leftClasses' },
                        { type: 'findClassesByAttributeType', attributeTypeParam: 'rightType', as: 'rightClasses' },
                        { type: 'intersectRows', from: 'leftClasses', with: 'rightClasses', on: 'Class', distinct: true, as: 'classesWithBoth' },
                        { type: 'joinRows', from: 'classesWithBoth', with: 'rightClasses', on: 'Class', mode: 'inner', rightPrefix: 'Right', as: 'joinedAttributes' }
                    ],
                    result: {
                        tables: [
                            { name: 'classesWithBoth', columns: ['Class', 'Description', 'Attribute', 'AttributeType'] },
                            { name: 'joinedAttributes', columns: ['Class', 'Attribute', 'AttributeType', 'RightAttribute', 'RightAttributeType'] }
                        ]
                    }
                }
            };
        }
        return {
            code: 'BuilderClassesByAttribute',
            description: 'Classes by attribute type template',
            params: {
                attrType: attrType
            },
            spec: {
                version: 1,
                params: {
                    attrType: { type: 'string', required: true }
                },
                steps: [
                    { type: 'findClassesByAttributeType', attributeTypeParam: 'attrType', as: 'classes' }
                ],
                result: {
                    tables: [
                        { name: 'classes', columns: ['Class', 'Description', 'Attribute', 'AttributeType'] }
                    ]
                }
            }
        };
    },

    defaultRuntimeConfig: function () {
        return {
            executionLimits: {
                maxRowsDefault: 500,
                maxRowsPreviewDefault: 25,
                maxRowsMax: 2000,
                maxClassesDefault: 100,
                maxClassesMax: 500,
                maxDomainsDefault: 100,
                maxDomainsMax: 500,
                maxRestCallsDefault: 250,
                maxRestCallsMax: 1000,
                maxTraversalDepthDefault: 1,
                maxTraversalDepthMax: 5
            }
        };
    },

    parseBackendResponse: function (response) {
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
    },

    getCsrfToken: function () {
        var me = this;
        if (me.csrfToken) {
            return Promise.resolve(me.csrfToken);
        }
        return fetch('/cmdbuild/custom-api/csrf', {
            method: 'GET',
            credentials: 'include',
            headers: {
                Accept: 'application/json'
            }
        }).then(function (response) {
            return me.parseBackendResponse(response);
        }).then(function (result) {
            if (!result.ok || !result.json || !result.json.token) {
                throw new Error(me.extractError(result));
            }
            me.csrfToken = result.json.token;
            return me.csrfToken;
        });
    },

    requestBackendJson: function (path, options) {
        var me = this;
        options = options || {};
        var fetchOptions = {
            method: (options.method || 'GET').toUpperCase(),
            credentials: 'include',
            headers: {
                Accept: 'application/json'
            }
        };
        if (options.body !== undefined) {
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify(options.body);
        }
        var execute = function () {
            return fetch(path, fetchOptions).then(function (response) {
                return me.parseBackendResponse(response);
            }).then(function (result) {
                if (result.status === 403 && fetchOptions.method !== 'GET') {
                    me.csrfToken = null;
                }
                return result;
            });
        };
        if (fetchOptions.method !== 'GET') {
            return me.getCsrfToken().then(function (token) {
                fetchOptions.headers['X-CMDBDynamicPages-CSRF'] = token;
                return execute();
            });
        }
        return execute();
    },

    extractError: function (result) {
        if (!result) return 'Request failed.';
        if (result.json && result.json.message) return result.json.message;
        if (result.json && result.json.errors) return JSON.stringify(result.json.errors);
        return 'HTTP ' + result.status;
    },

    renderHome: function (options) {
        var session = this.state.session || {};
        var schema = this.state.schema || {};
        var templates = this.state.templates || [];
        var rows = templates.map(function (template) {
            return [
                '<tr>',
                '<td>', this.escapeHtml(template.code), '</td>',
                '<td>', this.escapeHtml(template.description || ''), '</td>',
                '<td>', this.escapeHtml(String(template.active)), '</td>',
                '<td><button class="cmdp-button" data-action="run-template" data-code="', this.escapeHtml(template.code), '">Run</button></td>',
                '</tr>'
            ].join('');
        }, this).join('');

        return this.renderLayout([
            '<div class="cmdp-toolbar">',
            '<button class="cmdp-button primary" data-action="go-designer">Designer</button>',
            '</div>',
            this.renderNotice(options.loading ? 'Loading...' : null, 'info'),
            '<section class="cmdp-section">',
            '<h2>Overview</h2>',
            '<div class="cmdp-kpis">',
            this.renderKpi('User', session.username || ''),
            this.renderKpi('Role', session.role || ''),
            this.renderKpi('Schema', schema.ready ? 'Ready' : 'Not ready'),
            this.renderKpi('Templates', String(templates.length)),
            '</div>',
            '</section>',
            '<section class="cmdp-section">',
            '<h2>Templates</h2>',
            '<table class="cmdp-table"><thead><tr><th>Code</th><th>Description</th><th>Active</th><th></th></tr></thead><tbody>',
            rows || '<tr><td colspan="4">No templates.</td></tr>',
            '</tbody></table>',
            '</section>'
        ].join(''));
    },

    renderDesigner: function (options) {
        var schema = this.state.schema || {};
        var config = this.state.config || { runtimeConfig: this.defaultRuntimeConfig(), exists: false };
        var selected = this.state.selectedTemplate || {
            code: '',
            description: '',
            active: true,
            spec: this.defaultSpec(),
            paramsSchema: {},
            resultSchema: {}
        };
        var templateRows = (this.state.templates || []).map(function (template) {
            return [
                '<tr>',
                '<td><button class="cmdp-link" data-action="select-template" data-code="', this.escapeHtml(template.code), '">',
                this.escapeHtml(template.code),
                '</button></td>',
                '<td>', this.escapeHtml(template.description || ''), '</td>',
                '<td><button class="cmdp-button" data-action="run-template" data-code="', this.escapeHtml(template.code), '">Run</button></td>',
                '</tr>'
            ].join('');
        }, this).join('');

        return this.renderLayout([
            '<div class="cmdp-toolbar">',
            '<button class="cmdp-button" data-action="go-home">Home</button>',
            '<button class="cmdp-button" data-action="new-template">New</button>',
            '<button class="cmdp-button primary" data-action="save-template">Save</button>',
            '<button class="cmdp-button" data-action="validate-template">Validate</button>',
            '<button class="cmdp-button" data-action="preview-template">Preview</button>',
            '</div>',
            this.renderNotice(options.loading ? 'Loading...' : null, 'info'),
            this.renderNotice(this.state.message && this.state.message.text, this.state.message && this.state.message.type),
            '<section class="cmdp-section">',
            '<h2>Technical Schema</h2>',
            '<div class="cmdp-row">',
            '<label>Root<input id="cmdp-root" data-field="root" value="', this.escapeHtml(this.state.root), '"></label>',
            '<button class="cmdp-button" data-action="bootstrap-schema">Bootstrap</button>',
            '<button class="cmdp-button" data-action="save-config">Save config</button>',
            '<span class="cmdp-pill ', schema.ready ? 'ok' : 'error', '">', schema.ready ? 'Ready' : 'Not ready', '</span>',
            '<span class="cmdp-pill ', config.exists ? 'ok' : '', '">', config.exists ? 'Config card' : 'Default config', '</span>',
            '</div>',
            '<div class="cmdp-form cmdp-config">',
            '<label>Runtime config JSON<textarea id="cmdp-runtime-config">', this.escapeHtml(this.prettyJson(config.runtimeConfig || this.defaultRuntimeConfig())), '</textarea></label>',
            '</div>',
            '</section>',
            '<section class="cmdp-grid">',
            '<div>',
            '<h2>Templates</h2>',
            '<table class="cmdp-table"><thead><tr><th>Code</th><th>Description</th><th></th></tr></thead><tbody>',
            templateRows || '<tr><td colspan="3">No templates.</td></tr>',
            '</tbody></table>',
            this.renderModelBrowser(),
            '</div>',
            '<div>',
            '<h2>Editor</h2>',
            '<div class="cmdp-form">',
            '<label>Code<input id="cmdp-code" value="', this.escapeHtml(selected.code || ''), '" ', selected.id ? 'readonly' : '', '></label>',
            '<label>Description<input id="cmdp-description" value="', this.escapeHtml(selected.description || ''), '"></label>',
            '<label class="cmdp-checkbox"><input id="cmdp-active" type="checkbox" ', selected.active !== false ? 'checked' : '', '> Active</label>',
            this.renderVisualBuilder(),
            '<label>Run params JSON<textarea id="cmdp-params">', this.escapeHtml(this.prettyJson(this.state.runParams || {})), '</textarea></label>',
            '<label>Spec JSON<textarea id="cmdp-spec">', this.escapeHtml(this.prettyJson(selected.spec || this.defaultSpec())), '</textarea></label>',
            '<label>Params schema JSON<textarea id="cmdp-params-schema">', this.escapeHtml(this.prettyJson(selected.paramsSchema || {})), '</textarea></label>',
            '<label>Result schema JSON<textarea id="cmdp-result-schema">', this.escapeHtml(this.prettyJson(selected.resultSchema || {})), '</textarea></label>',
            '</div>',
            this.renderTemplateVersions(),
            '</div>',
            '</section>',
            this.renderActionResult(this.state.result)
        ].join(''));
    },

    renderVisualBuilder: function () {
        var kind = this.state.builderKind || 'classes';
        var selectedClass = this.state.selectedClass || '';
        var classOptions = (this.state.classes || []).map(function (classItem) {
            return '<option value="' + this.escapeHtml(classItem.name || '') + '">';
        }, this).join('');
        var selected = function (value) {
            return kind === value ? ' selected' : '';
        };
        return [
            '<section class="cmdp-section">',
            '<h2>Visual Builder</h2>',
            '<div class="cmdp-form cmdp-builder">',
            '<label>Template<select id="cmdp-builder-kind" data-field="builderKind">',
            '<option value="classes"', selected('classes'), '>Classes by attribute</option>',
            '<option value="domainTraversal"', selected('domainTraversal'), '>Domain traversal</option>',
            '<option value="attributeComparison"', selected('attributeComparison'), '>Attribute comparison</option>',
            '<option value="setOperations"', selected('setOperations'), '>Set operations</option>',
            '</select></label>',
            '<label>Attribute type<input id="cmdp-builder-attr-type" value="reference"></label>',
            '<label>Class<input id="cmdp-builder-class-name" list="cmdp-builder-classes" value="', this.escapeHtml(selectedClass), '"></label>',
            '<label>Depth<input id="cmdp-builder-depth" value="1"></label>',
            '<label>Reference class<input id="cmdp-builder-reference-class" list="cmdp-builder-classes" value="', this.escapeHtml(selectedClass), '"></label>',
            '<label>Right type<input id="cmdp-builder-right-type" value="string"></label>',
            '<button class="cmdp-button" data-action="apply-builder">Apply</button>',
            '</div>',
            '<datalist id="cmdp-builder-classes">', classOptions, '</datalist>',
            '</section>'
        ].join('');
    },

    renderTemplateVersions: function () {
        var versions = this.state.templateVersions || [];
        var rows = versions.map(function (version) {
            return [
                '<tr>',
                '<td>', this.escapeHtml(version.version === null || version.version === undefined ? '' : String(version.version)), '</td>',
                '<td>', this.escapeHtml(version.changedAt || ''), '</td>',
                '<td>', this.escapeHtml(version.changedBy || ''), '</td>',
                '<td>', this.escapeHtml(version.changeComment || ''), '</td>',
                '<td><button class="cmdp-button" data-action="load-version" data-version="', this.escapeHtml(version.id), '">Load</button></td>',
                '</tr>'
            ].join('');
        }, this).join('');
        return [
            '<section class="cmdp-section">',
            '<h2>Versions</h2>',
            '<table class="cmdp-table compact"><thead><tr><th>Version</th><th>Changed at</th><th>Changed by</th><th>Comment</th><th></th></tr></thead><tbody>',
            rows || '<tr><td colspan="5">No versions.</td></tr>',
            '</tbody></table>',
            '</section>'
        ].join('');
    },

    renderModelBrowser: function () {
        var classes = this.state.classes || [];
        var attributes = this.state.classAttributes || [];
        var domains = this.state.domains || [];
        var selectedClass = this.state.selectedClass || '';
        var classRows = classes.map(function (classItem) {
            var permissions = classItem.permissions || {};
            var selected = selectedClass === classItem.name ? ' selected' : '';
            return [
                '<tr class="', selected, '">',
                '<td><button class="cmdp-link" data-action="select-class" data-class="', this.escapeHtml(classItem.name || ''), '">',
                this.escapeHtml(classItem.name || ''),
                '</button></td>',
                '<td>', this.escapeHtml(classItem.description || ''), '</td>',
                '<td>', this.renderPermissionFlags(permissions, ['_can_read', '_can_create', '_can_update']), '</td>',
                '</tr>'
            ].join('');
        }, this).join('');
        var attributeRows = attributes.map(function (attribute) {
            return [
                '<tr>',
                '<td>', this.escapeHtml(attribute.name || ''), '</td>',
                '<td>', this.escapeHtml(attribute.type || ''), '</td>',
                '<td>', this.escapeHtml(attribute.description || ''), '</td>',
                '<td>', this.escapeHtml(this.formatAttributeTarget(attribute)), '</td>',
                '<td>', this.renderBoolean(attribute.mandatory), '</td>',
                '<td>', this.renderBoolean(attribute.inherited), '</td>',
                '</tr>'
            ].join('');
        }, this).join('');
        var domainRows = domains.map(function (domain) {
            return [
                '<tr>',
                '<td>', this.escapeHtml(domain.name || ''), '</td>',
                '<td>', this.escapeHtml(this.formatModelList(domain.source, domain.sources)), '</td>',
                '<td>', this.escapeHtml(this.formatModelList(domain.destination, domain.destinations)), '</td>',
                '<td>', this.escapeHtml(domain.cardinality || ''), '</td>',
                '<td>', this.escapeHtml(domain.description || domain.descriptionDirect || ''), '</td>',
                '</tr>'
            ].join('');
        }, this).join('');

        return [
            '<h2>Model</h2>',
            '<div class="cmdp-kpis">',
            this.renderKpi('Classes', String(classes.length)),
            this.renderKpi('Domains', String(domains.length)),
            this.renderKpi('Selected', selectedClass || '-'),
            '</div>',
            '<div class="cmdp-model">',
            '<div>',
            '<h3>Classes</h3>',
            '<table class="cmdp-table compact"><thead><tr><th>Class</th><th>Description</th><th>CRUD</th></tr></thead><tbody>',
            classRows || '<tr><td colspan="3">No classes visible for current user.</td></tr>',
            '</tbody></table>',
            '</div>',
            '<div>',
            '<h3>Attributes', selectedClass ? ' / ' + this.escapeHtml(selectedClass) : '', '</h3>',
            '<table class="cmdp-table compact"><thead><tr><th>Attribute</th><th>Type</th><th>Description</th><th>Target</th><th>Mandatory</th><th>Inherited</th></tr></thead><tbody>',
            attributeRows || '<tr><td colspan="6">Select a class to load attributes.</td></tr>',
            '</tbody></table>',
            '</div>',
            '<div>',
            '<h3>Domains</h3>',
            '<table class="cmdp-table compact"><thead><tr><th>Domain</th><th>Source</th><th>Destination</th><th>Cardinality</th><th>Description</th></tr></thead><tbody>',
            domainRows || '<tr><td colspan="5">No domains visible for current user.</td></tr>',
            '</tbody></table>',
            '</div>',
            '</div>'
        ].join('');
    },

    renderRuntime: function (options) {
        return this.renderLayout([
            '<div class="cmdp-toolbar">',
            '<button class="cmdp-button" data-action="go-home">Home</button>',
            '<button class="cmdp-button" data-action="go-designer">Designer</button>',
            '</div>',
            '<section class="cmdp-section">',
            '<h2>', this.escapeHtml(options.templateCode || ''), '</h2>',
            '<div class="cmdp-muted">', this.escapeHtml(JSON.stringify(options.params || {})), '</div>',
            '</section>',
            options.loading ? this.renderNotice('Loading...', 'info') : '',
            this.renderActionResult(options.result)
        ].join(''));
    },

    renderActionResult: function (result) {
        if (!result) return '';
        if (!result.ok) {
            return this.renderNotice(this.extractError(result), 'error');
        }
        var tables = result.json && result.json.result ? result.json.result.tables || [] : [];
        if (!tables.length) {
            return this.renderNotice('No result tables.', 'info');
        }
        return tables.map(function (table) {
            var columns = table.columns || [];
            var head = columns.map(function (column) {
                return '<th>' + this.escapeHtml(column) + '</th>';
            }, this).join('');
            var rows = (table.rows || []).map(function (row) {
                return '<tr>' + columns.map(function (column) {
                    return '<td>' + this.escapeHtml(row[column] === null || row[column] === undefined ? '' : String(row[column])) + '</td>';
                }, this).join('') + '</tr>';
            }, this).join('');
            return [
                '<section class="cmdp-section">',
                '<h2>', this.escapeHtml(table.name), table.truncated ? ' <span class="cmdp-pill">truncated</span>' : '', '</h2>',
                '<table class="cmdp-table"><thead><tr>', head, '</tr></thead><tbody>',
                rows || '<tr><td colspan="' + Math.max(columns.length, 1) + '">No rows.</td></tr>',
                '</tbody></table>',
                '</section>'
            ].join('');
        }, this).join('');
    },

    renderError: function (error) {
        return this.renderLayout(this.renderNotice(error && error.message ? error.message : String(error), 'error'));
    },

    renderLayout: function (content) {
        return [
            '<style>',
            '.cmdp{font-family:Arial,sans-serif;color:#1f2933;padding:16px;line-height:1.4}',
            '.cmdp h1{font-size:22px;margin:0 0 12px}.cmdp h2{font-size:16px;margin:0 0 10px}',
            '.cmdp-toolbar{display:flex;gap:8px;align-items:center;margin:0 0 12px;flex-wrap:wrap}',
            '.cmdp-button{border:1px solid #9aa5b1;background:#fff;color:#1f2933;padding:6px 10px;border-radius:4px;cursor:pointer}',
            '.cmdp-button.primary{background:#0b5cab;border-color:#0b5cab;color:#fff}.cmdp-link{border:0;background:transparent;color:#0b5cab;padding:0;cursor:pointer;text-align:left}',
            '.cmdp-section{border-top:1px solid #dde3ea;padding:12px 0}.cmdp-grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(420px,2fr);gap:18px;border-top:1px solid #dde3ea;padding-top:12px}',
            '.cmdp-table{border-collapse:collapse;width:100%;background:#fff}.cmdp-table th,.cmdp-table td{border:1px solid #dde3ea;padding:6px 8px;text-align:left;vertical-align:top}.cmdp-table th{background:#f5f7fa}',
            '.cmdp-table.compact th,.cmdp-table.compact td{padding:4px 6px;font-size:12px}.cmdp-table tr.selected td{background:#ebf8ff}.cmdp-model{display:grid;gap:12px;margin-top:10px}.cmdp-model>div{overflow:auto}.cmdp h3{font-size:13px;margin:10px 0 6px;color:#334e68}',
            '.cmdp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}.cmdp-kpi{border:1px solid #dde3ea;padding:8px}.cmdp-kpi span{display:block;color:#52606d;font-size:12px}.cmdp-kpi strong{display:block;font-size:15px}',
            '.cmdp-form{display:grid;gap:8px}.cmdp-form label,.cmdp-row label{display:grid;gap:4px;font-size:12px;color:#52606d}.cmdp-form input,.cmdp-row input,.cmdp-form textarea{border:1px solid #bcccdc;border-radius:4px;padding:6px;font:13px Arial,sans-serif;color:#1f2933}.cmdp-form textarea{min-height:92px;font-family:monospace}.cmdp-config{margin-top:10px}.cmdp-config textarea{min-height:140px}',
            '.cmdp-form select{border:1px solid #bcccdc;border-radius:4px;padding:6px;font:13px Arial,sans-serif;color:#1f2933;background:#fff}.cmdp-builder{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));align-items:end}.cmdp-builder .cmdp-button{align-self:end}',
            '.cmdp-row{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.cmdp-checkbox{display:flex!important;grid-template-columns:auto 1fr;gap:6px;align-items:center;color:#1f2933!important}',
            '.cmdp-notice{padding:8px 10px;border-radius:4px;margin:8px 0;border:1px solid #bcccdc}.cmdp-notice.ok{border-color:#2f855a;color:#22543d;background:#f0fff4}.cmdp-notice.error{border-color:#c53030;color:#742a2a;background:#fff5f5}.cmdp-notice.info{border-color:#3182ce;color:#1a365d;background:#ebf8ff}',
            '.cmdp-pill{display:inline-block;border:1px solid #bcccdc;border-radius:999px;padding:2px 8px;font-size:12px;color:#52606d}.cmdp-pill.ok{border-color:#2f855a;color:#22543d}.cmdp-pill.error{border-color:#c53030;color:#742a2a}.cmdp-muted{color:#52606d;font-size:12px}',
            '@media(max-width:760px){.cmdp-grid{grid-template-columns:1fr}.cmdp{padding:10px}}',
            '</style>',
            '<div class="cmdp">',
            '<h1>CMDB Dynamic Pages</h1>',
            content,
            '</div>'
        ].join('');
    },

    renderShell: function (message) {
        return this.renderLayout(this.renderNotice(message, 'info'));
    },

    renderKpi: function (label, value) {
        return '<div class="cmdp-kpi"><span>' + this.escapeHtml(label) + '</span><strong>' + this.escapeHtml(value) + '</strong></div>';
    },

    renderBoolean: function (value) {
        if (value === null || value === undefined) return '';
        return value ? 'yes' : 'no';
    },

    renderPermissionFlags: function (permissions, names) {
        var labels = {
            _can_read: 'R',
            _can_create: 'C',
            _can_update: 'U',
            _can_delete: 'D',
            _can_modify: 'M'
        };
        return names.map(function (name) {
            var active = Boolean(permissions && permissions[name]);
            return '<span class="cmdp-pill ' + (active ? 'ok' : '') + '">' + this.escapeHtml(labels[name] || name) + '</span>';
        }, this).join(' ');
    },

    formatAttributeTarget: function (attribute) {
        if (!attribute) return '';
        if (attribute.lookupType) return 'lookup: ' + attribute.lookupType;
        if (attribute.targetClass) return attribute.targetClass;
        if (attribute.domain) return attribute.domain + (attribute.direction ? ' / ' + attribute.direction : '');
        if (attribute.targetType) return attribute.targetType;
        return '';
    },

    formatModelList: function (primary, list) {
        var values = [];
        if (primary) values.push(this.formatModelValue(primary));
        if (Array.isArray(list)) {
            Ext.Array.forEach(list, function (item) {
                var value = this.formatModelValue(item);
                if (value && values.indexOf(value) === -1) values.push(value);
            }, this);
        }
        return values.filter(Boolean).join(', ');
    },

    formatModelValue: function (value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return value.name || value._id || value.code || value.description || JSON.stringify(value);
    },

    renderNotice: function (text, type) {
        if (!text) return '';
        return '<div class="cmdp-notice ' + this.escapeHtml(type || 'info') + '">' + this.escapeHtml(text) + '</div>';
    },

    prettyJson: function (value) {
        return JSON.stringify(value === undefined ? {} : value, null, 2);
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
