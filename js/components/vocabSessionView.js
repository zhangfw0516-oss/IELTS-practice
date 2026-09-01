(function(window) {
    const DEFAULT_BATCH_SIZE = 24;
    const RETRY_DELAYS = Object.freeze({
        wrong: 60 * 1000,
        near: 10 * 60 * 1000,
        correct: 24 * 60 * 60 * 1000
    });
    const KEY_BINDINGS = Object.freeze({
        Enter: 'submit',
        NumpadEnter: 'submit',
        KeyF: 'reveal',
        Escape: 'escape'
    });

    const CONFIG_LIMITS = Object.freeze({
        dailyNew: { min: 0, max: 200 },
        reviewLimit: { min: 1, max: 300 },
        masteryCount: { min: 1, max: 10 }
    });
    const LIST_PAGE_SIZE = 200;
    const LIST_SEARCH_DEBOUNCE_MS = 180;
    const MODAL_FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const state = {
        container: null,
        elements: {},
        initialized: false,
        store: null,
        scheduler: null,
        viewport: {
            isMobile: false,
            mediaQuery: null
        },
        menuOpen: false,
        ui: {
            sidePanelManual: null,
            importing: false,
            exporting: false,
            listBrowserQuery: '',
            listBrowserLearnedOnly: false,
            listBrowserPage: 1,
            listSearchTimer: null,
            modalEpoch: 0,
            modalOwner: null,
            settingsRestoreFocus: null,
            listRestoreFocus: null,
            settingsSaveToken: 0,
            settingsSaveTail: Promise.resolve(),
            listSwitcher: null,
            listSwitcherListenerAttached: false
        },
        session: {
            stage: 'loading',
            backlog: [],
            activeQueue: [],
            completed: [],
            currentWord: null,
            progress: {
                total: 0,
                completed: 0,
                correct: 0,
                near: 0,
                wrong: 0
            },
            batchSize: DEFAULT_BATCH_SIZE,
            batchIndex: 0,
            dueTotal: 0,
            newTotal: 0,
            duePending: 0,
            meaningVisible: false,
            recognitionFailed: false,
            recognitionMode: 'idle',
            lastAnswer: null,
            typedAnswer: '',
            queueSeed: 0
        },
        keyboardHandler: null,
        outsideClickHandler: null
    };

    let activePronunciationAudio = null;
    let pronunciationEpoch = 0;

    function resolveContainer(target) {
        if (!target) {
            return null;
        }
        if (typeof target === 'string') {
            return document.querySelector(target);
        }
        return target;
    }

    function showFeedbackMessage(message, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
            return;
        }
        if (typeof window.showMessage === 'function') {
            window.showMessage(message, type, 4000);
            return;
        }
        console.info('[VocabSessionView]', message);
    }

    function isSettingsModalOpen() {
        return state.elements.settingsModal?.dataset.open === 'true';
    }

    function isListModalOpen() {
        return state.elements.listModal?.dataset.open === 'true';
    }

    function isListModalPending() {
        return state.ui.modalOwner === 'list-pending';
    }

    function focusElement(target) {
        const fallback = state.elements.menuButton;
        const focusTarget = target && typeof target.focus === 'function' ? target : fallback;
        if (focusTarget && typeof focusTarget.focus === 'function') {
            focusTarget.focus();
        }
    }

    function trapModalFocus(event, dialog) {
        if (!dialog) {
            return;
        }
        const focusable = Array.from(dialog.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
            .filter((element) => !element.hidden && !element.disabled);
        if (!focusable.length) {
            event.preventDefault();
            focusElement(dialog);
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
            event.preventDefault();
            focusElement(last);
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
            event.preventDefault();
            focusElement(first);
        }
    }

    function clearListSearchTimer() {
        if (state.ui.listSearchTimer) {
            clearTimeout(state.ui.listSearchTimer);
            state.ui.listSearchTimer = null;
        }
    }

    function clampNumber(value, min, max) {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return null;
        }
        return Math.min(max, Math.max(min, Math.floor(value)));
    }

    function formatTimestamp() {
        const date = new Date();
        const parts = [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
        ];
        const time = [
            String(date.getHours()).padStart(2, '0'),
            String(date.getMinutes()).padStart(2, '0')
        ];
        return `${parts.join('')}-${time.join('')}`;
    }

    function triggerDownload(blob, filename) {
        if (!(blob instanceof Blob)) {
            throw new Error('导出内容为空');
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function resetSessionState() {
        stopActivePronunciation();
        state.session.backlog = [];
        state.session.activeQueue = [];
        state.session.completed = [];
        state.session.currentWord = null;
        state.session.progress = {
            total: 0,
            completed: 0,
            correct: 0,
            near: 0,
            wrong: 0
        };
        state.session.batchIndex = 0;
        state.session.meaningVisible = false;
        state.session.recognitionQuality = null;
        state.session.spellingAttempts = 0;
        state.session.lastAnswer = null;
        state.session.typedAnswer = '';
        state.session.stage = 'loading';
    }

    function setupViewportWatcher() {
        if (typeof window.matchMedia !== 'function') {
            state.viewport.isMobile = false;
            return;
        }
        const mq = window.matchMedia('(max-width: 768px)');
        const update = (event) => {
            state.viewport.isMobile = !!event.matches;
            updateSidePanelMode();
        };
        state.viewport.mediaQuery = mq;
        state.viewport.isMobile = mq.matches;
        if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', update);
        } else if (typeof mq.addListener === 'function') {
            mq.addListener(update);
        }
    }

    function createLayout(target) {
        const layout = document.createElement('div');
        layout.className = 'vocab-view-shell';
        layout.innerHTML = `
            <header class="vocab-topbar" data-vocab-role="topbar">
                <div class="vocab-topbar__container">
                    <div class="vocab-topbar__section vocab-topbar__section--left">
                        <button class="btn btn-icon" type="button" data-action="return-more" aria-label="返回更多工具">←</button>
                        <div class="vocab-topbar__titles">
                            <h2 class="vocab-topbar__heading">背单词</h2>
                            <p class="vocab-topbar__subtitle">按你的记忆节奏安排复习</p>
                        </div>
                    </div>
                    <div class="vocab-topbar__section vocab-topbar__section--center" data-vocab-role="progress">
                        <div class="vocab-progress__label">
                            <span>本轮进度</span>
                            <strong data-vocab-role="progress-count">0 / 0</strong>
                        </div>
                        <div class="vocab-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                            <div class="vocab-progress__track">
                                <div class="vocab-progress__fill" data-vocab-role="progress-bar"></div>
                            </div>
                        </div>
                        <div class="vocab-progress__chips" data-vocab-role="progress-stats">
                            <span class="chip" data-chip="new">新词 0</span>
                            <span class="chip" data-chip="review">复习 0</span>
                            <span class="chip" data-chip="accuracy">正确率 0%</span>
                        </div>
                    </div>
                    <div class="vocab-topbar__section vocab-topbar__section--right">
                        <button class="btn btn-primary" type="button" data-action="primary-cta">开始复习</button>
                        <div class="vocab-topbar__menu">
                            <button class="btn btn-ghost btn-icon" type="button" data-action="toggle-menu" aria-haspopup="true" aria-expanded="false">⋮</button>
                            <div class="vocab-menu" data-vocab-role="menu" hidden>
                                <div class="vocab-menu__panel" data-vocab-role="menu-panel-main">
                                    <button type="button" data-action="menu-lists">切换词表</button>
                                    <button type="button" data-action="menu-view-list">查看词表</button>
                                    <button type="button" data-action="menu-import">导入词表</button>
                                    <button type="button" data-action="menu-export">导出进度</button>
                                    <button type="button" data-action="menu-settings">学习设置</button>
                                </div>
                                <div class="vocab-menu__panel" data-vocab-role="menu-panel-lists" hidden>
                                    <button type="button" data-action="menu-back-lists">← 返回菜单</button>
                                    <div class="vocab-menu__list-switcher" data-vocab-role="list-switcher"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </header>
            <div class="vocab-topbar-spacer" aria-hidden="true"></div>
            <section class="vocab-due-banner" data-vocab-role="due-banner" hidden>
                <div class="vocab-due-banner__container">
                    <div class="vocab-due-banner__content">
                        <span class="vocab-due-banner__icon" aria-hidden="true">⏰</span>
                        <p class="vocab-due-banner__text" data-vocab-role="due-text">你有 0 个到期复习，建议先复习。</p>
                    </div>
                    <button class="btn btn-sm btn-outline" type="button" data-action="start-review">开始复习</button>
                </div>
            </section>
            <main class="vocab-body" data-vocab-role="main">
                <div class="vocab-body__container">
                    <div class="vocab-body__grid">
                        <article class="vocab-session-card" data-vocab-role="session-card"></article>
                        <aside class="vocab-side-panel" data-vocab-role="side-panel" data-expanded="false">
                            <button class="vocab-side-panel__toggle" type="button" data-action="toggle-side-panel" aria-expanded="false">词汇详情</button>
                            <div class="vocab-side-panel__surface" data-vocab-role="side-surface">
                                <section class="vocab-side-panel__section">
                                    <h3>释义</h3>
                                    <p data-field="meaning" class="vocab-side-panel__meaning">—</p>
                                </section>
                                <section class="vocab-side-panel__section">
                                    <h3>例句</h3>
                                    <p data-field="example" class="vocab-side-panel__example">暂无例句</p>
                                </section>
                                <section class="vocab-side-panel__section vocab-side-panel__meta">
                                    <h3>来源与标签</h3>
                                    <p data-field="meta">内置 IELTS 核心词表</p>
                                </section>
                                <section class="vocab-side-panel__section">
                                    <h3>笔记</h3>
                                    <textarea data-field="note" rows="4" placeholder="记录你的记忆技巧…"></textarea>
                                    <div class="vocab-side-panel__note-actions">
                                        <button class="btn btn-sm btn-primary" type="button" data-action="save-note">保存笔记</button>
                                        <span class="vocab-side-panel__note-status" data-field="note-status"></span>
                                    </div>
                                </section>
                            </div>
                        </aside>
                    </div>
                </div>
            </main>
            <div class="visually-hidden" aria-live="polite" data-vocab-role="live-region"></div>
            <input type="file" accept=".json,.csv" data-vocab-role="import-input" hidden>
            <div class="vocab-list-modal" data-vocab-role="list-modal" hidden>
                <div class="vocab-list-modal__backdrop" data-action="close-list-modal" tabindex="-1"></div>
                <div class="vocab-list-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="vocab-list-title" data-vocab-role="list-dialog" tabindex="-1">
                    <header class="vocab-list-modal__header">
                        <div>
                            <h3 id="vocab-list-title">词表</h3>
                            <p class="vocab-list-modal__subtitle" data-vocab-role="list-subtitle">当前词表 0 个词</p>
                        </div>
                        <button class="btn btn-icon" type="button" data-action="close-list-modal" aria-label="关闭词表">×</button>
                    </header>
                    <div class="vocab-list-modal__toolbar">
                        <input type="search" data-vocab-role="list-search" placeholder="搜索单词、释义、笔记">
                        <label class="vocab-list-modal__filter">
                            <input type="checkbox" data-vocab-role="list-learned-only">
                            <span>只看已学</span>
                        </label>
                        <button class="btn btn-sm btn-outline" type="button" data-action="export-current-list">导出可分享词表</button>
                    </div>
                    <div class="vocab-list-modal__stats" data-vocab-role="list-stats"></div>
                    <div class="vocab-list-modal__body" data-vocab-role="list-body"></div>
                </div>
            </div>
            <div class="vocab-settings-modal" data-vocab-role="settings-modal" hidden>
                <div class="vocab-settings-modal__backdrop" data-action="close-settings" tabindex="-1"></div>
                <div class="vocab-settings-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="vocab-settings-title" data-vocab-role="settings-dialog" tabindex="-1">
                    <header class="vocab-settings-modal__header">
                        <div>
                            <h3 id="vocab-settings-title">学习设置</h3>
                            <p class="vocab-settings-modal__subtitle">自定义每日任务与复习策略</p>
                        </div>
                        <button class="btn btn-icon" type="button" data-action="close-settings" aria-label="关闭设置">×</button>
                    </header>
                    <form class="vocab-settings-form" data-vocab-role="settings-form">
                        <div class="vocab-settings-form__group">
                            <label for="vocab-setting-daily-new">每日新词目标</label>
                            <input type="number" id="vocab-setting-daily-new" name="dailyNew" min="0" max="200" step="1" required>
                            <p class="vocab-settings-form__hint">设置为 0 时，仅安排复习任务。</p>
                        </div>
                        <div class="vocab-settings-form__group">
                            <label for="vocab-setting-review-limit">每日复习上限</label>
                            <input type="number" id="vocab-setting-review-limit" name="reviewLimit" min="1" max="300" step="1" required>
                            <p class="vocab-settings-form__hint">建议 20-150，系统会按批次自动拆分。</p>
                        </div>
                        <div class="vocab-settings-form__group">
                            <label for="vocab-setting-mastery">掌握判定（连续正确次数）</label>
                            <input type="number" id="vocab-setting-mastery" name="masteryCount" min="1" max="10" step="1" required>
                        </div>
                        <div class="vocab-settings-form__group vocab-settings-form__group--inline">
                            <label class="vocab-settings-form__checkbox">
                                <input type="checkbox" name="notify" value="1">
                                <span>进入时提醒待复习任务</span>
                            </label>
                        </div>
                        <div class="vocab-settings-form__error" data-vocab-role="settings-error" aria-live="assertive"></div>
                        <div class="vocab-settings-modal__actions">
                            <button class="btn btn-outline" type="button" data-action="cancel-settings">取消</button>
                            <button class="btn btn-primary" type="submit">保存设置</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        target.innerHTML = '';
        target.appendChild(layout);
        state.elements = {
            root: layout,
            topbar: layout.querySelector('[data-vocab-role=\"topbar\"]'),
            primaryButton: layout.querySelector('[data-action=\"primary-cta\"]'),
            progressBar: layout.querySelector('[data-vocab-role=\"progress-bar\"]'),
            progressCount: layout.querySelector('[data-vocab-role=\"progress-count\"]'),
            progressStats: layout.querySelector('[data-vocab-role=\"progress-stats\"]'),
            menuButton: layout.querySelector('[data-action=\"toggle-menu\"]'),
            menu: layout.querySelector('[data-vocab-role=\"menu\"]'),
            menuPanelMain: layout.querySelector('[data-vocab-role=\"menu-panel-main\"]'),
            menuPanelLists: layout.querySelector('[data-vocab-role=\"menu-panel-lists\"]'),
            listSwitcher: layout.querySelector('[data-vocab-role=\"list-switcher\"]'),
            dueBanner: layout.querySelector('[data-vocab-role=\"due-banner\"]'),
            dueText: layout.querySelector('[data-vocab-role=\"due-text\"]'),
            sessionCard: layout.querySelector('[data-vocab-role=\"session-card\"]'),
            sidePanel: layout.querySelector('[data-vocab-role=\"side-panel\"]'),
            sideSurface: layout.querySelector('[data-vocab-role=\"side-surface\"]'),
            noteInput: layout.querySelector('[data-field=\"note\"]'),
            noteStatus: layout.querySelector('[data-field=\"note-status\"]'),
            liveRegion: layout.querySelector('[data-vocab-role=\"live-region\"]'),
            importInput: layout.querySelector('[data-vocab-role=\"import-input\"]'),
            listModal: layout.querySelector('[data-vocab-role=\"list-modal\"]'),
            listDialog: layout.querySelector('[data-vocab-role=\"list-dialog\"]'),
            listSubtitle: layout.querySelector('[data-vocab-role=\"list-subtitle\"]'),
            listSearch: layout.querySelector('[data-vocab-role=\"list-search\"]'),
            listLearnedOnly: layout.querySelector('[data-vocab-role=\"list-learned-only\"]'),
            listStats: layout.querySelector('[data-vocab-role=\"list-stats\"]'),
            listBody: layout.querySelector('[data-vocab-role=\"list-body\"]'),
            settingsModal: layout.querySelector('[data-vocab-role=\"settings-modal\"]'),
            settingsForm: layout.querySelector('[data-vocab-role=\"settings-form\"]'),
            settingsError: layout.querySelector('[data-vocab-role=\"settings-error\"]'),
            settingsDialog: layout.querySelector('[data-vocab-role=\"settings-dialog\"]'),
            settingsFields: {
                dailyNew: layout.querySelector('#vocab-setting-daily-new'),
                reviewLimit: layout.querySelector('#vocab-setting-review-limit'),
                masteryCount: layout.querySelector('#vocab-setting-mastery'),
                notify: layout.querySelector('input[name=\"notify\"]')
            }
        };
        state.elements.sideBody = state.elements.sideSurface;
        setSidePanelExpanded(false);
    }

    function handleListSwitch(event) {
        if (!event || !event.detail) {
            return;
        }
        closeMenu();
        resetSessionState();
        prepareSessionQueue();
        showDueBanner(state.session.duePending);
        if (state.session.stage === 'empty') {
            render();
            return;
        }
        startBatch(true);
    }

    function ensureListSwitcher() {
        const container = state.elements.listSwitcher;
        const Switcher = window.VocabListSwitcher;
        if (!container || !Switcher || !state.store) {
            return;
        }

        if (!state.ui.listSwitcher) {
            try {
                state.ui.listSwitcher = new Switcher(state.store);
                state.ui.listSwitcher.render(container);
            } catch (error) {
                console.warn('[VocabSessionView] 词表切换器初始化失败:', error);
                state.ui.listSwitcher = null;
            }
        }

        if (!state.ui.listSwitcherListenerAttached) {
            container.addEventListener('vocabListSwitch', handleListSwitch);
            state.ui.listSwitcherListenerAttached = true;
        }
    }

    function syncListSwitcherFromStore() {
        const switcher = state.ui.listSwitcher;
        if (!switcher || typeof switcher.syncFromStore !== 'function') {
            return false;
        }
        return switcher.syncFromStore();
    }

    function navigateToMoreView() {
        const moreView = document.getElementById('more-view');
        const vocabView = document.getElementById('vocab-view');
        document.body?.classList.remove('vocab-focus-active');
        if (window.app && typeof window.app.navigateToView === 'function') {
            try {
                window.app.navigateToView('more');
            } catch (error) {
                console.warn('[VocabSessionView] navigateToView("more") 失败:', error);
            }
        }
        if (vocabView) {
            vocabView.classList.remove('active');
            vocabView.setAttribute('hidden', 'hidden');
        }
        if (moreView) {
            moreView.classList.add('active');
            moreView.removeAttribute('hidden');
        }
    }

    function closeMenu() {
        if (!state.elements.menu) {
            return;
        }
        state.menuOpen = false;
        state.elements.menu.setAttribute('hidden', 'hidden');
        switchMenuPanel('main');
        if (state.elements.menuButton) {
            state.elements.menuButton.setAttribute('aria-expanded', 'false');
        }
        if (state.outsideClickHandler) {
            document.removeEventListener('click', state.outsideClickHandler, true);
            state.outsideClickHandler = null;
        }
    }

    function toggleMenu(event) {
        if (!state.elements.menu) {
            return;
        }
        event.stopPropagation();
        state.menuOpen = !state.menuOpen;
        if (state.menuOpen) {
            switchMenuPanel('main');
            state.elements.menu.removeAttribute('hidden');
            state.elements.menuButton.setAttribute('aria-expanded', 'true');
            state.outsideClickHandler = (evt) => {
                if (!state.elements.menu.contains(evt.target) && evt.target !== state.elements.menuButton) {
                    closeMenu();
                }
            };
            document.addEventListener('click', state.outsideClickHandler, true);
        } else {
            closeMenu();
        }
    }

    function switchMenuPanel(panelName) {
        const mainPanel = state.elements.menuPanelMain;
        const listPanel = state.elements.menuPanelLists;
        if (!mainPanel || !listPanel) {
            return;
        }
        if (panelName === 'lists') {
            mainPanel.setAttribute('hidden', 'hidden');
            listPanel.removeAttribute('hidden');
            return;
        }
        listPanel.setAttribute('hidden', 'hidden');
        mainPanel.removeAttribute('hidden');
    }

    function updateSidePanelMode() {
        if (!state.elements.sidePanel) {
            return;
        }
        state.elements.sidePanel.dataset.mobile = state.viewport.isMobile ? 'true' : 'false';
    }

    function triggerCardAction(action) {
        if (!state.elements.sessionCard || !action) {
            return false;
        }
        const trigger = state.elements.sessionCard.querySelector(`[data-action="${action}"]`);
        if (!trigger || trigger.disabled) {
            return false;
        }
        trigger.click();
        return true;
    }

    function triggerPrimaryCardAction() {
        const stage = state.session.stage;
        if (stage === 'feedback') {
            return triggerCardAction('next-word');
        }
        if (stage === 'batch-finished') {
            return triggerCardAction('next-batch') || triggerCardAction('end-session');
        }
        if (stage === 'complete') {
            return triggerCardAction('end-session');
        }
        return false;
    }

    function bindEvents() {
        if (!state.container) {
            return;
        }
        const backButton = state.container.querySelector('[data-action="return-more"]');
        if (backButton && !backButton.dataset.bound) {
            backButton.addEventListener('click', (event) => {
                event.preventDefault();
                navigateToMoreView();
            });
            backButton.dataset.bound = 'true';
        }
        if (state.elements.primaryButton && !state.elements.primaryButton.dataset.bound) {
            state.elements.primaryButton.addEventListener('click', handlePrimaryButtonClick);
            state.elements.primaryButton.dataset.bound = 'true';
        }
        if (state.elements.menuButton && !state.elements.menuButton.dataset.bound) {
            state.elements.menuButton.addEventListener('click', toggleMenu);
            state.elements.menuButton.dataset.bound = 'true';
        }
        if (state.elements.menu && !state.elements.menu.dataset.bound) {
            state.elements.menu.addEventListener('click', (event) => {
                const trigger = event.target.closest('button[data-action]');
                const action = trigger?.dataset?.action;
                if (!action) {
                    return;
                }
                if (action === 'menu-lists') {
                    switchMenuPanel('lists');
                    return;
                }
                if (action === 'menu-back-lists') {
                    switchMenuPanel('main');
                    return;
                }
                const restoreFocus = action === 'menu-view-list' || action === 'menu-settings'
                    ? state.elements.menuButton
                    : null;
                closeMenu();
                if (action === 'menu-view-list') {
                    openListModal(restoreFocus);
                    return;
                }
                if (action === 'menu-import') {
                    handleImportRequest();
                    return;
                }
                if (action === 'menu-export') {
                    handleExportRequest();
                    return;
                }
                if (action === 'menu-settings') {
                    openSettingsModal(restoreFocus);
                }
            });
            state.elements.menu.dataset.bound = 'true';
        }
        if (state.elements.dueBanner && !state.elements.dueBanner.dataset.bound) {
            state.elements.dueBanner.addEventListener('click', (event) => {
                const trigger = event.target.closest('[data-action]');
                const action = trigger?.dataset?.action;
                if (action === 'start-review') {
                    hideDueBanner();
                    startReviewFlow();
                }
            });
            state.elements.dueBanner.dataset.bound = 'true';
        }
        if (state.elements.sidePanel && !state.elements.sidePanel.dataset.bound) {
            state.elements.sidePanel.addEventListener('click', (event) => {
                const trigger = event.target.closest('[data-action]');
                const action = trigger?.dataset?.action;
                if (action === 'toggle-side-panel') {
                    toggleSidePanel(undefined, { manual: true });
                }
                if (action === 'save-note') {
                    event.preventDefault();
                    saveCurrentNote();
                }
            });
            state.elements.sidePanel.dataset.bound = 'true';
        }
        if (!state.keyboardHandler) {
            state.keyboardHandler = (event) => {
                if (event.code === 'Tab' || event.key === 'Tab') {
                    if (isListModalOpen()) {
                        trapModalFocus(event, state.elements.listDialog);
                        return;
                    }
                    if (isSettingsModalOpen()) {
                        trapModalFocus(event, state.elements.settingsDialog);
                        return;
                    }
                }
                const command = KEY_BINDINGS[event.code];
                if (!command) {
                    return;
                }
                if (command === 'escape' && isListModalPending()) {
                    event.preventDefault();
                    closeListModal();
                    return;
                }
                if (isListModalOpen()) {
                    if (command === 'escape') {
                        event.preventDefault();
                        closeListModal();
                    }
                    return;
                }
                if (isSettingsModalOpen()) {
                    if (command === 'escape') {
                        event.preventDefault();
                        closeSettingsModal();
                    }
                    return;
                }
                const activeTag = document.activeElement?.tagName;
                const isFieldActive = ['INPUT', 'TEXTAREA'].includes(activeTag);
                if (isFieldActive && !(command === 'submit' && state.session.stage === 'spelling')) {
                    if (!(command === 'reveal' && state.session.stage === 'recognition')) {
                        return;
                    }
                }
                if (command === 'submit') {
                    if (state.session.stage === 'spelling') {
                        event.preventDefault();
                        submitSpelling();
                        return;
                    }
                    if (triggerPrimaryCardAction()) {
                        event.preventDefault();
                        return;
                    }
                }
                if (command === 'reveal' && state.session.stage === 'recognition') {
                    event.preventDefault();
                    revealMeaning();
                    return;
                }
                if (command === 'escape') {
                    if (state.menuOpen) {
                        event.preventDefault();
                        closeMenu();
                        return;
                    }
                    if (state.viewport.isMobile && state.elements.sidePanel?.dataset.expanded === 'true') {
                        event.preventDefault();
                        toggleSidePanel(false);
                    }
                }
            };
            document.addEventListener('keydown', state.keyboardHandler);
        }
        if (state.elements.sessionCard && !state.elements.sessionCard.dataset.bound) {
            state.elements.sessionCard.addEventListener('click', handleCardAction);
            state.elements.sessionCard.dataset.bound = 'true';
        }
        if (state.elements.listModal && !state.elements.listModal.dataset.bound) {
            state.elements.listModal.addEventListener('click', (event) => {
                const trigger = event.target.closest('[data-action]');
                const action = trigger?.dataset?.action;
                if (!action) {
                    return;
                }
                if (action === 'close-list-modal') {
                    event.preventDefault();
                    closeListModal();
                    return;
                }
                if (action === 'export-current-list') {
                    event.preventDefault();
                    exportCurrentList();
                    return;
                }
                if (action === 'list-page-prev' && state.ui.listBrowserPage > 1) {
                    event.preventDefault();
                    state.ui.listBrowserPage -= 1;
                    renderListBrowser();
                    return;
                }
                if (action === 'list-page-next') {
                    event.preventDefault();
                    state.ui.listBrowserPage += 1;
                    renderListBrowser();
                }
            });
            state.elements.listModal.dataset.bound = 'true';
        }
        if (state.elements.listSearch && !state.elements.listSearch.dataset.bound) {
            state.elements.listSearch.addEventListener('input', (event) => {
                state.ui.listBrowserQuery = event.target.value || '';
                state.ui.listBrowserPage = 1;
                clearListSearchTimer();
                state.ui.listSearchTimer = setTimeout(() => {
                    state.ui.listSearchTimer = null;
                    renderListBrowser();
                }, LIST_SEARCH_DEBOUNCE_MS);
            });
            state.elements.listSearch.dataset.bound = 'true';
        }
        if (state.elements.listLearnedOnly && !state.elements.listLearnedOnly.dataset.bound) {
            state.elements.listLearnedOnly.addEventListener('change', (event) => {
                state.ui.listBrowserLearnedOnly = !!event.target.checked;
                state.ui.listBrowserPage = 1;
                clearListSearchTimer();
                renderListBrowser();
            });
            state.elements.listLearnedOnly.dataset.bound = 'true';
        }
        if (state.elements.importInput && !state.elements.importInput.dataset.bound) {
            state.elements.importInput.addEventListener('change', handleImportInputChange);
            state.elements.importInput.dataset.bound = 'true';
        }
        if (state.elements.settingsForm && !state.elements.settingsForm.dataset.bound) {
            state.elements.settingsForm.addEventListener('submit', handleSettingsSubmit);
            state.elements.settingsForm.addEventListener('input', () => {
                if (state.elements.settingsError) {
                    state.elements.settingsError.textContent = '';
                }
            });
            state.elements.settingsForm.dataset.bound = 'true';
        }
        if (state.elements.settingsModal && !state.elements.settingsModal.dataset.bound) {
            state.elements.settingsModal.addEventListener('click', (event) => {
                const trigger = event.target.closest('[data-action]');
                const action = trigger?.dataset?.action;
                if (!action) {
                    return;
                }
                if (action === 'close-settings' || action === 'cancel-settings') {
                    event.preventDefault();
                    closeSettingsModal();
                }
            });
            state.elements.settingsModal.dataset.bound = 'true';
        }
    }

    function handleImportRequest() {
        if (!state.store || typeof state.store.init !== 'function') {
            showFeedbackMessage('词汇数据尚未准备就绪', 'warning');
            return;
        }
        if (state.ui.importing) {
            return;
        }
        if (state.elements.importInput) {
            state.elements.importInput.value = '';
            state.elements.importInput.click();
        }
    }

    function populateSettingsForm() {
        if (!state.store || !state.elements.settingsFields) {
            return;
        }
        const config = state.store.getConfig ? state.store.getConfig() : {};
        const { dailyNew, reviewLimit, masteryCount, notify } = state.elements.settingsFields;
        if (dailyNew) {
            dailyNew.value = Number(config.dailyNew ?? DEFAULT_BATCH_SIZE);
        }
        if (reviewLimit) {
            reviewLimit.value = Number(config.reviewLimit ?? DEFAULT_BATCH_SIZE);
        }
        if (masteryCount) {
            masteryCount.value = Number(config.masteryCount ?? 4);
        }
        if (notify) {
            notify.checked = Boolean(config.notify !== false);
        }
        if (state.elements.settingsError) {
            state.elements.settingsError.textContent = '';
        }
    }

    function openSettingsModal(restoreFocus = document.activeElement) {
        if (!state.elements.settingsModal) {
            showFeedbackMessage('设置面板未加载', 'warning');
            return;
        }
        let restoreTarget = restoreFocus;
        if ((isListModalOpen() || isListModalPending()) && state.elements.listDialog?.contains(restoreFocus)) {
            restoreTarget = state.ui.listRestoreFocus;
        } else if (isSettingsModalOpen() && state.elements.settingsDialog?.contains(restoreFocus)) {
            restoreTarget = state.ui.settingsRestoreFocus;
        }
        closeListModal(false);
        closeSettingsModal(false);
        populateSettingsForm();
        state.ui.modalEpoch += 1;
        state.ui.modalOwner = 'settings';
        state.ui.settingsRestoreFocus = restoreTarget || state.elements.menuButton;
        state.ui.settingsSaveToken += 1;
        state.elements.settingsModal.removeAttribute('hidden');
        state.elements.settingsModal.dataset.open = 'true';
        const focusTarget = state.elements.settingsDialog?.querySelector('input, button, select, textarea');
        if (focusTarget && typeof focusTarget.focus === 'function') {
            focusTarget.focus();
        }
    }

    function closeSettingsModal(restoreFocus = true) {
        const ownsModal = state.ui.modalOwner === 'settings';
        const previousFocus = state.ui.settingsRestoreFocus;
        state.ui.settingsSaveToken += 1;
        state.ui.modalEpoch += 1;
        if (ownsModal) {
            state.ui.modalOwner = null;
        }
        if (!state.elements.settingsModal) {
            return;
        }
        state.elements.settingsModal.setAttribute('hidden', 'hidden');
        state.elements.settingsModal.dataset.open = 'false';
        if (state.elements.settingsError) {
            state.elements.settingsError.textContent = '';
        }
        if (ownsModal && restoreFocus) {
            focusElement(previousFocus);
        }
        state.ui.settingsRestoreFocus = null;
    }

    async function handleSettingsSubmit(event) {
        event.preventDefault();
        if (!state.store || typeof state.store.setConfig !== 'function') {
            showFeedbackMessage('词汇存储未准备就绪', 'error');
            return;
        }
        const form = event.currentTarget;
        const formData = new FormData(form);
        const daily = Number(formData.get('dailyNew'));
        const review = Number(formData.get('reviewLimit'));
        const mastery = Number(formData.get('masteryCount'));
        const notify = formData.get('notify') != null;

        const dailyNew = clampNumber(daily, CONFIG_LIMITS.dailyNew.min, CONFIG_LIMITS.dailyNew.max);
        const reviewLimit = clampNumber(review, CONFIG_LIMITS.reviewLimit.min, CONFIG_LIMITS.reviewLimit.max);
        const masteryCount = clampNumber(mastery, CONFIG_LIMITS.masteryCount.min, CONFIG_LIMITS.masteryCount.max);

        if (dailyNew === null || reviewLimit === null || masteryCount === null) {
            if (state.elements.settingsError) {
                state.elements.settingsError.textContent = '请输入有效的数字范围。';
            }
            showFeedbackMessage('请输入有效的数字范围', 'warning');
            return;
        }

        const saveToken = ++state.ui.settingsSaveToken;
        const modalToken = state.ui.modalEpoch;
        try {
            const commit = state.ui.settingsSaveTail.then(
                () => state.store.setConfig({ dailyNew, reviewLimit, masteryCount, notify }),
                () => state.store.setConfig({ dailyNew, reviewLimit, masteryCount, notify })
            );
            state.ui.settingsSaveTail = commit.catch(() => undefined);
            await commit;
            if (saveToken !== state.ui.settingsSaveToken
                || modalToken !== state.ui.modalEpoch
                || state.ui.modalOwner !== 'settings') {
                return;
            }
            state.session.batchSize = Math.max(1, Math.min(reviewLimit, DEFAULT_BATCH_SIZE));
            closeSettingsModal();
            refreshDashboard();
            render();
            showFeedbackMessage('学习设置已更新', 'success');
        } catch (error) {
            if (saveToken !== state.ui.settingsSaveToken
                || modalToken !== state.ui.modalEpoch
                || state.ui.modalOwner !== 'settings') {
                return;
            }
            console.error('[VocabSessionView] 设置保存失败:', error);
            if (state.elements.settingsError) {
                state.elements.settingsError.textContent = error.message || '保存失败，请稍后再试。';
            }
            showFeedbackMessage(`保存失败：${error.message || error}`, 'error');
        }
    }

    async function performImport(file) {
        if (!file || state.ui.importing) {
            return;
        }
        const io = window.VocabDataIO;
        if (!io || typeof io.importWordList !== 'function') {
            showFeedbackMessage('未找到导入模块，请刷新后重试', 'error');
            return;
        }
        try {
            state.ui.importing = true;
            await state.store.init();
            const payload = await io.importWordList(file);
            const result = Array.isArray(payload)
                ? { type: 'wordlist', entries: payload, meta: { category: 'external' } }
                : (payload || {});
            const entries = Array.isArray(result.entries) ? result.entries : [];
            if (!entries.length) {
                showFeedbackMessage('未在文件中发现有效词汇', 'warning');
                return;
            }
            const meta = result.meta || {};
            const sourceLabel = typeof meta.name === 'string' && meta.name.trim()
                ? meta.name.trim()
                : (typeof meta.source === 'string' && meta.source.trim() ? meta.source.trim() : '');
            if (result.type === 'progress') {
                await state.store.replaceProgress(
                    entries,
                    meta.config && typeof meta.config === 'object' ? meta.config : {},
                    typeof meta.listId === 'string' ? meta.listId : null
                );
                syncListSwitcherFromStore();
                const latestConfig = state.store.getConfig();
                const limit = Number(latestConfig?.reviewLimit);
                if (Number.isFinite(limit) && limit > 0) {
                    state.session.batchSize = Math.max(1, Math.min(limit, DEFAULT_BATCH_SIZE));
                }
                resetSessionState();
                prepareSessionQueue();
                refreshDashboard();
                if (state.session.stage !== 'empty') {
                    startBatch(true);
                } else {
                    render();
                }
                const categoryLabel = meta.category === 'user' ? '自设备份' : '学习备份';
                const suffix = sourceLabel ? `「${sourceLabel}」` : '';
                showFeedbackMessage(`${categoryLabel}${suffix}导入完成，已同步 ${entries.length} 条词汇`, 'success');
                return;
            }
            const mergeResult = await state.store.mergeWords(entries);
            const insertedCount = Number(mergeResult && mergeResult.addedCount) || 0;
            const updatedCount = Number(mergeResult && mergeResult.updatedCount) || 0;
            if (!insertedCount && !updatedCount) {
                showFeedbackMessage('所有词条均已存在，无需更新', 'info');
                return;
            }
            const categoryLabel = meta.category === 'user' ? '自设词表' : '外部词表';
            const suffix = sourceLabel ? `「${sourceLabel}」` : '';
            showFeedbackMessage(`${categoryLabel}${suffix}导入完成：新增 ${insertedCount} 条，更新 ${updatedCount} 条`, 'success');
            refreshDashboard();
            if (state.session.stage === 'empty' || state.session.stage === 'loading') {
                prepareSessionQueue();
                if (state.session.stage !== 'empty') {
                    startBatch(true);
                } else {
                    render();
                }
            } else {
                render();
            }
        } catch (error) {
            console.error('[VocabSessionView] 导入失败:', error);
            showFeedbackMessage(`导入失败：${error.message || error}`, 'error');
        } finally {
            state.ui.importing = false;
        }
    }

    function handleImportInputChange(event) {
        const input = event.currentTarget;
        const [file] = input.files || [];
        input.value = '';
        if (file) {
            performImport(file);
        }
    }

    async function handleExportRequest() {
        if (!state.store || typeof state.store.init !== 'function') {
            showFeedbackMessage('词汇数据尚未加载', 'warning');
            return;
        }
        if (state.ui.exporting) {
            return;
        }
        const io = window.VocabDataIO;
        if (!io || typeof io.exportProgress !== 'function') {
            showFeedbackMessage('导出模块未加载', 'error');
            return;
        }
        try {
            state.ui.exporting = true;
            await state.store.init();
            const blob = await io.exportProgress(state.store.getWords());
            const filename = `vocab-progress-${formatTimestamp()}.json`;
            triggerDownload(blob, filename);
            showFeedbackMessage('词汇进度已导出', 'success');
        } catch (error) {
            console.error('[VocabSessionView] 导出失败:', error);
            showFeedbackMessage(`导出失败：${error.message || error}`, 'error');
        } finally {
            state.ui.exporting = false;
        }
    }

    function handlePrimaryButtonClick(event) {
        event.preventDefault();
        const intent = event.currentTarget?.dataset?.intent || 'review';
        if (intent === 'import') {
            handleImportRequest();
            return;
        }
        if (intent === 'new') {
            startReviewFlow({ preferNew: true });
            return;
        }
        startReviewFlow();
    }

    function hideDueBanner() {
        if (!state.elements.dueBanner) {
            return;
        }
        state.elements.dueBanner.setAttribute('hidden', 'hidden');
    }

    function showDueBanner(count) {
        if (!state.elements.dueBanner || !state.elements.dueText) {
            return;
        }
        if (count <= 0) {
            hideDueBanner();
            return;
        }
        state.elements.dueText.textContent = `你有 ${count} 个待复习，建议先复习。`;
        state.elements.dueBanner.removeAttribute('hidden');
    }

    function setSidePanelExpanded(expanded) {
        if (!state.elements.sidePanel) {
            return;
        }
        const isExpanded = !!expanded;
        state.elements.sidePanel.dataset.expanded = isExpanded ? 'true' : 'false';
        if (state.elements.root) {
            state.elements.root.dataset.sidePanel = isExpanded ? 'visible' : 'hidden';
        }
        if (isExpanded) {
            state.elements.sidePanel.removeAttribute('hidden');
        } else {
            state.elements.sidePanel.setAttribute('hidden', 'hidden');
        }
        const toggleButton = state.elements.sidePanel.querySelector('[data-action="toggle-side-panel"]');
        if (toggleButton) {
            toggleButton.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        }
        if (state.elements.sideSurface) {
            if (isExpanded) {
                state.elements.sideSurface.removeAttribute('hidden');
            } else {
                state.elements.sideSurface.setAttribute('hidden', 'hidden');
            }
        }
    }

    function toggleSidePanel(forceState, options = {}) {
        if (!state.elements.sidePanel) {
            return;
        }
        const expanded = typeof forceState === 'boolean'
            ? forceState
            : state.elements.sidePanel.dataset.expanded !== 'true';
        if (options.manual) {
            state.ui.sidePanelManual = expanded;
        }
        setSidePanelExpanded(expanded);
    }

    function syncSidePanelVisibility() {
        if (!state.elements.sidePanel) {
            return;
        }
        const manualPreference = state.ui.sidePanelManual;
        let shouldShow;
        if (typeof manualPreference === 'boolean') {
            shouldShow = manualPreference;
        } else {
            shouldShow = false;
        }
        setSidePanelExpanded(shouldShow);
    }

    function announce(message) {
        if (!state.elements.liveRegion) {
            return;
        }
        state.elements.liveRegion.textContent = '';
        window.setTimeout(() => {
            state.elements.liveRegion.textContent = message;
        }, 32);
    }

    function computeStats() {
        if (!state.store) {
            return null;
        }
        const words = state.store.getWords();
        const config = state.store.getConfig();
        const due = state.store.getDueWords(new Date());
        const newCandidates = words.filter((word) => !word.lastReviewed || !word.nextReview);
        return {
            totalWords: words.length,
            dueCount: due.length,
            masteredCount: words.filter((word) => word.familiar === true || Number(word.correctCount) >= Number(config.masteryCount || 4)).length,
            dailyNew: Number(config.dailyNew) || 0,
            reviewLimit: Number(config.reviewLimit) || 0,
            newCandidateCount: newCandidates.filter((word) => word.familiar !== true).length
        };
    }

    function updateProgressStats() {
        if (!state.elements.progressStats) {
            return;
        }
        const stats = state.session.progress;
        const total = stats.total || 0;
        const accuracy = total ? Math.round((stats.correct / total) * 100) : 0;
        let pendingCurrent = ['recognition', 'spelling'].includes(state.session.stage) ? 1 : 0;
        if (state.session.stage === 'feedback' && !state.session.lastAnswer?.saved) {
            pendingCurrent = 1;
        }
        const current = total ? Math.min(stats.completed + pendingCurrent, total) : 0;
        if (state.elements.progressCount) {
            state.elements.progressCount.textContent = `${current} / ${total}`;
        }
        const chips = state.elements.progressStats.querySelectorAll('[data-chip]');
        chips.forEach((chip) => {
            const key = chip.dataset.chip;
            if (key === 'new') {
                chip.textContent = `新词 ${state.session.newTotal}`;
            } else if (key === 'review') {
                chip.textContent = `复习 ${state.session.dueTotal}`;
            } else if (key === 'accuracy') {
                chip.textContent = `正确率 ${accuracy}%`;
            }
        });
        if (state.elements.progressBar) {
            const percent = total ? Math.round((stats.completed / total) * 100) : 0;
            state.elements.progressBar.style.width = `${percent}%`;
            const container = state.elements.progressBar.closest('.vocab-progress');
            if (container) {
                container.setAttribute('aria-valuenow', String(percent));
            }
        }
    }

    function updatePrimaryAction() {
        const button = state.elements.primaryButton;
        if (!button) {
            return;
        }
        const sessionIsActive = ['recognition', 'spelling', 'feedback'].includes(state.session.stage);
        button.hidden = sessionIsActive;
        const stats = computeStats();
        let intent = 'import';
        let label = '导入词表';
        if (stats) {
            if (stats.dueCount > 0) {
                intent = 'review';
                label = `开始复习（${stats.dueCount}）`;
            } else if (stats.newCandidateCount > 0) {
                const limit = stats.dailyNew > 0 ? stats.dailyNew : stats.newCandidateCount;
                const displayCount = Math.min(stats.newCandidateCount, limit);
                intent = 'new';
                label = `新词起步（${displayCount}）`;
            }
        }
        button.dataset.intent = intent;
        button.textContent = label;
        button.classList.remove('btn-primary', 'btn-outline');
        if (intent === 'import') {
            button.classList.add('btn-outline');
        } else {
            button.classList.add('btn-primary');
        }
    }

    function updateBottomBar() {
        const bar = state.elements.bottomBar;
        const spacer = state.elements.bottomSpacer;
        const actions = state.elements.bottomActions;
        if (!bar || !actions) {
            return;
        }
        const showBar = state.session.stage === 'spelling';
        if (showBar) {
            bar.removeAttribute('hidden');
            if (spacer) {
                spacer.removeAttribute('hidden');
            }
        } else {
            bar.setAttribute('hidden', 'hidden');
            if (spacer) {
                spacer.setAttribute('hidden', 'hidden');
            }
        }
        const buttons = actions.querySelectorAll('button[data-result]');
        buttons.forEach((button) => {
            if (showBar) {
                button.removeAttribute('disabled');
            } else {
                button.setAttribute('disabled', 'disabled');
            }
        });
    }

    function updateSidePanelContent(word) {
        if (!state.elements.sideBody) {
            return;
        }
        const meaning = state.elements.sideBody.querySelector('[data-field="meaning"]');
        const example = state.elements.sideBody.querySelector('[data-field="example"]');
        const meta = state.elements.sideBody.querySelector('[data-field="meta"]');
        const noteInput = state.elements.sideBody.querySelector('[data-field="note"]');
        const noteStatus = state.elements.sideBody.querySelector('[data-field="note-status"]');
        if (!word) {
            meaning.textContent = '—';
            example.textContent = '暂无词条';
            meta.textContent = '无可用信息';
            if (noteInput) {
                noteInput.value = '';
            }
            if (noteStatus) {
                noteStatus.textContent = '';
            }
            return;
        }
        meaning.textContent = word.meaning || '—';
        example.textContent = word.example || '暂无例句';
        meta.textContent = word.source || '内置 IELTS 核心词表';
        if (noteInput) {
            noteInput.value = word.note || '';
        }
        if (noteStatus) {
            noteStatus.textContent = '';
        }
    }

    function escapeHtml(value) {
        if (value == null) {
            return '';
        }
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function normalizePhoneticValue(value) {
        if (typeof value !== 'string') {
            return '';
        }
        return value.trim().replace(/^\/+|\/+$/g, '').trim();
    }

    function formatDateTime(value) {
        if (!value) {
            return '-';
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return '-';
        }
        return date.toLocaleString();
    }

    function getActiveListLabel() {
        if (!state.store || typeof state.store.getActiveListId !== 'function') {
            return '当前词表';
        }
        const listId = state.store.getActiveListId();
        const lists = state.store.VOCAB_LISTS || {};
        return lists[listId]?.name || '当前词表';
    }

    function getWordStatus(word, config) {
        const masteredTarget = Number(config?.masteryCount || 4);
        const correctCount = Number(word?.correctCount || 0);
        if (word?.familiar === true) {
            return { label: '熟词', tone: 'familiar' };
        }
        if (word?.nextReview) {
            const next = new Date(word.nextReview);
            if (!Number.isNaN(next.getTime()) && next <= new Date()) {
                return { label: '待复习', tone: 'due' };
            }
        }
        if (correctCount >= masteredTarget) {
            return { label: '已掌握', tone: 'mastered' };
        }
        if (word?.nextReview) {
            return { label: '学习中', tone: 'reviewing' };
        }
        if (word?.lastReviewed || correctCount > 0) {
            return { label: '学习中', tone: 'reviewing' };
        }
        return { label: '未学习', tone: 'new' };
    }

    function isLearnedWord(word) {
        return Boolean(word?.familiar || word?.lastReviewed || word?.nextReview || Number(word?.correctCount || 0) > 0);
    }

    function analyzeListWords() {
        const words = state.store && typeof state.store.getWords === 'function'
            ? state.store.getWords()
            : [];
        const config = state.store && typeof state.store.getConfig === 'function'
            ? state.store.getConfig()
            : {};
        const query = state.ui.listBrowserQuery.trim().toLowerCase();
        const learnedOnly = state.ui.listBrowserLearnedOnly;
        const visible = [];
        let learnedCount = 0;
        let masteredCount = 0;
        let dueCount = 0;
        const masteryTarget = Number(config.masteryCount || 4);
        words.forEach((word) => {
            if (!word || typeof word.word !== 'string') {
                return;
            }
            const learned = isLearnedWord(word);
            const status = getWordStatus(word, config);
            if (learned) {
                learnedCount += 1;
            }
            if (word.familiar === true || Number(word.correctCount || 0) >= masteryTarget) {
                masteredCount += 1;
            }
            if (status.tone === 'due') {
                dueCount += 1;
            }
            if (learnedOnly && !learned) {
                return;
            }
            const haystack = [
                word.word,
                word.meaning,
                word.example,
                word.note,
                word.source
            ].map((value) => String(value || '').toLowerCase()).join('\n');
            if (!query || haystack.includes(query)) {
                visible.push({ word, status });
            }
        });
        return { words, visible, learnedCount, masteredCount, dueCount };
    }

    function renderListBrowser() {
        if (!state.elements.listBody || !state.store) {
            return;
        }
        const analysis = analyzeListWords();
        const totalPages = Math.max(1, Math.ceil(analysis.visible.length / LIST_PAGE_SIZE));
        state.ui.listBrowserPage = Math.min(totalPages, Math.max(1, state.ui.listBrowserPage));
        const pageStart = (state.ui.listBrowserPage - 1) * LIST_PAGE_SIZE;
        const pageWords = analysis.visible.slice(pageStart, pageStart + LIST_PAGE_SIZE);

        if (state.elements.listSubtitle) {
            state.elements.listSubtitle.textContent = `${getActiveListLabel()} · 共 ${analysis.words.length} 个词`;
        }
        if (state.elements.listStats) {
            state.elements.listStats.innerHTML = `
                <span>已学 ${analysis.learnedCount}</span>
                <span>待复习 ${analysis.dueCount}</span>
                <span>已掌握 ${analysis.masteredCount}</span>
                <span>当前显示 ${analysis.visible.length}</span>
            `;
        }

        if (!analysis.visible.length) {
            state.elements.listBody.innerHTML = '<div class="vocab-list-empty">没有匹配的词条</div>';
            return;
        }

        const rows = pageWords.map(({ word, status }, index) => `
                <tr>
                    <td>${pageStart + index + 1}</td>
                    <td><strong>${escapeHtml(word.word)}</strong></td>
                    <td>${escapeHtml(word.meaning || '-')}</td>
                    <td><span class="vocab-list-status vocab-list-status--${status.tone}">${status.label}</span></td>
                    <td>${Number(word.correctCount || 0)}</td>
                    <td>${formatDateTime(word.lastReviewed)}</td>
                    <td>${formatDateTime(word.nextReview)}</td>
                    <td>${escapeHtml(word.note || word.source || '-')}</td>
                </tr>
            `).join('');
        state.elements.listBody.innerHTML = `
            <div class="vocab-list-table-wrap">
                <table class="vocab-list-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>单词</th>
                            <th>释义</th>
                            <th>状态</th>
                            <th>正确</th>
                            <th>上次复习</th>
                            <th>下次复习</th>
                            <th>笔记/来源</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${totalPages > 1 ? `
                <div class="vocab-list-pagination" aria-label="词表分页">
                    <button class="btn btn-icon" type="button" data-action="list-page-prev" aria-label="上一页" ${state.ui.listBrowserPage === 1 ? 'disabled' : ''}>‹</button>
                    <span>第 ${state.ui.listBrowserPage} / ${totalPages} 页</span>
                    <button class="btn btn-icon" type="button" data-action="list-page-next" aria-label="下一页" ${state.ui.listBrowserPage === totalPages ? 'disabled' : ''}>›</button>
                </div>
            ` : ''}
        `;
    }

    async function openListModal(restoreFocus = document.activeElement) {
        if (!state.store || typeof state.store.init !== 'function') {
            showFeedbackMessage('词汇数据尚未准备就绪', 'warning');
            return;
        }
        let restoreTarget = restoreFocus;
        if (isSettingsModalOpen() && state.elements.settingsDialog?.contains(restoreFocus)) {
            restoreTarget = state.ui.settingsRestoreFocus;
        } else if ((isListModalOpen() || isListModalPending()) && state.elements.listDialog?.contains(restoreFocus)) {
            restoreTarget = state.ui.listRestoreFocus;
        }
        closeSettingsModal(false);
        closeListModal(false);
        const openToken = ++state.ui.modalEpoch;
        state.ui.modalOwner = 'list-pending';
        state.ui.listRestoreFocus = restoreTarget || state.elements.menuButton;
        try {
            await state.store.init();
        } catch (error) {
            if (openToken !== state.ui.modalEpoch || state.ui.modalOwner !== 'list-pending') {
                return;
            }
            console.error('[VocabSessionView] 词表加载失败:', error);
            showFeedbackMessage('词表加载失败，请刷新后重试', 'error');
            closeListModal();
            return;
        }
        if (openToken !== state.ui.modalEpoch || state.ui.modalOwner !== 'list-pending') {
            return;
        }
        if (!state.elements.listModal) {
            showFeedbackMessage('词表面板未加载', 'warning');
            closeListModal();
            return;
        }
        state.ui.modalOwner = 'list';
        state.ui.listBrowserPage = 1;
        state.elements.listModal.removeAttribute('hidden');
        state.elements.listModal.dataset.open = 'true';
        if (state.elements.listSearch) {
            state.elements.listSearch.value = state.ui.listBrowserQuery;
        }
        if (state.elements.listLearnedOnly) {
            state.elements.listLearnedOnly.checked = state.ui.listBrowserLearnedOnly;
        }
        renderListBrowser();
        if (state.elements.listSearch && typeof state.elements.listSearch.focus === 'function') {
            state.elements.listSearch.focus();
        }
    }

    function closeListModal(restoreFocus = true) {
        const ownsModal = state.ui.modalOwner === 'list' || state.ui.modalOwner === 'list-pending';
        const previousFocus = state.ui.listRestoreFocus;
        clearListSearchTimer();
        state.ui.modalEpoch += 1;
        if (ownsModal) {
            state.ui.modalOwner = null;
        }
        if (!state.elements.listModal) {
            return;
        }
        state.elements.listModal.setAttribute('hidden', 'hidden');
        state.elements.listModal.dataset.open = 'false';
        if (ownsModal && restoreFocus) {
            focusElement(previousFocus);
        }
        state.ui.listRestoreFocus = null;
    }

    function exportCurrentList() {
        if (!state.store || typeof state.store.getWords !== 'function') {
            showFeedbackMessage('词汇数据尚未加载', 'warning');
            return;
        }
        const entries = state.store.getWords().map((word) => {
            const entry = {
                word: String(word?.word || '').trim(),
                meaning: String(word?.meaning || '').trim(),
                example: String(word?.example || '').trim()
            };
            const phonetic = normalizePhoneticValue(word?.phonetic);
            if (phonetic) {
                entry.phonetic = phonetic;
            }
            if (typeof word?.freq === 'number' && Number.isFinite(word.freq)) {
                entry.freq = word.freq;
            }
            return entry;
        });
        const payload = {
            type: 'wordlist',
            exportedAt: new Date().toISOString(),
            listId: state.store.getActiveListId ? state.store.getActiveListId() : null,
            name: getActiveListLabel(),
            category: 'external',
            entries
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        triggerDownload(blob, `vocab-list-${formatTimestamp()}.json`);
        showFeedbackMessage('可分享词表已导出', 'success');
    }

    function buildFeedbackSummary(status, word) {
        const nextReview = word.nextReview ? new Date(word.nextReview).toLocaleString() : '稍后安排';
        if (status === 'correct') {
            return {
                title: '太棒了！',
                message: `将于 ${nextReview} 再次复习。`
            };
        }
        if (status === 'near') {
            return {
                title: '接近正确',
                message: `拼写差一点：${word.word}`
            };
        }
        return {
            title: '别急',
            message: `正确是：${word.word}`
        };
    }

    function handleCardAction(event) {
        if (isSettingsModalOpen() || isListModalOpen()) {
            return;
        }
        const trigger = event.target.closest('[data-action]');
        const action = trigger?.dataset?.action;
        if (!action) {
            return;
        }
        event.preventDefault();
        if (action === 'reveal-meaning') {
            revealMeaning();
            return;
        }
        if (action === 'play-pronunciation') {
            playCurrentPronunciation(trigger);
            return;
        }
        if (action === 'mark-familiar') {
            markCurrentWordFamiliar(trigger);
            return;
        }
        if (action === 'recognize-easy') {
            state.session.recognitionQuality = 'easy';
            state.session.stage = 'spelling';
            state.session.meaningVisible = false;
            state.session.spellingAttempts = 0;
            state.session.typedAnswer = '';
            state.ui.sidePanelManual = null;
            render();
            return;
        }
        if (action === 'recognize-good') {
            state.session.recognitionQuality = 'good';
            state.session.stage = 'spelling';
            state.session.meaningVisible = false;
            state.session.spellingAttempts = 0;
            state.session.typedAnswer = '';
            state.ui.sidePanelManual = null;
            render();
            return;
        }
        if (action === 'recognize-hard') {
            state.session.recognitionQuality = 'hard';
            state.session.stage = 'spelling';
            state.session.meaningVisible = false;
            state.session.spellingAttempts = 0;
            state.session.typedAnswer = '';
            state.ui.sidePanelManual = null;
            render();
            return;
        }
        if (action === 'submit-spelling') {
            submitSpelling();
            return;
        }
        if (action === 'skip-spelling') {
            // 跳过拼写，应用跳过惩罚
            applyResult(null, { skipped: true });
            return;
        }
        if (action === 'next-word') {
            moveToNextWord();
            return;
        }
        if (action === 'rate-easy') {
            rateAndContinue('easy');
            return;
        }
        if (action === 'rate-good') {
            rateAndContinue('good');
            return;
        }
        if (action === 'rate-hard') {
            rateAndContinue('hard');
            return;
        }
        if (action === 'next-batch') {
            startBatch(true);
            return;
        }
        if (action === 'end-session') {
            endCurrentSession();
            return;
        }
        if (action === 'empty-import') {
            handleImportRequest();
            return;
        }
        if (action === 'empty-new') {
            startReviewFlow({ preferNew: true });
            return;
        }
    }

    function revealMeaning() {
        state.session.meaningVisible = !state.session.meaningVisible;
        state.ui.sidePanelManual = null;
        render();
    }

    function buildBritishPronunciationUrl(value) {
        const normalized = String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
        if (!normalized || !/^[a-z0-9-]+$/.test(normalized)) {
            return '';
        }
        return `https://ssl.gstatic.com/dictionary/static/sounds/oxford/${encodeURIComponent(normalized)}--_gb_1.mp3`;
    }

    function setPronunciationControlState(trigger, status) {
        if (!trigger) {
            return;
        }
        const label = trigger.querySelector('.vocab-card__pronounce-label');
        const labels = {
            idle: '真人英音',
            loading: '正在加载…',
            playing: '正在播放'
        };
        trigger.disabled = status === 'loading';
        trigger.classList.toggle('is-loading', status === 'loading');
        trigger.classList.toggle('is-playing', status === 'playing');
        trigger.setAttribute('aria-busy', status === 'loading' ? 'true' : 'false');
        if (label) {
            label.textContent = labels[status] || labels.idle;
        }
    }

    function stopActivePronunciation() {
        pronunciationEpoch += 1;
        if (!activePronunciationAudio) {
            return;
        }
        try {
            activePronunciationAudio.pause();
            activePronunciationAudio.currentTime = 0;
        } catch (_) {}
        activePronunciationAudio = null;
    }

    function showPronunciationFallback(trigger, word) {
        if (trigger) {
            trigger.hidden = true;
            setPronunciationControlState(trigger, 'idle');
        }
        const fallback = state.elements.sessionCard?.querySelector('[data-pronunciation-fallback]');
        if (fallback) {
            fallback.hidden = false;
            fallback.removeAttribute('hidden');
        }
        showFeedbackMessage(`暂未收录“${word}”的真人英音，可到 Cambridge 收听`, 'info');
        announce(`${word} 暂无可直接播放的真人英音`);
    }

    async function playCurrentPronunciation(trigger) {
        const word = String(state.session.currentWord?.word || '').trim();
        const audioUrl = buildBritishPronunciationUrl(word);
        const AudioCtor = window.Audio;
        if (!word || !audioUrl || typeof AudioCtor !== 'function') {
            showPronunciationFallback(trigger, word || '这个单词');
            return false;
        }

        stopActivePronunciation();
        const requestEpoch = pronunciationEpoch;
        setPronunciationControlState(trigger, 'loading');
        const audio = new AudioCtor(audioUrl);
        audio.preload = 'auto';
        activePronunciationAudio = audio;

        try {
            await audio.play();
            if (requestEpoch !== pronunciationEpoch) {
                return false;
            }
            setPronunciationControlState(trigger, 'playing');
            announce(`正在播放 ${word} 的真人英音`);
            audio.addEventListener('ended', () => {
                if (requestEpoch !== pronunciationEpoch) {
                    return;
                }
                activePronunciationAudio = null;
                setPronunciationControlState(trigger, 'idle');
            }, { once: true });
            return true;
        } catch (_) {
            if (requestEpoch !== pronunciationEpoch) {
                return false;
            }
            activePronunciationAudio = null;
            showPronunciationFallback(trigger, word);
            return false;
        }
    }

    async function markCurrentWordFamiliar(trigger) {
        const word = state.session.currentWord;
        if (!word || !state.store || typeof state.store.updateWord !== 'function') {
            return false;
        }
        if (trigger) {
            trigger.disabled = true;
            trigger.textContent = '正在保存…';
        }
        const now = new Date().toISOString();
        const config = typeof state.store.getConfig === 'function' ? state.store.getConfig() : {};
        const masteryTarget = Number(config.masteryCount || 4);
        try {
            const committed = await state.store.updateWord(word.id, {
                familiar: true,
                familiarAt: now,
                correctCount: Math.max(Number(word.correctCount || 0), masteryTarget),
                lastReviewed: now,
                nextReview: null
            });
            if (!committed) {
                throw new Error('词汇记录不存在');
            }
            state.session.activeQueue = state.session.activeQueue.filter((item) => item.id !== word.id);
            state.session.backlog = state.session.backlog.filter((item) => item.id !== word.id);
            state.session.progress.completed = Math.min(
                state.session.progress.total,
                state.session.progress.completed + 1
            );
            state.session.progress.correct += 1;
            showFeedbackMessage(`“${word.word}”已标为熟词，并移出背词队列`, 'success');
            announce(`${word.word} 已标为熟词`);
            moveToNextWord();
            return true;
        } catch (error) {
            showFeedbackMessage(`标记熟词失败：${error.message || error}`, 'error');
            if (trigger) {
                trigger.disabled = false;
                trigger.textContent = '☆ 标为熟词';
            }
            return false;
        }
    }

    function levenshteinDistance(a, b) {
        const s = (a || '').toLowerCase().trim();
        const t = (b || '').toLowerCase().trim();
        if (!s.length) {
            return t.length;
        }
        if (!t.length) {
            return s.length;
        }
        const costs = Array(t.length + 1).fill(0);
        for (let j = 0; j <= t.length; j += 1) {
            costs[j] = j;
        }
        for (let i = 1; i <= s.length; i += 1) {
            let lastValue = i - 1;
            costs[0] = i;
            for (let j = 1; j <= t.length; j += 1) {
                const newValue = Math.min(
                    costs[j] + 1,
                    costs[j - 1] + 1,
                    lastValue + (s[i - 1] === t[j - 1] ? 0 : 1)
                );
                lastValue = costs[j];
                costs[j] = newValue;
            }
        }
        return costs[t.length];
    }

    function evaluateAnswer(input, word) {
        const normalizedAnswer = (input || '').trim();
        const normalizedWord = (word.word || '').trim();
        if (!normalizedWord) {
            return { status: 'wrong', quality: 'wrong', distance: 0 };
        }
        if (!normalizedAnswer) {
            return { status: 'wrong', quality: 'wrong', distance: normalizedWord.length };
        }
        if (normalizedAnswer.toLowerCase() === normalizedWord.toLowerCase()) {
            return { status: 'correct', quality: 'good', distance: 0 };
        }
        const distance = levenshteinDistance(normalizedAnswer, normalizedWord);
        if (distance <= 1) {
            return { status: 'near', quality: 'hard', distance };
        }
        return { status: 'wrong', quality: 'wrong', distance };
    }

    function scheduleNear(word, now) {
        const scheduler = state.scheduler;
        const baseBox = Number(word.box) || (scheduler ? scheduler.MIN_BOX : 1);
        const nextReview = scheduler && typeof scheduler.calculateNextReview === 'function'
            ? scheduler.calculateNextReview(baseBox, now)
            : new Date(now.getTime() + 3 * 60 * 60 * 1000);
        const delta = Math.max(10 * 60 * 1000, Math.floor((nextReview.getTime() - now.getTime()) / 2));
        return {
            box: baseBox,
            correctCount: Number(word.correctCount) || 0,
            lastReviewed: now.toISOString(),
            nextReview: new Date(now.getTime() + delta).toISOString()
        };
    }

    function submitSpelling() {
        const card = state.elements.sessionCard;
        if (!card) {
            return;
        }
        const input = card.querySelector('input[name="answer"]');
        if (!input) {
            return;
        }
        const answer = input.value.trim();
        const word = state.session.currentWord;
        
        if (!answer) {
            return;
        }
        
        state.session.typedAnswer = answer;
        
        // 检查拼写是否正确
        const isCorrect = answer.toLowerCase() === word.word.toLowerCase();
        
        if (isCorrect) {
            // 拼写正确，使用认识质量
            const recognitionQuality = state.session.recognitionQuality || 'good';
            applyResult(recognitionQuality, { answer, spellingCorrect: true });
            return;
        }
        
        // 拼写错误，增加尝试次数
        state.session.spellingAttempts = (state.session.spellingAttempts || 0) + 1;
        const maxAttempts = 3;
        
        if (state.session.spellingAttempts >= maxAttempts) {
            // 达到最大尝试次数，标记为错误
            applyResult('wrong', { answer, spellingCorrect: false, attemptsExhausted: true });
            return;
        }
        
        // 还有机会，重新渲染
        state.session.typedAnswer = '';
        render();
        
        // 显示错误提示
        if (typeof window.showToast === 'function') {
            window.showToast(`拼写错误，还有 ${maxAttempts - state.session.spellingAttempts} 次机会`, 'warning');
        }
    }

    async function applyResult(qualityOrStatus, options = {}) {
        const session = state.session;
        const word = session.currentWord;
        if (!word || !state.store || !state.scheduler) {
            return;
        }
        if (session.stage !== 'spelling' && !options.skipped) {
            return;
        }
        const now = new Date();
        
        // 基础质量评分（来自认识判断）
        const recognitionQuality = session.recognitionQuality || 'good';
        const spellingAttempts = session.spellingAttempts || 0;
        const skipped = options.skipped || false;
        const isIntraReview = word.__intraReview === true;
        const cycleType = word.__cycleType || 'normal';
        
        // 确定最终质量（考虑拼写错误）
        let finalQuality = recognitionQuality;
        if (qualityOrStatus === 'wrong' || options.attemptsExhausted || skipped) {
            // 拼写失败和跳过都必须按遗忘处理，不能增加正确次数或拉长复习间隔。
            finalQuality = 'wrong';
        } else if (spellingAttempts >= 2) {
            finalQuality = 'hard'; // 多次拼写错误视为困难
        } else if (spellingAttempts === 1 && recognitionQuality === 'easy') {
            finalQuality = 'good'; // 简单但拼写错误降为一般
        }
        
        // 处理新词或轮内循环
        let patch;
        if (!word.easeFactor) {
            // 新词先建立 EF；遗忘结果还要继续走失败调度，避免只初始化却未记录复习。
            const initialQuality = finalQuality === 'wrong' ? 'hard' : finalQuality;
            patch = state.scheduler.setInitialEaseFactor(word, initialQuality);
            if (finalQuality === 'wrong') {
                patch = state.scheduler.scheduleAfterResult(patch, 'wrong', now);
            }
        } else if (isIntraReview) {
            // 轮内循环：调整难度因子
            patch = state.scheduler.adjustIntraCycleEF(
                word,
                finalQuality === 'wrong' ? 'hard' : finalQuality
            );
        } else {
            // 正常复习：使用标准SM-2算法
            patch = state.scheduler.scheduleAfterResult(word, finalQuality, now);
        }
        
        // 判断是否需要继续轮内循环或安排验证
        const intraCycles = patch.intraCycles || 0;
        const maxCycles = state.scheduler.SM2_CONSTANTS.MAX_INTRA_CYCLES;
        
        let needsContinueIntra = false;
        let needsEasyVerification = false;
        
        if (cycleType === 'easy_verification') {
            // easy验证阶段
            if (finalQuality === 'easy') {
                // 验证通过，正式进入复习队列
                patch = state.scheduler.scheduleAfterResult(patch, 'easy', now);
            } else {
                // 验证失败，重新进入轮内循环
                patch.intraCycles = 1;
                needsContinueIntra = true;
            }
        } else if (!isIntraReview) {
            // 首次接触
            if (finalQuality === 'easy') {
                // easy直接进入复习队列，不需要验证
                patch = state.scheduler.scheduleAfterResult(patch, 'easy', now);
            } else if (finalQuality === 'good' || finalQuality === 'hard') {
                // good/hard进入轮内循环
                needsContinueIntra = true;
            }
        } else {
            // 轮内循环中
            if (finalQuality === 'easy') {
                // 任何一次easy都要验证
                needsEasyVerification = true;
                patch.intraCycles = 0; // 重置循环计数
            } else if (intraCycles < maxCycles) {
                // good/hard继续循环
                needsContinueIntra = true;
            } else {
                // 达到最大循环次数，强制毕业
                patch = state.scheduler.scheduleAfterResult(patch, finalQuality, now);
            }
        }
        
        // 安排后续复习
        if (needsEasyVerification) {
            scheduleIntraReview(patch, 'easy_verification');
        } else if (needsContinueIntra) {
            scheduleIntraReview(patch, 'normal');
        }
        
        // 保存到数据库（除非是临时的轮内状态）
        const shouldSave = !needsContinueIntra && !needsEasyVerification;
        let updated = patch;
        
        if (shouldSave) {
            updated = await state.store.updateWord(word.id, patch) || patch;
        }
        
        session.currentWord = updated;
        session.lastAnswer = {
            recognitionQuality,
            spellingAttempts,
            spellingCorrect: spellingAttempts === 0 && !skipped,
            typed: options.answer ?? session.typedAnswer,
            skipped,
            finalQuality,
            isIntraReview,
            cycleType,
            intraCycles,
            needsContinueIntra,
            needsEasyVerification,
            saved: shouldSave
        };
        session.stage = 'feedback';
        session.meaningVisible = true;
        state.ui.sidePanelManual = null;
        session.typedAnswer = '';
        
        // 更新统计（只有正式完成的才计入）
        if (shouldSave) {
            if (finalQuality === 'wrong') {
                session.progress.wrong += 1;
            } else if (finalQuality === 'hard' || spellingAttempts > 0) {
                session.progress.near += 1;
            } else {
                session.progress.correct += 1;
            }
            session.progress.completed += 1;
        }
        
        render();
    }

    function scheduleIntraReview(word, cycleType = 'normal') {
        let insertPosition;
        
        if (cycleType === 'easy_verification') {
            // easy验证：插入到第 20-30 个位置
            insertPosition = Math.min(
                state.session.activeQueue.length,
                Math.floor(Math.random() * 11) + 20  // 20-30 随机
            );
        } else {
            // 正常轮内循环：插入到第 3-8 个位置
            insertPosition = Math.min(
                state.session.activeQueue.length,
                Math.floor(Math.random() * 6) + 3  // 3-8 随机
            );
        }
        
        const clone = {
            ...word,
            __intraReview: true,
            __cycleType: cycleType,
            __insertedAt: Date.now()
        };
        
        state.session.activeQueue.splice(insertPosition, 0, clone);
    }

    function requeueForRetry(word, status) {
        // 错题重测：插入到队列末尾，当天内再次复习
        const clone = { ...word, __retry: true };
        clone.__retryDue = Date.now() + (RETRY_DELAYS[status] || RETRY_DELAYS.wrong);
        state.session.activeQueue.push(clone);
    }

    async function rateAndContinue(quality) {
        const session = state.session;
        const word = session.currentWord;
        if (!word || session.stage !== 'feedback') {
            return;
        }
        
        // 如果用户重新评分，更新调度
        if (session.lastAnswer && session.lastAnswer.quality !== quality) {
            const now = new Date();
            const patch = state.scheduler.scheduleAfterResult(word, quality, now);
            try {
                const committedWord = await state.store.updateWord(word.id, patch);
                if (!committedWord) {
                    throw new Error('词汇记录不存在');
                }
                session.currentWord = committedWord;
                session.lastAnswer.quality = quality;
            } catch (error) {
                showFeedbackMessage(`评分保存失败：${error.message || error}`, 'error');
                return;
            }
        }
        
        moveToNextWord();
    }

    function moveToNextWord() {
        stopActivePronunciation();
        state.session.lastAnswer = null;
        if (!state.session.activeQueue.length) {
            state.session.meaningVisible = false;
            state.ui.sidePanelManual = null;
            if (state.session.backlog.length) {
                state.session.stage = 'batch-finished';
            } else {
                state.session.stage = 'complete';
            }
            render();
            return;
        }
        const next = state.session.activeQueue.shift();
        const isRetry = next.__retry === true;
        state.ui.sidePanelManual = null;
        state.session.currentWord = { ...next };
        state.session.meaningVisible = false;
        state.session.recognitionQuality = null;
        state.session.spellingAttempts = 0;
        state.session.stage = 'recognition';
        state.session.typedAnswer = '';
        state.session.queueSeed += 1;
        render();
    }

    async function saveCurrentNote() {
        const word = state.session.currentWord;
        if (!word || !state.store || !state.elements.noteInput) {
            return;
        }
        const note = state.elements.noteInput.value.trim();
        let committedWord;
        try {
            committedWord = await state.store.updateWord(word.id, { note });
            if (!committedWord) {
                throw new Error('词汇记录不存在');
            }
        } catch (error) {
            if (state.elements.noteStatus) {
                state.elements.noteStatus.textContent = '保存失败';
            }
            showFeedbackMessage(`笔记保存失败：${error.message || error}`, 'error');
            return false;
        }
        state.session.currentWord = committedWord;
        if (state.elements.noteStatus) {
            state.elements.noteStatus.textContent = '已保存';
            setTimeout(() => {
                if (state.elements.noteStatus) {
                    state.elements.noteStatus.textContent = '';
                }
            }, 1500);
        }
        return true;
    }

    function startBatch(force) {
        const session = state.session;
        if (!force && session.activeQueue.length) {
            return;
        }
        if (session.backlog.length === 0 && session.activeQueue.length === 0) {
            session.stage = 'complete';
            render();
            return;
        }
        state.ui.sidePanelManual = null;
        session.batchIndex += 1;
        session.progress = {
            total: Math.min(session.batchSize, session.backlog.length + session.activeQueue.length),
            completed: 0,
            correct: 0,
            near: 0,
            wrong: 0
        };
        session.activeQueue = session.backlog.splice(0, session.batchSize);
        hideDueBanner();
        session.stage = 'recall';
        moveToNextWord();
    }

    function endCurrentSession() {
        state.session.stage = 'complete';
        render();
        navigateToMoreView();
    }

    function renderCard() {
        const card = state.elements.sessionCard;
        if (!card) {
            return;
        }
        const session = state.session;
        const word = session.currentWord;

        if (session.stage !== 'recognition') {
            stopActivePronunciation();
        }

        if (session.stage === 'loading' || session.stage === 'preparing') {
            card.innerHTML = `
                <div class="vocab-card vocab-card--loading">
                    <div class="spinner"></div>
                    <p>正在加载词汇数据…</p>
                </div>
            `;
            return;
        }
        if (session.stage === 'empty') {
            card.innerHTML = `
                <div class="vocab-card vocab-card--empty">
                    <div class="vocab-card__illustration" aria-hidden="true">📭</div>
                    <h3 class="vocab-card__empty-title">暂无学习任务</h3>
                    <p class="vocab-card__empty-text">请导入词表或开启新词学习。</p>
                    <div class="vocab-card__actions vocab-card__actions--stack">
                        <button class="btn btn-primary" type="button" data-action="empty-import">导入词表</button>
                        <button class="btn btn-outline" type="button" data-action="empty-new">新词起步 (N)</button>
                    </div>
                </div>
            `;
            return;
        }
        if (session.stage === 'batch-finished') {
            const remaining = state.session.backlog.length;
            const nextMarkup = remaining > 0
                ? '<button class="btn btn-primary" type="button" data-action="next-batch">下一批</button>'
                : '';
            card.innerHTML = `
                <div class="vocab-card vocab-card--summary">
                    <div class="vocab-card__summary-head">
                        <h3>本批完成</h3>
                        <p>正确 ${session.progress.correct} · 近似 ${session.progress.near} · 错误 ${session.progress.wrong}</p>
                        <p class="vocab-card__summary-queue">剩余批次 ${remaining}</p>
                    </div>
                    <div class="vocab-card__actions vocab-card__actions--inline">
                        ${nextMarkup}
                        <button class="btn btn-outline" type="button" data-action="end-session">结束本轮</button>
                    </div>
                </div>
            `;
            return;
        }
        if (session.stage === 'complete') {
            card.innerHTML = `
                <div class="vocab-card vocab-card--complete">
                    <div class="vocab-card__summary-head">
                        <h3>今日任务完成</h3>
                        <p>恭喜坚持完成所有单词复习！</p>
                    </div>
                    <div class="vocab-card__actions vocab-card__actions--center">
                        <button class="btn btn-primary" type="button" data-action="end-session">返回更多</button>
                    </div>
                </div>
            `;
            return;
        }
        if (!word) {
            card.innerHTML = `
                <div class="vocab-card vocab-card--placeholder">
                    <p>准备下一条词汇…</p>
                </div>
            `;
            return;
        }
        if (session.stage === 'recognition') {
            const safeWord = escapeHtml(word.word);
            const safeMeaning = escapeHtml(word.meaning || '暂无释义');
            const safeExample = escapeHtml(word.example || '');
            const cambridgeUrl = escapeHtml(`https://dictionary.cambridge.org/search/english/direct/?q=${encodeURIComponent(word.word || '')}`);
            const phonetic = normalizePhoneticValue(word.phonetic);
            const phoneticBlock = phonetic
                ? `<div class="vocab-card__phonetic"><span class="visually-hidden">音标：</span><span aria-hidden="true">/</span><span>${escapeHtml(phonetic)}</span><span aria-hidden="true">/</span></div>`
                : '';
            const exampleBlock = safeExample
                ? `<div class="vocab-card__example"><span>例句</span><p>${safeExample}</p></div>`
                : '';
            const meaningBlock = session.meaningVisible
                ? `<section class="vocab-card__reveal-panel" data-visible="true">
                        <div class="vocab-card__meaning">${safeMeaning}</div>
                        ${exampleBlock}
                   </section>`
                : '';
            const revealControl = session.meaningVisible
                ? ''
                : '<div class="vocab-card__reveal"><button class="btn btn-soft" type="button" data-action="reveal-meaning">查看释义与例句 <kbd>F</kbd></button></div>';
            const wordKind = word.lastReviewed || word.nextReview ? '复习词' : '新词';
            const position = session.progress.total
                ? Math.min(session.progress.completed + 1, session.progress.total)
                : 1;
            card.innerHTML = `
                <div class="vocab-card vocab-card--recognition">
                    <div class="vocab-card__utility-row">
                        <div class="vocab-card__step">${wordKind} · 第 ${position} / ${session.progress.total || 1} 个</div>
                        <button class="vocab-card__familiar" type="button" data-action="mark-familiar" title="已经完全掌握，移出背词队列"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.9L12 3.5Z"></path></svg><span>标为熟词</span></button>
                    </div>
                    <div class="vocab-card__wordline">
                        <div class="vocab-card__word">${safeWord}</div>
                        ${phoneticBlock}
                    </div>
                    <div class="vocab-card__pronunciation">
                        <button class="vocab-card__pronounce" type="button" data-action="play-pronunciation" aria-label="直接播放 ${safeWord} 的真人英式发音" aria-busy="false">
                            <span class="vocab-card__pronounce-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M5 10v4h3l4 3V7L8 10H5Z"></path><path d="M15 9.5c1.3 1.4 1.3 3.6 0 5"></path><path d="M17.5 7c2.7 2.8 2.7 7.2 0 10"></path></svg></span>
                            <span class="vocab-card__pronounce-label">真人英音</span>
                        </button>
                        <a class="vocab-card__pronounce vocab-card__pronounce--fallback" href="${cambridgeUrl}" target="_blank" rel="noopener noreferrer" data-pronunciation-fallback hidden aria-label="在 Cambridge Dictionary 打开 ${safeWord} 的真人英式发音">
                            <span class="vocab-card__pronounce-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M5 10v4h3l4 3V7L8 10H5Z"></path><path d="M15 9.5c1.3 1.4 1.3 3.6 0 5"></path><path d="M17.5 7c2.7 2.8 2.7 7.2 0 10"></path></svg></span>
                            <span class="vocab-card__pronounce-label">去 Cambridge 听</span>
                        </a>
                    </div>
                    ${meaningBlock}
                    ${revealControl}
                    <p class="vocab-card__instruction">${session.meaningVisible ? '对照释义后，选择最真实的记忆状态' : '先凭记忆判断；拿不准可以查看释义'}</p>
                    <div class="vocab-card__actions vocab-card__actions--inline vocab-card__ratings" aria-label="选择记忆状态">
                        <button class="btn vocab-rate vocab-rate--know" type="button" data-action="recognize-easy"><span>认识</span><small>马上能想起</small></button>
                        <button class="btn vocab-rate vocab-rate--fuzzy" type="button" data-action="recognize-good"><span>有点模糊</span><small>需要提示</small></button>
                        <button class="btn vocab-rate vocab-rate--unknown" type="button" data-action="recognize-hard"><span>不认识</span><small>重新学习</small></button>
                    </div>
                </div>
            `;
            return;
        }
        if (session.stage === 'spelling') {
            const attempts = session.spellingAttempts || 0;
            const maxAttempts = 3;
            const remainingAttempts = maxAttempts - attempts;
            
            const attemptsHint = attempts > 0 
                ? `<p class="vocab-card__attempts" style="color: #ed8936; font-size: 0.875rem;">已尝试 ${attempts} 次，剩余 ${remainingAttempts} 次机会</p>`
                : '';
            
            const instructionText = attempts === 0
                ? '根据释义，拼写出这个单词'
                : '再试一次，注意拼写细节';
            
            const safeMeaning = escapeHtml(word.meaning || '暂无释义');
            card.innerHTML = `
                <div class="vocab-card vocab-card--spelling">
                    <div class="vocab-card__meaning" data-visible="true" style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">
                        ${safeMeaning}
                    </div>
                    <p class="vocab-card__instruction">${instructionText}</p>
                    ${attemptsHint}
                    <div class="vocab-card__input-block">
                        <input type="text" name="answer" autocomplete="off" placeholder="在此输入拼写" value="${escapeHtml(session.typedAnswer)}" autofocus>
                        <div class="vocab-card__input-actions">
                            <button class="btn btn-ghost" type="button" data-action="skip-spelling">跳过</button>
                            <button class="btn btn-primary" type="button" data-action="submit-spelling">提交 (Enter)</button>
                        </div>
                    </div>
                </div>
            `;
            const input = card.querySelector('input[name="answer"]');
            if (input) {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                input.addEventListener('input', (event) => {
                    state.session.typedAnswer = event.target.value;
                });
            }
            return;
        }
        if (session.stage === 'feedback') {
            const recognitionQuality = session.lastAnswer?.recognitionQuality || 'good';
            const spellingAttempts = session.lastAnswer?.spellingAttempts || 0;
            const skipped = session.lastAnswer?.skipped || false;
            const finalQuality = session.lastAnswer?.finalQuality || recognitionQuality;
            const feedbackKind = finalQuality === 'wrong'
                ? 'wrong'
                : (spellingAttempts > 0 ? 'near' : 'correct');

            const icon = feedbackKind === 'wrong' ? '❌' : (feedbackKind === 'near' ? '🟡' : '✅');
            const title = skipped
                ? '已跳过，需要加强'
                : (feedbackKind === 'wrong' ? '这次没记住' : (feedbackKind === 'near' ? '差一点就对了' : '拼写正确'));
            const typedAnswer = session.lastAnswer?.typed ? escapeHtml(session.lastAnswer.typed) : '';

            let planTitle = '已安排复习';
            let planText = word.nextReview
                ? `下次复习：${formatDateTime(word.nextReview)}`
                : '系统会按照你的表现自动安排下次复习。';
            if (session.lastAnswer?.needsEasyVerification) {
                planTitle = '稍后再确认一次';
                planText = '这个词会在本轮后面再次出现，确认你是真的记住了。';
            } else if (session.lastAnswer?.needsContinueIntra) {
                planTitle = '本轮还会再见';
                planText = '系统会在后面自动插入这个词，帮你把记忆加深。';
            } else if (skipped || feedbackKind === 'wrong') {
                planTitle = '已经加强安排';
                planText = '这个词会更早再次出现，不用现在死记。';
            }

            const safeWord = escapeHtml(word.word);
            const safeMeaning = escapeHtml(word.meaning || '暂无释义');
            const safeExample = escapeHtml(word.example || '');
            const phonetic = normalizePhoneticValue(word.phonetic);
            const phoneticDetail = phonetic
                ? `<div><dt>音标</dt><dd class="vocab-feedback__phonetic"><span aria-hidden="true">/</span><span>${escapeHtml(phonetic)}</span><span aria-hidden="true">/</span></dd></div>`
                : '';
            const exampleDetail = safeExample
                ? `<div class="vocab-feedback__wide"><dt>例句</dt><dd>${safeExample}</dd></div>`
                : '';
            const typedDetail = typedAnswer && (feedbackKind !== 'correct' || typedAnswer.toLowerCase() !== safeWord.toLowerCase())
                ? `<p class="vocab-feedback__typed">你的拼写：${typedAnswer}</p>`
                : '';
            card.innerHTML = `
                <div class="vocab-card vocab-card--feedback vocab-card--${feedbackKind}">
                    <div class="vocab-feedback__head">
                        <span class="vocab-feedback__icon">${icon}</span>
                        <div>
                            <h3>${title}</h3>
                            <p>${feedbackKind === 'correct' ? '这个词已经记入本轮进度' : '看一眼正确答案，继续往下就好'}</p>
                        </div>
                    </div>
                    <dl class="vocab-feedback__details">
                        <div><dt>正确拼写</dt><dd>${safeWord}</dd></div>
                        ${phoneticDetail}
                        <div class="vocab-feedback__wide"><dt>释义</dt><dd>${safeMeaning}</dd></div>
                        ${exampleDetail}
                    </dl>
                    ${typedDetail}
                    <div class="vocab-feedback__plan">
                        <strong>${planTitle}</strong>
                        <p>${planText}</p>
                    </div>
                    <div class="vocab-card__actions vocab-card__actions--center">
                        <button class="btn btn-primary" type="button" data-action="next-word">下一个单词 <kbd>Enter</kbd></button>
                    </div>
                </div>
            `;
            announce(title);
            return;
        }
        card.innerHTML = `
            <div class="vocab-card vocab-card--placeholder">
                <p>准备下一条词汇…</p>
            </div>
        `;
    }

    function prepareSessionQueue(options = {}) {
        const store = state.store;
        if (!store) {
            return;
        }
        const config = store.getConfig();
        const { preferNew = false } = options;
        const reviewLimit = Number(config.reviewLimit) || DEFAULT_BATCH_SIZE;
        const now = new Date();
        const dueAll = store.getDueWords(now);
        const dueSelection = preferNew ? [] : dueAll.slice(0, reviewLimit);
        const preferredNewLimit = Number(config.dailyNew) > 0 ? Number(config.dailyNew) : DEFAULT_BATCH_SIZE;
        const newLimit = preferNew
            ? preferredNewLimit
            : Math.max(reviewLimit - dueSelection.length, 0) || preferredNewLimit;
        const newWords = newLimit > 0 ? store.getNewWords(newLimit) : [];
        state.session.backlog = dueSelection.concat(newWords).map((word) => ({ ...word }));
        state.session.dueTotal = dueSelection.length;
        state.session.newTotal = newWords.length;
        state.session.duePending = dueAll.length;
        if (!state.session.backlog.length) {
            state.session.stage = 'empty';
        } else {
            state.session.stage = 'preparing';
        }
    }

    function startReviewFlow(options = {}) {
        const { preferNew = false } = options;
        prepareSessionQueue({ preferNew });
        showDueBanner(state.session.duePending);
        state.ui.sidePanelManual = null;
        if (!state.session.backlog.length) {
            state.session.stage = 'empty';
            render();
            return;
        }
        startBatch(true);
    }

    function render() {
        renderCard();
        updateProgressStats();
        updateSidePanelContent(state.session.currentWord);
        updateBottomBar();
        updatePrimaryAction();
        syncSidePanelVisibility();
    }

    async function mount(container) {
        const target = resolveContainer(container || '#vocab-view');
        if (!target) {
            console.warn('[VocabSessionView] 容器不存在');
            return;
        }
        document.body?.classList.add('vocab-focus-active');
        target.removeAttribute('hidden');
        state.container = target;
        if (!state.initialized) {
            createLayout(target);
            setupViewportWatcher();
            bindEvents();
            updateSidePanelMode();
            state.initialized = true;
        }
        state.store = window.VocabStore || state.store;
        state.scheduler = window.VocabScheduler || state.scheduler;
        if (!state.store || typeof state.store.init !== 'function') {
            if (state.elements.sessionCard) {
                state.elements.sessionCard.innerHTML = '<p class="vocab-card-error">词汇模块未加载，请稍后重试。</p>';
            }
            return;
        }
        state.session.stage = 'loading';
        render();
        try {
            await state.store.init();
        } catch (error) {
            console.error('[VocabSessionView] 初始化失败:', error);
            if (state.elements.sessionCard) {
                state.elements.sessionCard.innerHTML = `<div class="vocab-card-error">初始化失败：${error.message || error}</div>`;
            }
            return;
        }
        ensureListSwitcher();
        prepareSessionQueue();
        showDueBanner(state.session.duePending);
        if (state.session.stage === 'empty') {
            render();
            return;
        }
        startBatch(true);
    }

    function startSession() {
        if (state.session.stage === 'empty') {
            return;
        }
        startBatch(true);
    }

    function refreshDashboard() {
        const stats = computeStats();
        if (stats) {
            state.session.duePending = stats.dueCount;
            showDueBanner(stats.dueCount);
        }
        updateProgressStats();
        updatePrimaryAction();
    }

    const api = {
        mount,
        startSession,
        refreshDashboard,
        render,
        get state() {
            return { ...state.session };
        }
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        window.VocabSessionView = api;
        window.vocabModule = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
