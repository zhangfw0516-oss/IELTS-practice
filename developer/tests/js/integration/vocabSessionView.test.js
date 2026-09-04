#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');

const originalConsoleLog = (console && typeof console.log === 'function')
    ? console.log.bind(console)
    : null;
let activeDocumentStub = null;
const modalFocusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function emitResult(payload) {
    const text = JSON.stringify(payload, null, 2);
    try {
        if (process && process.stdout && typeof process.stdout.write === 'function') {
            process.stdout.write(text + '\n');
            return;
        }
    } catch (_) {}
    if (typeof originalConsoleLog === 'function') {
        originalConsoleLog(text);
    }
}

function readSource(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function patchVocabSessionView(source) {
    const hook = `
    window.__VocabSessionViewTestHooks = {
        state,
        resetSessionState,
        handlePrimaryButtonClick,
        updatePrimaryAction,
        prepareSessionQueue,
        startReviewFlow,
        startBatch,
        nextCard,
        startBatchSpelling,
        checkBatchSpelling,
        giveBatchSpellingHint,
        skipBatchSpelling,
        finishBatchSession,
        batchWordQuality,
        wordLearningFocus,
        requiresSpelling,
        requeueFailedItem,
        normalizeWord,
        startSelectedMode,
        loadSessionCheckpoint,
        saveSessionCheckpoint,
        clearSessionCheckpoint,
        resumeVocabStudyTime,
        flushVocabStudyTime,
        updateStudyVisibility,
        setTimeStart: (time) => { sessionActiveStartTime = time; },
        markCurrentWordFamiliar,
        buildBritishPronunciationUrl,
        playCurrentPronunciation,
        handleCardAction,
        toggleSidePanel,
        saveCurrentNote,
        openSettingsModal,
        closeSettingsModal,
        handleSettingsSubmit,
        handleImportRequest,
        handleImportInputChange,
        performImport,
        handleExportRequest,
        updateProgressStats,
        setSidePanelExpanded,
        showDueBanner,
        hideDueBanner,
        ensureListSwitcher,
        handleListSwitch,
        updateSidePanelContent,
        updateSidePanelMode,
        closeMenu,
        bindEvents,
        toggleMenu,
        getWordStatus,
        analyzeListWords,
        openListModal,
        closeListModal,
        exportCurrentList,
        renderListBrowser,
        renderCard,
        syncListSwitcherFromStore,
        setElements: (elements) => { state.elements = elements || {}; },
        setStore: (store) => { state.store = store; },
        setScheduler: (scheduler) => { state.scheduler = scheduler; },
        setContainer: (container) => { state.container = container; },
        setRender: (fn) => { render = fn; },
        setViewport: (isMobile) => { state.viewport.isMobile = !!isMobile; }
    };
`;

    return source.replace('const api = {', `${hook}\n    const api = {`);
}

function patchMoreView(source) {
    const hook = `
    global.__MoreViewTestHooks = {
        handleVocabEntry,
        setupMoreViewInteractions
    };
`;
    return source.replace('function init() {', `${hook}\n    function init() {`);
}

function createClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...names) => names.forEach((name) => set.add(name)),
        remove: (...names) => names.forEach((name) => set.delete(name)),
        toggle: (name, force) => {
            if (typeof force === 'boolean') {
                if (force) {
                    set.add(name);
                } else {
                    set.delete(name);
                }
                return force;
            }
            if (set.has(name)) {
                set.delete(name);
                return false;
            }
            set.add(name);
            return true;
        },
        contains: (name) => set.has(name)
    };
}

function dataKeyFromAttribute(attr) {
    return attr
        .slice(5)
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function createElementStub(tag = 'div', overrides = {}) {
    const attributes = new Map();
    const dataset = {};
    const classList = createClassList();
    const listeners = new Map();
    const element = {
        tagName: tag.toUpperCase(),
        dataset,
        style: {},
        classList,
        attributes,
        children: [],
        parentNode: null,
        textContent: '',
        value: '',
        hidden: false,
        disabled: false,
        appendChild(child) {
            if (!child) {
                return child;
            }
            this.children.push(child);
            child.parentNode = this;
            return child;
        },
        removeChild(child) {
            this.children = this.children.filter((item) => item !== child);
            if (child) {
                child.parentNode = null;
            }
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
            if (name === 'hidden') {
                this.hidden = true;
            }
            if (name.startsWith('data-')) {
                dataset[dataKeyFromAttribute(name)] = String(value);
            }
        },
        removeAttribute(name) {
            attributes.delete(name);
            if (name === 'hidden') {
                this.hidden = false;
            }
            if (name.startsWith('data-')) {
                delete dataset[dataKeyFromAttribute(name)];
            }
        },
        getAttribute(name) {
            return attributes.get(name);
        },
        addEventListener(type, handler) {
            if (!listeners.has(type)) {
                listeners.set(type, []);
            }
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            if (!listeners.has(type)) {
                return;
            }
            listeners.set(type, listeners.get(type).filter((fn) => fn !== handler));
        },
        dispatchEvent(event) {
            const handlers = listeners.get(event.type) || [];
            handlers.forEach((handler) => handler(event));
        },
        querySelector(selector) {
            if (this.__queryMap && this.__queryMap[selector]) {
                return this.__queryMap[selector];
            }
            return null;
        },
        querySelectorAll(selector) {
            if (this.__queryListMap && this.__queryListMap[selector]) {
                return this.__queryListMap[selector];
            }
            return [];
        },
        closest(selector) {
            if (selector === '[data-action]' && this.dataset && this.dataset.action) {
                return this;
            }
            return null;
        },
        contains(target) {
            if (!target) {
                return false;
            }
            if (target === this) {
                return true;
            }
            return this.children.some((child) => child.contains && child.contains(target));
        },
        focus() {
            this._focused = true;
            if (activeDocumentStub) {
                activeDocumentStub.activeElement = this;
            }
        },
        click() {
            this._clicked = true;
            const handlers = listeners.get('click') || [];
            handlers.forEach((handler) => handler({ target: this }));
        },
        setSelectionRange() {}
    };
    return Object.assign(element, overrides);
}

function createDocumentStub() {
    const elementsById = new Map();
    const selectorMap = new Map();
    const listeners = new Map();
    const body = createElementStub('body');

    const documentStub = {
        body,
        visibilityState: 'visible',
        activeElement: null,
        addEventListener(type, handler) {
            if (!listeners.has(type)) {
                listeners.set(type, []);
            }
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            if (!listeners.has(type)) {
                return;
            }
            listeners.set(type, listeners.get(type).filter((fn) => fn !== handler));
        },
        dispatchEvent(event) {
            const handlers = listeners.get(event.type) || [];
            handlers.forEach((handler) => handler(event));
        },
        createElement(tag) {
            return createElementStub(tag);
        },
        getElementById(id) {
            return elementsById.get(id) || null;
        },
        querySelector(selector) {
            return selectorMap.get(selector) || null;
        },
        querySelectorAll() {
            return [];
        },
        registerElement(id, element) {
            elementsById.set(id, element);
            return element;
        },
        registerSelector(selector, element) {
            selectorMap.set(selector, element);
            return element;
        }
    };
    activeDocumentStub = documentStub;
    return documentStub;
}

function createWindowStub(documentStub) {
    const messages = [];
    const listeners = new Map();
    const URLStub = {
        created: [],
        createObjectURL(blob) {
            const url = `blob:mock-${this.created.length + 1}`;
            this.created.push({ url, blob });
            return url;
        },
        revokeObjectURL() {}
    };
    const BlobCtor = global.Blob || class Blob {
        constructor(parts = []) {
            this.parts = parts;
        }
    };
    class FormDataStub {
        constructor(form) {
            this._data = new Map(Object.entries(form && form.__fields ? form.__fields : {}));
        }
        get(key) {
            return this._data.has(key) ? this._data.get(key) : null;
        }
    }

    return {
        document: documentStub,
        URL: URLStub,
        Blob: BlobCtor,
        FormData: FormDataStub,
        messages,
        showToast(text, type) {
            messages.push({ channel: 'toast', text, type });
        },
        showMessage(text, type) {
            messages.push({ channel: 'message', text, type });
        },
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        dispatchEvent(event) {
            (listeners.get(event.type) || []).forEach(handler => handler(event));
        },
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
        cancelAnimationFrame: (id) => clearTimeout(id),
        location: { href: 'file:///index.html' }
    };
}

function createMockStore(words = [], config = {}) {
    const baseConfig = {
        dailyNew: 20,
        reviewLimit: 100,
        masteryCount: 4,
        notify: true
    };
    const store = {
        words: words.map((word, index) => ({
            id: word.id || `word-${index + 1}`,
            ...word
        })),
        config: { ...baseConfig, ...config },
        setConfigCalls: 0,
        replaceProgressCalls: [],
        init: async () => true,
        getWords() {
            return this.words;
        },
        getConfig() {
            return this.config;
        },
        async setConfig(next) {
            this.config = { ...this.config, ...next };
            this.setConfigCalls += 1;
        },
        async mergeWords(incoming) {
            const indexByWord = new Map(this.words.map((word, index) => [String(word.word || '').trim().toLowerCase(), index]));
            let addedCount = 0;
            let updatedCount = 0;
            for (const entry of incoming) {
                const key = String(entry.word || '').trim().toLowerCase();
                if (!key) continue;
                if (indexByWord.has(key)) {
                    const index = indexByWord.get(key);
                    this.words[index] = { ...this.words[index], ...entry };
                    updatedCount += 1;
                } else {
                    const word = { id: entry.id || `word-${this.words.length + 1}`, ...entry };
                    indexByWord.set(key, this.words.length);
                    this.words.push(word);
                    addedCount += 1;
                }
            }
            return { words: this.words, addedCount, updatedCount };
        },
        async replaceProgress(next, nextConfig = {}, listId = null) {
            this.words = next.map((word, index) => ({
                id: word.id || `word-${index + 1}`,
                ...word
            }));
            const activeListId = listId || nextConfig.activeListId || this.config.activeListId || 'default';
            this.config = { ...this.config, ...nextConfig, activeListId };
            this.replaceProgressCalls.push({
                listId: activeListId,
                words: this.words.map((word) => ({ ...word })),
                config: { ...this.config }
            });
            return { words: this.words, config: this.config };
        },
        async updateWord(id, patch) {
            const idx = this.words.findIndex((word) => word.id === id);
            if (idx === -1) {
                return null;
            }
            const updated = { ...this.words[idx], ...patch };
            this.words[idx] = updated;
            return updated;
        },
        getDueWords(now) {
            const nowTime = now instanceof Date ? now.getTime() : Date.now();
            return this.words.filter((word) => {
                if (word.familiar || !word.nextReview) {
                    return false;
                }
                const time = new Date(word.nextReview).getTime();
                return Number.isFinite(time) && time <= nowTime;
            });
        },
        getNewWords(limit) {
            const items = this.words.filter((word) => !word.familiar && !word.lastReviewed && !word.nextReview);
            return items.slice(0, limit);
        },
        getActiveListId() {
            return this.config.activeListId || 'default';
        },
        getAvailableLists() {
            return [];
        }
    };
    return store;
}

function createSessionElements() {
    const primaryButton = createElementStub('button');
    const progressBar = createElementStub('div');
    const progressContainer = createElementStub('div');
    progressBar.closest = (selector) => (selector === '.vocab-progress' ? progressContainer : null);

    const chipNew = createElementStub('span');
    chipNew.dataset.chip = 'new';
    const chipReview = createElementStub('span');
    chipReview.dataset.chip = 'review';
    const chipAccuracy = createElementStub('span');
    chipAccuracy.dataset.chip = 'accuracy';

    const progressStats = createElementStub('div');
    progressStats.__queryListMap = {
        '[data-chip]': [chipNew, chipReview, chipAccuracy]
    };

    const dueBanner = createElementStub('section');
    const dueText = createElementStub('p');

    const sessionCard = createElementStub('div');
    const answerInput = createElementStub('input');
    sessionCard.__queryMap = {
        'input[name="answer"]': answerInput,
        '[data-field="batch-spell-input"]': answerInput,
        '[data-field="batch-spell-feedback"]': createElementStub('div')
    };

    const sidePanel = createElementStub('aside');
    const sideSurface = createElementStub('div');
    const toggleButton = createElementStub('button');
    toggleButton.dataset.action = 'toggle-side-panel';
    sidePanel.__queryMap = {
        '[data-action="toggle-side-panel"]': toggleButton
    };

    const noteInput = createElementStub('textarea');
    const noteStatus = createElementStub('span');
    const meaningEl = createElementStub('p');
    const exampleEl = createElementStub('p');
    const metaEl = createElementStub('p');

    const sideBody = createElementStub('div');
    sideBody.__queryMap = {
        '[data-field="meaning"]': meaningEl,
        '[data-field="example"]': exampleEl,
        '[data-field="meta"]': metaEl,
        '[data-field="note"]': noteInput,
        '[data-field="note-status"]': noteStatus
    };

    const importInput = createElementStub('input', {
        click() {
            this._clicked = true;
        }
    });

    const settingsModal = createElementStub('div');
    const settingsDialog = createElementStub('div');
    const settingsClose = createElementStub('button');
    const settingsError = createElementStub('div');
    const settingsForm = createElementStub('form');

    const dailyField = createElementStub('input');
    const reviewField = createElementStub('input');
    const masteryField = createElementStub('input');
    const notifyField = createElementStub('input');

    const listSwitcher = createElementStub('div');
    const menuButton = createElementStub('button');
    const menu = createElementStub('div');
    const listModal = createElementStub('div');
    const listDialog = createElementStub('div');
    const listSubtitle = createElementStub('p');
    const listSearch = createElementStub('input');
    const listLearnedOnly = createElementStub('input');
    const listStats = createElementStub('div');
    const listBody = createElementStub('div');
    const listClose = createElementStub('button');

    settingsDialog.appendChild(dailyField);
    settingsDialog.appendChild(settingsClose);
    settingsDialog.__queryMap = {
        'input, button, select, textarea': dailyField
    };
    settingsDialog.__queryListMap = {
        [modalFocusableSelector]: [dailyField, settingsClose]
    };
    listDialog.appendChild(listSearch);
    listDialog.appendChild(listClose);
    listDialog.__queryListMap = {
        [modalFocusableSelector]: [listSearch, listClose]
    };

    return {
        root: createElementStub('div'),
        primaryButton,
        progressBar,
        progressStats,
        dueBanner,
        dueText,
        sessionCard,
        sidePanel,
        sideSurface,
        sideBody,
        noteInput,
        noteStatus,
        importInput,
        settingsModal,
        settingsDialog,
        settingsError,
        settingsForm,
        settingsFields: {
            dailyNew: dailyField,
            reviewLimit: reviewField,
            masteryCount: masteryField,
            notify: notifyField
        },
        listSwitcher,
        menuButton,
        menu,
        listModal,
        listDialog,
        listSubtitle,
        listSearch,
        listLearnedOnly,
        listStats,
        listBody,
        settingsClose,
        listClose
    };
}

function createVocabContext() {
    const documentStub = createDocumentStub();
    const windowStub = createWindowStub(documentStub);
    const memoryStorage = new Map();
    const storage = {
        getItem: key => memoryStorage.get(key) ?? null,
        setItem: (key, value) => memoryStorage.set(key, String(value)),
        removeItem: key => memoryStorage.delete(key)
    };
    windowStub.localStorage = storage;
    const sandbox = {
        localStorage: storage,
        window: windowStub,
        document: documentStub,
        console,
        setTimeout,
        clearTimeout,
        URL: windowStub.URL,
        Blob: windowStub.Blob,
        FormData: windowStub.FormData
    };
    sandbox.globalThis = sandbox.window;

    const context = vm.createContext(sandbox);
    vm.runInContext(readSource('js/core/vocabScheduler.js'), context, { filename: 'js/core/vocabScheduler.js' });
    vm.runInContext(patchVocabSessionView(readSource('js/components/vocabSessionView.js')),
        context,
        { filename: 'js/components/vocabSessionView.js' }
    );

    return {
        context,
        window: windowStub,
        document: documentStub,
        hooks: windowStub.__VocabSessionViewTestHooks
    };
}

function createMoreViewContext() {
    const documentStub = createDocumentStub();
    const windowStub = createWindowStub(documentStub);
    windowStub.document.readyState = 'complete';
    const sandbox = {
        window: windowStub,
        document: documentStub,
        console,
        setTimeout,
        clearTimeout
    };
    sandbox.globalThis = sandbox.window;

    const context = vm.createContext(sandbox);
    vm.runInContext(patchMoreView(readSource('js/presentation/moreView.js')),
        context,
        { filename: 'js/presentation/moreView.js' }
    );

    return {
        context,
        window: windowStub,
        document: documentStub,
        hooks: windowStub.__MoreViewTestHooks
    };
}

function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

async function run() {
    const results = [];
    const record = async (name, fn) => {
        try {
            await fn();
            results.push({ name, status: 'pass' });
        } catch (error) {
            results.push({
                name,
                status: 'fail',
                detail: error instanceof Error ? error.message : String(error)
            });
        }
    };

    await record('layout template markers', () => {
        const source = readSource('js/components/vocabSessionView.js');
        const markers = [
            'data-vocab-role="topbar"',
            'data-action="primary-cta"',
            'data-action="toggle-menu"',
            'data-action="menu-import"',
            'data-action="menu-export"',
            'data-action="menu-settings"',
            'data-vocab-role="mode-dashboard"',
            'data-action="start-review-mode"',
            'data-action="start-learn-mode"',
            'data-vocab-role="session-card"',
            'data-vocab-role="side-panel"',
            'data-action="toggle-side-panel"',
            'data-action="save-note"',
            'data-vocab-role="import-input"',
            'data-action="menu-view-list"',
            'data-vocab-role="list-modal"',
            'data-vocab-role="list-dialog"',
            'data-action="export-current-list"',
            'data-vocab-role="settings-modal"'
        ];
        markers.forEach((marker) => {
            assert.ok(source.includes(marker), `Missing marker: ${marker}`);
        });
    });

    await record('list modal body owns the table scroll', () => {
        const css = readSource('css/main.css');
        const bodyRule = css.match(/\.vocab-list-modal__body\s*\{([^}]*)\}/);
        const tableWrapRule = css.match(/\.vocab-list-table-wrap\s*\{([^}]*)\}/);
        assert.ok(bodyRule, 'Missing list modal body rule');
        assert.ok(tableWrapRule, 'Missing table wrapper rule');
        assert.match(bodyRule[1], /flex:\s*1 1 220px/);
        assert.match(bodyRule[1], /min-height:\s*0/);
        assert.match(bodyRule[1], /overflow:\s*hidden/);
        assert.match(tableWrapRule[1], /flex:\s*1/);
        assert.match(tableWrapRule[1], /min-height:\s*0/);
        assert.match(tableWrapRule[1], /overflow:\s*auto/);
        assert.doesNotMatch(css, /@media\s*\(max-height:\s*480px\)/);
        assert.doesNotMatch(css, /@media\s*\(max-height:\s*300px\)/);
    });

    const vocabContext = createVocabContext();
    const hooks = vocabContext.hooks;
    const windowStub = vocabContext.window;
    const documentStub = vocabContext.document;

    const elements = createSessionElements();
    hooks.setElements(elements);
    hooks.setRender(() => {});
    hooks.setScheduler(windowStub.VocabScheduler);
    hooks.setContainer(createElementStub('div'));
    hooks.bindEvents();

    await record('primary CTA sets review intent', () => {
        const now = Date.now();
        const store = createMockStore([
            {
                id: 'due-1',
                word: 'alpha',
                meaning: 'A',
                easeFactor: 2.5,
                interval: 1,
                repetitions: 1,
                lastReviewed: new Date(now - 86400000).toISOString(),
                nextReview: new Date(now - 3600000).toISOString()
            },
            { id: 'new-1', word: 'beta', meaning: 'B' }
        ], { dailyNew: 5, reviewLimit: 10 });

        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.updatePrimaryAction();

        assert.strictEqual(elements.primaryButton.dataset.intent, 'review');
    });

    await record('primary CTA sets new intent', () => {
        const store = createMockStore([
            { id: 'new-1', word: 'gamma', meaning: 'G' },
            { id: 'new-2', word: 'delta', meaning: 'D' }
        ], { dailyNew: 1, reviewLimit: 10 });

        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.updatePrimaryAction();

        assert.strictEqual(elements.primaryButton.dataset.intent, 'new');
    });

    await record('primary CTA sets import intent', () => {
        const store = createMockStore([]);
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.updatePrimaryAction();

        assert.strictEqual(elements.primaryButton.dataset.intent, 'import');
        assert.ok(elements.primaryButton.classList.contains('btn-outline'));
    });

    await record('progress stats update chips and bar', () => {
        hooks.resetSessionState();
        hooks.state.session.progress = {
            total: 10,
            completed: 4,
            correct: 3,
            near: 1,
            wrong: 0
        };
        hooks.state.session.newTotal = 2;
        hooks.state.session.dueTotal = 8;

        hooks.updateProgressStats();

        const chips = elements.progressStats.__queryListMap['[data-chip]'];
        assert.ok(chips[0].textContent.includes('2'));
        assert.ok(chips[1].textContent.includes('8'));
        assert.ok(chips[2].textContent.includes('75'));
        assert.strictEqual(elements.progressBar.style.width, '40%');
    });

    await record('due banner toggles visibility', () => {
        hooks.resetSessionState();
        hooks.showDueBanner(3);

        assert.ok(!elements.dueBanner.hidden);
        assert.ok(elements.dueText.textContent.includes('3'));

        hooks.showDueBanner(0);
        assert.ok(elements.dueBanner.hidden);
    });

    await record('primary CTA click respects intent', () => {
        const now = Date.now();
        const store = createMockStore([
            {
                id: 'due-cta',
                word: 'alpha',
                meaning: 'A',
                easeFactor: 2.5,
                interval: 1,
                repetitions: 1,
                lastReviewed: new Date(now - 86400000).toISOString(),
                nextReview: new Date(now - 3600000).toISOString()
            },
            { id: 'new-cta', word: 'beta', meaning: 'B' }
        ]);

        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.state.ui.importing = false;
        elements.importInput._clicked = false;

        elements.primaryButton.dataset.intent = 'import';
        hooks.handlePrimaryButtonClick({
            preventDefault() {},
            currentTarget: elements.primaryButton
        });
        assert.strictEqual(elements.importInput._clicked, true);

        elements.primaryButton.dataset.intent = 'new';
        hooks.handlePrimaryButtonClick({
            preventDefault() {},
            currentTarget: elements.primaryButton
        });

        assert.strictEqual(hooks.state.session.dueTotal, 0);
        assert.ok(hooks.state.session.newTotal > 0);
    });

    await record('start review flow populates session', () => {
        const now = Date.now();
        const store = createMockStore([
            {
                id: 'due-1',
                word: 'alpha',
                meaning: 'A',
                easeFactor: 2.5,
                interval: 1,
                repetitions: 1,
                lastReviewed: new Date(now - 86400000).toISOString(),
                nextReview: new Date(now - 3600000).toISOString()
            },
            { id: 'new-1', word: 'beta', meaning: 'B' }
        ]);

        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.startReviewFlow();

        assert.strictEqual(hooks.state.session.stage, 'recognition');
        assert.ok(hooks.state.session.currentWord);
        assert.strictEqual(hooks.state.session.dueTotal, 1);
        assert.strictEqual(hooks.state.session.newTotal, 0);
    });

    await record('two-pass recognition interleaves known words before batch spelling', () => {
        const store = createMockStore([{ id: 'alpha', word: 'alpha' }, { id: 'beta', word: 'beta' }]);
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.startReviewFlow({ preferNew: true });
        const act = action => hooks.handleCardAction({ target: { closest: () => ({ dataset: { action } }) } });
        act('action-know');
        assert.strictEqual(hooks.state.session.currentWord.id, 'beta');
        assert.strictEqual(hooks.state.session.activeQueue[0].passStage, 1);
        assert.strictEqual(hooks.state.session.completedWords.length, 0);
        act('action-know');
        assert.strictEqual(hooks.state.session.currentWordItem.passStage, 1);
        act('action-p2-know');
        act('action-p2-know');
        assert.strictEqual(hooks.state.session.stage, 'batch-spelling');
        assert.strictEqual(hooks.state.session.spellingWords.length, 2);
        assert.ok(!store.words[0].lastReviewed);
    });

    await record('reading highlights skip spelling while listening errors require it', () => {
        const reading = createMockStore([{ id: 'read', word: 'context' }], { activeListId: 'reading-highlights' });
        hooks.setStore(reading);
        assert.strictEqual(hooks.wordLearningFocus(reading.words[0]), 'recognition');
        assert.strictEqual(hooks.requiresSpelling(reading.words[0]), false);
        const listening = createMockStore([{ id: 'listen', word: 'accommodation' }], { activeListId: 'spelling-errors-p1' });
        hooks.setStore(listening);
        assert.strictEqual(hooks.wordLearningFocus(listening.words[0]), 'spelling');
        assert.strictEqual(hooks.requiresSpelling(listening.words[0]), true);
    });

    await record('recognition-only batch saves without an artificial spelling gate', async () => {
        hooks.resetSessionState();
        const store = createMockStore([{ id: 'read-save', word: 'ecosystem' }], { activeListId: 'reading-highlights' });
        hooks.setStore(store);
        hooks.state.session.recognitionResults['read-save'] = 'good';
        hooks.startBatchSpelling(store.words);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.strictEqual(hooks.state.session.spellingWords.length, 0);
        assert.strictEqual(hooks.state.session.stage, 'batch-summary');
        assert.ok(store.words[0].nextReview);
    });

    await record('three failed recalls stop same-session looping and mark the word wrong', () => {
        hooks.resetSessionState();
        const item = { word: { id: 'leech-today', word: 'obscure' }, passStage: 0, failures: 0 };
        for (let attempt = 0; attempt < 3; attempt += 1) {
            hooks.state.session.activeQueue = [];
            hooks.requeueFailedItem(item);
        }
        assert.strictEqual(item.forcedReview, true);
        assert.strictEqual(item.passStage, 2);
        assert.strictEqual(hooks.state.session.completedWords.length, 1);
    });

    await record('easy delayed recall schedules the longer first reinforcement step', async () => {
        hooks.resetSessionState();
        const store = createMockStore([{ id: 'easy-new', word: 'obvious' }]);
        hooks.setStore(store);
        hooks.startBatchSpelling(store.words);
        hooks.state.session.recognitionResults['easy-new'] = 'easy';
        hooks.state.session.spellingResults['easy-new'] = { answered: true, wrongAttempts: 0, hintUsed: false, skipped: false };
        assert.strictEqual(await hooks.finishBatchSession(), true);
        assert.strictEqual(store.words[0].memoryState, 'learning');
        assert.strictEqual(store.words[0].learningStep, 1);
        const delayMinutes = Math.round((new Date(store.words[0].nextReview) - new Date(store.words[0].lastReviewed)) / 60000);
        assert.strictEqual(delayMinutes, 720);
    });

    await record('batch spelling correct answer persists only once after awaited save', async () => {
        const store = createMockStore([{ id: 'w-1', word: 'alpha', easeFactor: 2.3, interval: 3, repetitions: 2 }]);
        const recorded = [];
        windowStub.StudyStatsManager = { recordWordStudied: w => recorded.push(w), addVocabStudyDuration() {}, render() {} };
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.state.session.progress.total = 1;
        hooks.startBatchSpelling(store.words);
        elements.sessionCard.__queryMap['[data-field="batch-spell-input"]'].value = 'alpha';
        hooks.checkBatchSpelling();
        hooks.checkBatchSpelling(); // double Enter must not enqueue a second advancement
        hooks.skipBatchSpelling();
        await new Promise(resolve => setTimeout(resolve, 650));
        assert.strictEqual(hooks.state.session.spellingIndex, 1);
        assert.strictEqual(hooks.state.session.stage, 'batch-summary');
        assert.deepStrictEqual(recorded, ['alpha']);
        assert.strictEqual(store.words[0].repetitions, 3);
        assert.strictEqual(hooks.state.session.progress.completed, 1);
        await hooks.finishBatchSession();
        assert.deepStrictEqual(recorded, ['alpha']);
        windowStub.StudyStatsManager = null;
    });

    await record('batch misspelling remains wrong even after a later correct answer', async () => {
        const store = createMockStore([{ id: 'w-2', word: 'bravo', easeFactor: 2.5, interval: 4, repetitions: 2 }]);
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.startBatchSpelling(store.words);
        const input = elements.sessionCard.__queryMap['[data-field="batch-spell-input"]'];
        input.value = 'wrong';
        hooks.checkBatchSpelling();
        assert.strictEqual(hooks.state.session.spellingResults['w-2'].wrongAttempts, 1);
        input.value = 'bravo';
        hooks.checkBatchSpelling();
        await new Promise(resolve => setTimeout(resolve, 650));
        assert.strictEqual(hooks.state.session.stage, 'batch-summary');
        assert.strictEqual(store.words[0].correctCount, 0);
        assert.strictEqual(store.words[0].repetitions, 1);
        assert.strictEqual(store.words[0].memoryState, 'relearning');
        assert.strictEqual(hooks.state.session.progress.wrong, 1);
    });

    await record('skipping batch spelling schedules wrong and guards duplicate clicks', async () => {
        const store = createMockStore([{ id: 'w-3', word: 'charlie', easeFactor: 2.5, interval: 4, repetitions: 2 }]);
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.startBatchSpelling(store.words);
        hooks.skipBatchSpelling();
        hooks.skipBatchSpelling();
        await new Promise(resolve => setTimeout(resolve, 1250));
        assert.strictEqual(hooks.state.session.stage, 'batch-summary');
        assert.strictEqual(hooks.state.session.spellingIndex, 1);
        assert.strictEqual(store.words[0].correctCount, 0);
        assert.strictEqual(store.words[0].repetitions, 1);
        assert.strictEqual(store.words[0].memoryState, 'relearning');
        assert.strictEqual(hooks.state.session.progress.wrong, 1);
    });

    await record('recognition batch spelling and summary escape imported word fields', () => {
        const word = { id: 'unsafe', word: '<img src=x onerror="bad()">', meaning: '<svg onload="bad()">', example: '<script>bad()</script>' };
        hooks.resetSessionState();
        hooks.state.session.currentWord = word;
        hooks.state.session.stage = 'recognition';
        hooks.state.session.subStage = 'detail-review';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;img'));
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;svg'));
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;script'));
        assert.ok(!elements.sessionCard.innerHTML.includes('<img'));
        hooks.state.session.spellingWords = [word];
        hooks.state.session.stage = 'batch-spelling';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;svg'));
        assert.ok(!elements.sessionCard.innerHTML.includes('<svg'));
        hooks.state.session.stage = 'batch-summary';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;img'));
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;svg'));
        assert.ok(!elements.sessionCard.innerHTML.includes('<img'));
    });

    await record('recognition renders labeled phonetic and batch spelling omits it', () => {
        hooks.resetSessionState();
        const word = { id: 'phonetic-1', word: 'alpha', meaning: '阿尔法', phonetic: ' /ˈæl.fə ' };
        hooks.state.session.currentWord = word;
        hooks.state.session.stage = 'recognition';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('class="vocab-card__phonetic"'));
        assert.ok(elements.sessionCard.innerHTML.includes('<span class="visually-hidden">音标：</span>'));
        assert.ok(elements.sessionCard.innerHTML.includes('<span>ˈæl.fə</span>'));
        hooks.state.session.stage = 'batch-spelling';
        hooks.state.session.spellingWords = [word];
        hooks.renderCard();
        assert.ok(!elements.sessionCard.innerHTML.includes('ˈæl.fə'));
        assert.ok(!elements.sessionCard.innerHTML.includes('音标'));
    });

    await record('two-pass reveal preserves escaped example and pronunciation fallback', () => {
        hooks.resetSessionState();
        hooks.state.session.currentWord = { id: 'example-1', word: 'emperor', meaning: '皇帝', example: 'The <emperor> ruled wisely.' };
        hooks.state.session.stage = 'recognition';
        hooks.state.session.subStage = 'detail-review';
        hooks.renderCard();
        const markup = elements.sessionCard.innerHTML;
        assert.ok(markup.includes('&lt;'));
        assert.ok(markup.includes('ruled wisely.'));
        assert.ok(!markup.includes('<emperor>'));
        assert.ok(markup.includes('data-action="mark-familiar"'));
        assert.ok(markup.includes('data-action="play-pronounce"'));
        assert.ok(markup.includes('真人英音'));
        assert.ok(markup.includes('data-pronunciation-fallback hidden'));
        assert.ok(markup.includes('https://dictionary.cambridge.org/search/english/direct/?q=emperor'));
        assert.ok(markup.includes('target="_blank"'));
        assert.ok(markup.includes('rel="noopener noreferrer"'));
        hooks.state.session.subStage = 'testing';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('data-action="action-know"'));
        assert.ok(elements.sessionCard.innerHTML.includes('data-action="action-hint"'));
        assert.ok(elements.sessionCard.innerHTML.includes('data-action="action-unknown"'));
    });

    await record('pronunciation plays British human audio in place', async () => {
        const played = [];
        class AudioStub {
            constructor(src) {
                this.src = src;
                this.listeners = {};
            }
            play() {
                played.push(this.src);
                return Promise.resolve();
            }
            pause() {}
            addEventListener(type, handler) {
                this.listeners[type] = handler;
            }
        }
        windowStub.Audio = AudioStub;
        hooks.state.session.currentWord = { id: 'audio-1', word: 'emperor' };
        const label = createElementStub('span');
        const trigger = createElementStub('button', {
            __queryMap: { '.vocab-card__pronounce-label': label }
        });

        const result = await hooks.playCurrentPronunciation(trigger);

        assert.strictEqual(result, true);
        assert.deepStrictEqual(played, [
            'https://ssl.gstatic.com/dictionary/static/sounds/oxford/emperor--_gb_1.mp3'
        ]);
        assert.strictEqual(label.textContent, '正在播放');
        assert.ok(trigger.classList.contains('is-playing'));
        assert.strictEqual(trigger.getAttribute('aria-busy'), 'false');
    });

    await record('missing direct audio reveals the Cambridge fallback', async () => {
        class MissingAudioStub {
            play() {
                return Promise.reject(new Error('missing'));
            }
            pause() {}
            addEventListener() {}
        }
        windowStub.Audio = MissingAudioStub;
        hooks.state.session.currentWord = { id: 'audio-2', word: 'roll-film' };
        const label = createElementStub('span');
        const trigger = createElementStub('button', {
            __queryMap: { '.vocab-card__pronounce-label': label }
        });
        const fallback = createElementStub('a');
        fallback.hidden = true;
        elements.sessionCard.__queryMap['[data-pronunciation-fallback]'] = fallback;

        const result = await hooks.playCurrentPronunciation(trigger);

        assert.strictEqual(result, false);
        assert.strictEqual(trigger.hidden, true);
        assert.strictEqual(fallback.hidden, false);
        assert.ok(windowStub.messages.some((message) => message.text.includes('可到 Cambridge 收听')));
    });

    await record('mark familiar persists the status and removes the word from study', async () => {
        const store = createMockStore([
            { id: 'familiar-1', word: 'familiar', meaning: '熟悉的' }
        ], { masteryCount: 4 });
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.state.session.stage = 'recognition';
        hooks.state.session.currentWord = store.words[0];
        hooks.state.session.progress = { total: 1, completed: 0, correct: 0, near: 0, wrong: 0 };
        hooks.state.session.activeQueue = [{ ...store.words[0] }];
        const trigger = createElementStub('button');

        const marked = await hooks.markCurrentWordFamiliar(trigger);

        assert.strictEqual(marked, true);
        assert.strictEqual(store.words[0].familiar, true);
        assert.ok(store.words[0].familiarAt);
        assert.strictEqual(store.words[0].correctCount, 4);
        assert.strictEqual(store.getNewWords(10).length, 0);
        assert.strictEqual(hooks.state.session.activeQueue.length, 0);
        assert.strictEqual(hooks.state.session.spellingWords.length, 0);
        await flushPromises();
        assert.strictEqual(hooks.state.session.stage, 'batch-summary');
    });

    await record('batch summary preserves phonetic without exposing internal scheduler fields', () => {
        hooks.resetSessionState();
        hooks.state.session.spellingWords = [{ id: 'beta', word: 'beta', meaning: '贝塔', phonetic: 'ˈbiː.tə', easeFactor: 2.5 }];
        hooks.state.session.stage = 'batch-summary';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('ˈbiː.tə'));
        assert.ok(!elements.sessionCard.innerHTML.includes('easeFactor'));
    });

    await record('empty phonetics omit recognition pronunciation details', () => {
        [undefined, '   ', ' /   / ', '/', '///'].forEach(phonetic => {
            hooks.resetSessionState();
            hooks.state.session.currentWord = { id: 'gamma', word: 'gamma', phonetic };
            hooks.state.session.stage = 'recognition';
            hooks.renderCard();
            assert.ok(!elements.sessionCard.innerHTML.includes('class="vocab-card__phonetic"'));
        });
    });

    await record('recognition and batch summary escape malicious phonetics', () => {
        const word = { id: 'unsafe-ph', word: 'delta', phonetic: '/<img src=x onerror="bad()">/' };
        hooks.resetSessionState();
        hooks.state.session.currentWord = word;
        hooks.state.session.stage = 'recognition';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;img'));
        assert.ok(!elements.sessionCard.innerHTML.includes('<img'));
        hooks.state.session.spellingWords = [word];
        hooks.state.session.stage = 'batch-summary';
        hooks.renderCard();
        assert.ok(elements.sessionCard.innerHTML.includes('&lt;img'));
        assert.ok(!elements.sessionCard.innerHTML.includes('<img'));
    });

    await record('next card enters batch spelling after final recognition', () => {
        hooks.resetSessionState();
        const word = { id: 'delta', word: 'delta' };
        hooks.state.session.completedWords = [word];
        hooks.state.session.activeQueue = [];
        hooks.nextCard();
        assert.strictEqual(hooks.state.session.stage, 'batch-spelling');
        assert.strictEqual(hooks.state.session.spellingWords[0].id, 'delta');
    });

    await record('side panel toggle updates state', () => {
        elements.sidePanel.dataset.expanded = 'false';
        hooks.setSidePanelExpanded(true);
        assert.strictEqual(elements.sidePanel.dataset.expanded, 'true');

        hooks.toggleSidePanel();
        assert.strictEqual(elements.sidePanel.dataset.expanded, 'false');
    });

    await record('side panel content updates fields', () => {
        const word = {
            word: 'alpha',
            meaning: 'Meaning',
            example: 'Example',
            source: 'Source',
            note: 'Note text'
        };
        hooks.updateSidePanelContent(word);

        const meaningEl = elements.sideBody.__queryMap['[data-field=\"meaning\"]'];
        const exampleEl = elements.sideBody.__queryMap['[data-field=\"example\"]'];
        const metaEl = elements.sideBody.__queryMap['[data-field=\"meta\"]'];

        assert.strictEqual(meaningEl.textContent, 'Meaning');
        assert.strictEqual(exampleEl.textContent, 'Example');
        assert.strictEqual(metaEl.textContent, 'Source');
        assert.strictEqual(elements.noteInput.value, 'Note text');
    });

    await record('save note writes to store', async () => {
        const store = createMockStore([
            {
                id: 'w-5',
                word: 'echo',
                meaning: 'E'
            }
        ]);

        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.state.session.currentWord = store.words[0];
        elements.noteInput.value = 'remember this';

        await hooks.saveCurrentNote();
        assert.strictEqual(store.words[0].note, 'remember this');
        assert.ok(elements.noteStatus.textContent.length > 0);
    });

    await record('settings modal open and close', () => {
        const store = createMockStore([], { dailyNew: 12, reviewLimit: 50, masteryCount: 5, notify: false });
        hooks.setStore(store);

        hooks.openSettingsModal();
        assert.strictEqual(elements.settingsModal.dataset.open, 'true');
        assert.strictEqual(elements.settingsFields.dailyNew.value, 12);
        assert.strictEqual(elements.settingsFields.reviewLimit.value, 50);
        assert.strictEqual(elements.settingsFields.masteryCount.value, 5);
        assert.strictEqual(elements.settingsFields.notify.checked, false);

        hooks.closeSettingsModal();
        assert.strictEqual(elements.settingsModal.dataset.open, 'false');
        assert.ok(elements.settingsModal.hidden);
    });

    await record('settings submit validates ranges', async () => {
        const store = createMockStore();
        hooks.setStore(store);

        elements.settingsForm.__fields = {
            dailyNew: 'invalid',
            reviewLimit: '10',
            masteryCount: '3'
        };

        await hooks.handleSettingsSubmit({
            preventDefault() {},
            currentTarget: elements.settingsForm
        });

        assert.ok(elements.settingsError.textContent.length > 0);
        assert.strictEqual(store.setConfigCalls, 0);

        elements.settingsForm.__fields = {
            dailyNew: '10',
            reviewLimit: '50',
            masteryCount: '3',
            notify: '1'
        };

        hooks.state.session.batchSize = 1;
        hooks.openSettingsModal(elements.menuButton);
        await hooks.handleSettingsSubmit({
            preventDefault() {},
            currentTarget: elements.settingsForm
        });

        assert.strictEqual(store.setConfigCalls, 1);
        assert.strictEqual(hooks.state.session.batchSize, 10);
        assert.strictEqual(elements.settingsModal.dataset.open, 'false');
    });

    await record('menu toggle opens and closes', () => {
        hooks.resetSessionState();
        hooks.state.menuOpen = false;
        hooks.toggleMenu({ stopPropagation() {} });
        assert.strictEqual(hooks.state.menuOpen, true);
        assert.ok(!elements.menu.hidden);

        hooks.toggleMenu({ stopPropagation() {} });
        assert.strictEqual(hooks.state.menuOpen, false);
        assert.ok(elements.menu.hidden);
    });

    await record('settings modal restores focus to visible menu trigger', () => {
        const hiddenMenuItem = createElementStub('button');
        const trigger = createElementStub('button');
        trigger.dataset.action = 'menu-settings';
        documentStub.activeElement = hiddenMenuItem;
        elements.menuButton._focused = false;

        elements.menu.dispatchEvent({
            type: 'click',
            target: {
                closest(selector) {
                    return selector === 'button[data-action]' ? trigger : null;
                }
            }
        });
        hooks.closeSettingsModal();

        assert.strictEqual(elements.menuButton._focused, true);
        assert.ok(!hiddenMenuItem._focused);
    });

    await record('list status keeps due mastered words in the review queue', () => {
        const config = { masteryCount: 4 };
        const dueMastered = hooks.getWordStatus({
            correctCount: 4,
            nextReview: new Date(Date.now() - 60_000).toISOString()
        }, config);
        const futureMastered = hooks.getWordStatus({
            correctCount: 4,
            nextReview: new Date(Date.now() + 60_000).toISOString()
        }, config);

        assert.strictEqual(dueMastered.tone, 'due');
        assert.strictEqual(futureMastered.tone, 'mastered');

        hooks.setStore(createMockStore([
            { word: 'alpha', meaning: 'A', correctCount: 4, nextReview: new Date(Date.now() - 60_000).toISOString() }
        ], config));
        const analysis = hooks.analyzeListWords();
        assert.strictEqual(analysis.masteredCount, 1);
        assert.strictEqual(analysis.dueCount, 1);
    });

    await record('list modal restores focus to visible menu trigger', async () => {
        const store = createMockStore([{ word: 'alpha', meaning: 'A' }]);
        const hiddenMenuItem = createElementStub('button');
        const trigger = createElementStub('button');
        trigger.dataset.action = 'menu-view-list';
        hooks.setStore(store);
        documentStub.activeElement = hiddenMenuItem;
        elements.menuButton._focused = false;

        elements.menu.dispatchEvent({
            type: 'click',
            target: {
                closest(selector) {
                    return selector === 'button[data-action]' ? trigger : null;
                }
            }
        });
        await flushPromises();
        hooks.closeListModal();

        assert.strictEqual(elements.menuButton._focused, true);
        assert.ok(!hiddenMenuItem._focused);
    });

    await record('Escape cancels a pending list modal open', async () => {
        let resolveInit;
        const store = createMockStore([{ word: 'alpha', meaning: 'A' }]);
        store.init = () => new Promise((resolve) => {
            resolveInit = resolve;
        });
        hooks.setStore(store);
        const opening = hooks.openListModal(elements.menuButton);
        let prevented = false;

        documentStub.dispatchEvent({
            type: 'keydown',
            code: 'Escape',
            preventDefault() {
                prevented = true;
            }
        });
        resolveInit(true);
        await opening;

        assert.strictEqual(prevented, true);
        assert.notStrictEqual(elements.listModal.dataset.open, 'true');
        assert.ok(elements.listModal.hidden);
    });

    await record('list and settings modals remain mutually exclusive', async () => {
        const store = createMockStore([{ word: 'alpha', meaning: 'A' }]);
        hooks.setStore(store);

        await hooks.openListModal(elements.menuButton);
        hooks.openSettingsModal(elements.menuButton);
        assert.strictEqual(elements.settingsModal.dataset.open, 'true');
        assert.strictEqual(elements.listModal.dataset.open, 'false');

        await hooks.openListModal(elements.menuButton);
        assert.strictEqual(elements.listModal.dataset.open, 'true');
        assert.strictEqual(elements.settingsModal.dataset.open, 'false');
        hooks.closeListModal();
    });

    await record('settings writes keep the latest submitted values', async () => {
        const pendingSaves = [];
        const store = createMockStore();
        store.setConfig = (config) => new Promise((resolve) => {
            pendingSaves.push(() => {
                store.config = { ...store.config, ...config };
                resolve(true);
            });
        });
        hooks.setStore(store);
        elements.settingsForm.__fields = {
            dailyNew: '10',
            reviewLimit: '50',
            masteryCount: '3'
        };
        hooks.openSettingsModal(elements.menuButton);
        const pendingSave = hooks.handleSettingsSubmit({
            preventDefault() {},
            currentTarget: elements.settingsForm
        });
        await flushPromises();

        hooks.closeSettingsModal();
        hooks.openSettingsModal(elements.menuButton);
        elements.settingsForm.__fields = {
            dailyNew: '30',
            reviewLimit: '80',
            masteryCount: '5',
            notify: '1'
        };
        const latestSave = hooks.handleSettingsSubmit({
            preventDefault() {},
            currentTarget: elements.settingsForm
        });
        assert.strictEqual(pendingSaves.length, 1);

        pendingSaves.shift()();
        await pendingSave;
        await flushPromises();
        assert.strictEqual(pendingSaves.length, 1);
        pendingSaves.shift()();
        await latestSave;

        assert.strictEqual(store.config.dailyNew, 30);
        assert.strictEqual(store.config.reviewLimit, 80);
        assert.strictEqual(store.config.masteryCount, 5);
        assert.strictEqual(store.config.notify, true);
        assert.strictEqual(elements.settingsModal.dataset.open, 'false');
    });

    await record('Tab stays inside the active modal', async () => {
        let prevented = false;
        hooks.openSettingsModal(elements.menuButton);
        elements.settingsClose.focus();
        documentStub.dispatchEvent({
            type: 'keydown',
            code: 'Tab',
            key: 'Tab',
            shiftKey: false,
            preventDefault() {
                prevented = true;
            }
        });
        assert.strictEqual(prevented, true);
        assert.strictEqual(documentStub.activeElement, elements.settingsFields.dailyNew);

        prevented = false;
        elements.settingsFields.dailyNew.focus();
        documentStub.dispatchEvent({
            type: 'keydown',
            code: 'Tab',
            key: 'Tab',
            shiftKey: true,
            preventDefault() {
                prevented = true;
            }
        });
        assert.strictEqual(prevented, true);
        assert.strictEqual(documentStub.activeElement, elements.settingsClose);
        hooks.closeSettingsModal();

        const store = createMockStore([{ word: 'alpha', meaning: 'A' }]);
        hooks.setStore(store);
        await hooks.openListModal(elements.menuButton);
        elements.listClose.focus();
        documentStub.dispatchEvent({
            type: 'keydown',
            code: 'Tab',
            key: 'Tab',
            shiftKey: false,
            preventDefault() {}
        });
        assert.strictEqual(documentStub.activeElement, elements.listSearch);
        hooks.closeListModal();
    });

    await record('list rendering is paged and resets after search', async () => {
        const words = Array.from({ length: 401 }, (_, index) => ({
            word: `word-${String(index + 1).padStart(3, '0')}`,
            meaning: `Meaning ${index + 1}`
        }));
        const store = createMockStore(words);
        let getWordsCalls = 0;
        const originalGetWords = store.getWords.bind(store);
        store.getWords = () => {
            getWordsCalls += 1;
            return originalGetWords();
        };
        hooks.setStore(store);
        hooks.state.ui.listBrowserQuery = '';
        hooks.state.ui.listBrowserLearnedOnly = false;
        hooks.state.ui.listBrowserPage = 1;

        hooks.renderListBrowser();
        const firstBody = elements.listBody.innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
        assert.strictEqual((firstBody.match(/<tr>/g) || []).length, 200);
        assert.strictEqual(getWordsCalls, 1);

        hooks.state.ui.listBrowserPage = 2;
        hooks.renderListBrowser();
        assert.match(elements.listBody.innerHTML, /<td>201<\/td>/);
        elements.listSearch.dispatchEvent({ type: 'input', target: { value: 'word-401' } });
        assert.strictEqual(hooks.state.ui.listBrowserPage, 1);
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.match(elements.listBody.innerHTML, /word-401/);
    });

    await record('filtered list export remains a complete mergeable word list', async () => {
        const store = createMockStore([
            {
                word: 'alpha',
                meaning: 'A',
                example: 'First',
                phonetic: ' /ˈæl.fə ',
                freq: 0.8,
                correctCount: 2
            },
            {
                word: 'beta',
                meaning: 'B',
                phonetic: ' /   / ',
                note: 'private note',
                questionId: 'internal-id'
            },
            {
                word: 'gamma',
                meaning: 'C',
                phonetic: '/'
            },
            {
                word: 'delta',
                meaning: 'D',
                phonetic: '///'
            }
        ]);
        hooks.setStore(store);
        hooks.state.ui.listBrowserQuery = 'alpha';
        hooks.state.ui.listBrowserLearnedOnly = true;
        windowStub.URL.created.length = 0;
        const anchor = createElementStub('a');
        vocabContext.document.createElement = () => anchor;

        hooks.exportCurrentList();

        const download = windowStub.URL.created.at(-1);
        assert.ok(download, 'Expected an exported blob');
        const payload = JSON.parse(await download.blob.text());
        assert.strictEqual(payload.type, 'wordlist');
        assert.strictEqual(payload.category, 'external');
        assert.strictEqual(payload.entries.length, 4);
        assert.deepStrictEqual(Array.from(payload.entries, (entry) => entry.word), ['alpha', 'beta', 'gamma', 'delta']);
        assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'version'));
        assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'words'));
        assert.ok(!Object.prototype.hasOwnProperty.call(payload.entries[0], 'correctCount'));
        assert.ok(!Object.prototype.hasOwnProperty.call(payload.entries[1], 'questionId'));
        assert.strictEqual(payload.entries[0].phonetic, 'ˈæl.fə');
        assert.ok(!Object.prototype.hasOwnProperty.call(payload.entries[1], 'phonetic'));
        assert.ok(!Object.prototype.hasOwnProperty.call(payload.entries[2], 'phonetic'));
        assert.ok(!Object.prototype.hasOwnProperty.call(payload.entries[3], 'phonetic'));
        assert.match(windowStub.messages.at(-1).text, /可分享词表/);
    });

    await record('card actions are ignored while list modal is open', () => {
        hooks.state.session.stage = 'recognition';
        elements.listModal.dataset.open = 'true';
        let prevented = false;
        hooks.handleCardAction({
            target: {
                closest() {
                    return { dataset: { action: 'reveal-meaning' } };
                }
            },
            preventDefault() {
                prevented = true;
            }
        });
        assert.strictEqual(hooks.state.session.stage, 'recognition');
        assert.strictEqual(prevented, false);
        elements.listModal.dataset.open = 'false';
    });

    await record('import request triggers input', () => {
        const store = createMockStore();
        hooks.setStore(store);
        hooks.state.ui.importing = false;
        hooks.handleImportRequest();
        assert.strictEqual(elements.importInput._clicked, true);
    });

    await record('perform import wordlist merges entries', async () => {
        const store = createMockStore([
            { id: 'w-6', word: 'alpha', meaning: 'Old' }
        ]);
        hooks.setStore(store);
        hooks.state.ui.importing = false;
        windowStub.VocabDataIO = {
            importWordList: async () => ({
                type: 'wordlist',
                entries: [{ word: 'alpha', meaning: 'New' }, { word: 'beta', meaning: 'B' }],
                meta: { category: 'external', name: 'demo' }
            })
        };

        await hooks.performImport({ name: 'mock.json' });
        assert.strictEqual(store.words.length, 2);
        assert.strictEqual(store.words.find((word) => word.word === 'alpha').meaning, 'New');
    });

    await record('perform import progress restores config', async () => {
        const store = createMockStore();
        hooks.setStore(store);
        hooks.state.ui.importing = false;
        let switcherSyncCalls = 0;
        hooks.state.ui.listSwitcher = {
            syncFromStore() {
                switcherSyncCalls += 1;
                return true;
            }
        };
        windowStub.VocabDataIO = {
            importWordList: async () => ({
                type: 'progress',
                entries: [{ word: 'theta', meaning: 'T', nextReview: '2026-07-25T00:00:00.000Z' }],
                meta: {
                    category: 'user',
                    listId: 'spelling-errors-p1',
                    config: { dailyNew: 5, reviewLimit: 10, masteryCount: 2, notify: false }
                }
            })
        };

        await hooks.performImport({ name: 'progress.json' });
        assert.strictEqual(store.words.length, 1);
        assert.strictEqual(store.config.dailyNew, 5);
        assert.strictEqual(store.config.activeListId, 'spelling-errors-p1');
        assert.strictEqual(store.replaceProgressCalls[0].listId, 'spelling-errors-p1');
        assert.strictEqual(store.replaceProgressCalls[0].words[0].nextReview, '2026-07-25T00:00:00.000Z');
        assert.strictEqual(switcherSyncCalls, 1);
        hooks.state.ui.listSwitcher = null;
    });

    await record('export progress triggers download', async () => {
        const store = createMockStore();
        hooks.setStore(store);
        hooks.state.ui.exporting = false;
        windowStub.VocabDataIO = {
            exportProgress: async () => new windowStub.Blob(['data'])
        };

        const anchor = createElementStub('a', {
            click() {
                this._clicked = true;
            }
        });
        vocabContext.document.createElement = () => anchor;
        vocabContext.document.body.appendChild = () => {};
        vocabContext.document.body.removeChild = () => {};

        await hooks.handleExportRequest();
        assert.strictEqual(anchor._clicked, true);
    });

    await record('keyboard shortcuts map first and second pass actions', () => {
        hooks.resetSessionState();
        hooks.setStore(createMockStore([{ id: 'keyboard', word: 'keyboard' }]));
        hooks.startReviewFlow({ preferNew: true });
        documentStub.activeElement = null;
        let prevented = false;
        documentStub.dispatchEvent({ type: 'keydown', code: 'Digit1', preventDefault() { prevented = true; } });
        assert.strictEqual(prevented, true);
        assert.strictEqual(hooks.state.session.currentWordItem.passStage, 1);
        documentStub.dispatchEvent({ type: 'keydown', code: 'KeyJ', preventDefault() {} });
        assert.strictEqual(hooks.state.session.stage, 'batch-spelling');
    });

    await record('keyboard is ignored when vocab is inactive or tool modal is open', () => {
        hooks.resetSessionState();
        hooks.setStore(createMockStore([{ id: 'inactive', word: 'inactive' }]));
        hooks.startReviewFlow({ preferNew: true });
        const container = hooks.state.container;
        container.hidden = true;
        documentStub.dispatchEvent({ type: 'keydown', code: 'Digit1', preventDefault() { throw new Error('inactive key captured'); } });
        assert.strictEqual(hooks.state.session.currentWordItem.passStage, 0);
        container.hidden = false;
        const selector = '.vocab-tool-modal, .vocab-dict-drawer, .vocab-wordlist-shell, .account-modal-overlay.active';
        documentStub.registerSelector(selector, createElementStub('div'));
        documentStub.dispatchEvent({ type: 'keydown', code: 'Digit1', preventDefault() { throw new Error('modal key captured'); } });
        assert.strictEqual(hooks.state.session.currentWordItem.passStage, 0);
        documentStub.registerSelector(selector, null);
    });

    await record('keyboard ignores editable fields and repeated keydown', () => {
        hooks.resetSessionState();
        hooks.setStore(createMockStore([{ id: 'editable', word: 'editable' }]));
        hooks.startReviewFlow({ preferNew: true });
        documentStub.activeElement = elements.noteInput;
        documentStub.dispatchEvent({ type: 'keydown', code: 'KeyJ', preventDefault() { throw new Error('typing captured'); } });
        documentStub.activeElement = null;
        documentStub.dispatchEvent({ type: 'keydown', code: 'Digit1', repeat: true, preventDefault() { throw new Error('repeat captured'); } });
        assert.strictEqual(hooks.state.session.currentWordItem.passStage, 0);
    });


    await record('review has no new words at partial or full capacity and dailyNew zero is respected', () => {
        const due = { id: 'due-quota', word: 'due', lastReviewed: new Date(0).toISOString(), nextReview: new Date(0).toISOString() };
        const fresh = { id: 'new-quota', word: 'new' };
        const store = createMockStore([due, fresh], { dailyNew: 0, reviewLimit: 100 });
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.prepareSessionQueue();
        assert.deepStrictEqual(Array.from(hooks.state.session.backlog, w => w.id), ['due-quota']);
        store.config.reviewLimit = 1;
        hooks.prepareSessionQueue();
        assert.deepStrictEqual(Array.from(hooks.state.session.backlog, w => w.id), ['due-quota']);
        hooks.prepareSessionQueue({ preferNew: true });
        assert.strictEqual(hooks.state.session.backlog.length, 0);
        store.config.dailyNew = 1;
        hooks.prepareSessionQueue({ preferNew: true });
        assert.deepStrictEqual(Array.from(hooks.state.session.backlog, w => w.id), ['new-quota']);
    });

    await record('new-word quota shrinks with review backlog and pauses at fifty due words', () => {
        const due = Array.from({ length: 20 }, (_, index) => ({
            id: `due-${index}`, word: `due${index}`, lastReviewed: new Date(0).toISOString(), nextReview: new Date(0).toISOString()
        }));
        const fresh = Array.from({ length: 20 }, (_, index) => ({ id: `fresh-${index}`, word: `fresh${index}` }));
        const store = createMockStore(due.concat(fresh), { dailyNew: 20, reviewLimit: 100 });
        hooks.setStore(store);
        hooks.resetSessionState();
        hooks.prepareSessionQueue({ preferNew: true });
        assert.strictEqual(hooks.state.session.backlog.length, 10);

        store.words = Array.from({ length: 50 }, (_, index) => ({
            id: `overdue-${index}`, word: `overdue${index}`, lastReviewed: new Date(0).toISOString(), nextReview: new Date(0).toISOString()
        })).concat(fresh);
        hooks.prepareSessionQueue({ preferNew: true });
        assert.strictEqual(hooks.state.session.backlog.length, 0);
        assert.strictEqual(hooks.state.session.emptyReason, 'review-backlog');
    });

    await record('hint-only spelling is hard not good and survives checkpoint roundtrip', () => {
        hooks.resetSessionState();
        const store = createMockStore([{ id: 'hint', word: 'hint' }], { activeListId: 'list-hint' });
        hooks.setStore(store);
        hooks.startBatchSpelling(store.words);
        hooks.giveBatchSpellingHint();
        assert.strictEqual(hooks.batchWordQuality(store.words[0]), 'hard');
        assert.strictEqual(hooks.state.session.spellingInput, 'h');
        const checkpoint = hooks.loadSessionCheckpoint();
        assert.strictEqual(checkpoint.spellingResults.hint.hintUsed, true);
        assert.strictEqual(checkpoint.listId, 'list-hint');
        hooks.clearSessionCheckpoint();
        assert.strictEqual(hooks.loadSessionCheckpoint(), null);
        assert.strictEqual(JSON.parse(windowStub.localStorage.getItem('ielts_vocab_session_checkpoint')).cleared, true);
    });

    await record('partial batch save failure keeps checkpoint and retry does not reschedule saved words', async () => {
        hooks.resetSessionState();
        const store = createMockStore([{ id: 'save-a', word: 'alpha' }, { id: 'save-b', word: 'beta' }]);
        hooks.setStore(store);
        hooks.startBatchSpelling(store.words);
        hooks.state.session.spellingResults = {
            'save-a': { answered: true }, 'save-b': { answered: true, hintUsed: true }
        };
        const update = store.updateWord.bind(store);
        const calls = [];
        let rejectSecond = true;
        store.updateWord = async (id, patch) => {
            calls.push(id);
            if (id === 'save-b' && rejectSecond) throw new Error('disk quota');
            return update(id, patch);
        };
        const counted = [];
        windowStub.StudyStatsManager = { recordWordStudied: w => counted.push(w), addVocabStudyDuration() {}, render() {} };
        assert.strictEqual(await hooks.finishBatchSession(), false);
        assert.strictEqual(hooks.state.session.stage, 'batch-save-error');
        assert.strictEqual(hooks.loadSessionCheckpoint().savedWordIds[0], 'save-a');
        assert.deepStrictEqual(counted, []);
        rejectSecond = false;
        assert.strictEqual(await hooks.finishBatchSession(), true);
        assert.deepStrictEqual(calls, ['save-a', 'save-b', 'save-b']);
        assert.deepStrictEqual(counted, ['alpha', 'beta']);
        assert.strictEqual(hooks.loadSessionCheckpoint(), null);
        windowStub.StudyStatsManager = null;
    });

    await record('batch cannot finalize unanswered words or clear progress while writes are pending', async () => {
        hooks.resetSessionState();
        const store = createMockStore([{ id: 'pending', word: 'pending' }]);
        hooks.setStore(store);
        hooks.startBatchSpelling(store.words);
        assert.strictEqual(await hooks.finishBatchSession(), false);
        assert.strictEqual(hooks.state.session.stage, 'batch-spelling');
        hooks.state.session.spellingResults.pending = { answered: true };
        const update = store.updateWord.bind(store);
        let release;
        store.updateWord = (id, patch) => new Promise(resolve => { release = async () => resolve(await update(id, patch)); });
        const first = hooks.finishBatchSession();
        assert.strictEqual(hooks.state.session.stage, 'batch-saving');
        assert.ok(hooks.loadSessionCheckpoint());
        assert.strictEqual(await hooks.finishBatchSession(), false);
        await release();
        assert.strictEqual(await first, true);
    });

    await record('normalization retains scheduler history notes and source metadata', () => {
        const original = { id: 'history', word: 'history', easeFactor: 2.2, repetitions: 7, interval: 90,
            note: 'custom note', source: 'custom list', familiarAt: '2026-01-01T00:00:00.000Z' };
        const normalized = hooks.normalizeWord(original);
        for (const key of ['easeFactor', 'repetitions', 'interval', 'note', 'source', 'familiarAt']) {
            assert.strictEqual(normalized[key], original[key]);
        }
    });

    await record('timer stops in background another view and mode dashboard and resumes visible study', () => {
        hooks.resetSessionState();
        hooks.state.session.stage = 'recognition';
        hooks.state.ui.sessionVisible = true;
        hooks.state.container.hidden = false;
        documentStub.visibilityState = 'visible';
        let seconds = 0;
        windowStub.StudyStatsManager = { addVocabStudyDuration: n => { seconds += n; }, render() {} };
        hooks.setTimeStart(Date.now() - 5000);
        documentStub.visibilityState = 'hidden';
        hooks.updateStudyVisibility();
        assert.ok(seconds >= 5 && seconds <= 6);
        const afterHide = seconds;
        hooks.flushVocabStudyTime();
        assert.strictEqual(seconds, afterHide);
        documentStub.visibilityState = 'visible';
        hooks.updateStudyVisibility();
        hooks.setTimeStart(Date.now() - 3000);
        hooks.state.container.hidden = true;
        hooks.updateStudyVisibility();
        assert.ok(seconds >= afterHide + 3 && seconds <= afterHide + 4);
        const afterNavigate = seconds;
        hooks.flushVocabStudyTime();
        assert.strictEqual(seconds, afterNavigate);
        hooks.state.container.hidden = false;
        hooks.state.ui.sessionVisible = false;
        hooks.updateStudyVisibility();
        hooks.flushVocabStudyTime();
        assert.strictEqual(seconds, afterNavigate);
        windowStub.StudyStatsManager = null;
    });

    await record('pronunciation streams cancel the previous player without silent synthetic fallback', async () => {
        const instances = [];
        class SingleAudio {
            constructor(src) { this.src = src; instances.push(this); }
            play() { return Promise.resolve(); }
            pause() { this.paused = true; }
            addEventListener() {}
        }
        windowStub.Audio = SingleAudio;
        await hooks.playCurrentPronunciation(null, { word: 'first' });
        await hooks.playCurrentPronunciation(null, { word: 'second' });
        assert.strictEqual(instances[0].paused, true);
        assert.ok(instances[1].src.includes('second'));
        const source = readSource('js/components/vocabSessionView.js');
        const player = source.slice(source.indexOf('    function playWordPronunciation('), source.indexOf('    function formatWordDate('));
        assert.ok(!player.includes('speechSynthesis.speak'));
    });

    await record('checkpoint from a different word list is not resumed', () => {
        hooks.resetSessionState();
        hooks.setStore(createMockStore([{ id: 'current', word: 'current' }], { activeListId: 'current-list' }));
        windowStub.localStorage.setItem('ielts_vocab_session_checkpoint', JSON.stringify({
            timestamp: Date.now(), mode: 'learn', listId: 'different-list', stage: 'recognition',
            currentWord: { id: 'foreign', word: 'foreign' }, activeQueue: []
        }));
        hooks.startSelectedMode('learn');
        assert.strictEqual(hooks.state.session.currentWord.id, 'current');
        assert.strictEqual(hooks.loadSessionCheckpoint().listId, 'current-list');
    });


    await record('unchanged checkpoint keeps its timestamp and remote updates invalidate stale queues', () => {
        hooks.resetSessionState();
        hooks.setStore(createMockStore([{ id: 'local-only', word: 'local' }]));
        hooks.startReviewFlow({ preferNew: true });
        const key = 'ielts_vocab_session_checkpoint';
        const saved = JSON.parse(windowStub.localStorage.getItem(key));
        saved.timestamp = 42;
        windowStub.localStorage.setItem(key, JSON.stringify(saved));
        hooks.flushVocabStudyTime();
        assert.strictEqual(JSON.parse(windowStub.localStorage.getItem(key)).timestamp, 42);
        const remote = { timestamp: 99, mode: 'learn', listId: 'default', stage: 'recognition',
            currentWord: { id: 'remote-word', word: 'remote' }, activeQueue: [] };
        windowStub.localStorage.setItem(key, JSON.stringify(remote));
        windowStub.dispatchEvent({ type: 'ielts:vocab-checkpoint-updated' });
        assert.strictEqual(hooks.state.ui.sessionVisible, false);
        assert.strictEqual(hooks.state.session.currentWord, null);
        hooks.flushVocabStudyTime();
        assert.strictEqual(JSON.parse(windowStub.localStorage.getItem(key)).timestamp, 99);
        assert.strictEqual(hooks.loadSessionCheckpoint().currentWord.id, 'remote-word');
    });

    await record('list switcher attaches handler', () => {
        const store = createMockStore([
            { id: 'w-7', word: 'zeta', meaning: 'Z' }
        ]);
        hooks.setStore(store);
        hooks.resetSessionState();

        let renderCalled = false;
        windowStub.VocabListSwitcher = class {
            constructor() {}
            render(container) {
                renderCalled = true;
                container.rendered = true;
            }
        };

        hooks.ensureListSwitcher();
        assert.strictEqual(renderCalled, true);
        assert.strictEqual(elements.listSwitcher.rendered, true);
    });

    await record('more view vocab entry navigates', () => {
        const moreContext = createMoreViewContext();
        const moreHooks = moreContext.hooks;
        const moreDoc = moreContext.document;
        const moreWindow = moreContext.window;

        const moreView = createElementStub('div', { classList: createClassList(['active']) });
        const vocabView = createElementStub('section');
        vocabView.setAttribute('hidden', 'hidden');
        const navButton = createElementStub('button', { classList: createClassList() });
        moreDoc.registerElement('more-view', moreView);
        moreDoc.registerElement('vocab-view', vocabView);
        moreDoc.registerSelector('.nav-btn[data-view="more"]', navButton);

        let navigatedTo = null;
        moreWindow.app = {
            navigateToView(view) {
                navigatedTo = view;
            }
        };
        moreWindow.VocabSessionView = {
            mount() {
                this._mounted = true;
            }
        };

        moreHooks.handleVocabEntry({ preventDefault() {} });

        assert.strictEqual(navigatedTo, 'vocab');
        assert.ok(!vocabView.hidden);
        assert.ok(moreWindow.VocabSessionView._mounted);
        assert.ok(navButton.classList.contains('active'));
    });

    await record('more view fallback without app', () => {
        const moreContext = createMoreViewContext();
        const moreHooks = moreContext.hooks;
        const moreDoc = moreContext.document;
        const moreWindow = moreContext.window;

        const moreView = createElementStub('div', { classList: createClassList(['active']) });
        const vocabView = createElementStub('section');
        vocabView.setAttribute('hidden', 'hidden');
        const navButton = createElementStub('button', { classList: createClassList() });
        moreDoc.registerElement('more-view', moreView);
        moreDoc.registerElement('vocab-view', vocabView);
        moreDoc.registerSelector('.nav-btn[data-view="more"]', navButton);

        moreWindow.app = null;
        moreWindow.VocabSessionView = {
            mount() {
                this._mounted = true;
            }
        };

        moreHooks.handleVocabEntry({ preventDefault() {} });

        assert.ok(vocabView.classList.contains('active'));
        assert.ok(!vocabView.hidden);
        assert.ok(navButton.classList.contains('active'));
        assert.ok(moreWindow.VocabSessionView._mounted);
    });

    const failed = results.filter((item) => item.status === 'fail');
    const payload = {
        status: failed.length ? 'fail' : 'pass',
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        results,
        detail: failed.length ? 'Some tests failed' : 'All tests passed'
    };

    emitResult(payload);
    process.exit(failed.length ? 1 : 0);
}

run().catch((error) => {
    emitResult({
        status: 'fail',
        total: 1,
        passed: 0,
        failed: 1,
        results: [{ name: 'test runner', status: 'fail', detail: error.message }],
        detail: 'Unhandled error'
    });
    process.exit(1);
});
