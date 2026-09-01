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

    const CHECKPOINT_STORAGE_KEY = 'ielts_vocab_session_checkpoint';
    let sessionActiveStartTime = null;

    function flushVocabStudyTime() {
        if (sessionActiveStartTime) {
            const elapsed = Math.round((Date.now() - sessionActiveStartTime) / 1000);
            if (elapsed >= 2) {
                if (window.StudyStatsManager) {
                    window.StudyStatsManager.addVocabStudyDuration(elapsed);
                    window.StudyStatsManager.render();
                }
            }
            sessionActiveStartTime = Date.now();
        }
        saveSessionCheckpoint();
    }

    function saveSessionCheckpoint() {
        try {
            if (state.session.stage === 'complete' || state.session.stage === 'batch-summary' || state.session.stage === 'empty') {
                localStorage.removeItem(CHECKPOINT_STORAGE_KEY);
                return;
            }
            if (!state.session.currentWordItem && (!state.session.activeQueue || !state.session.activeQueue.length) && state.session.stage !== 'batch-spelling') {
                return;
            }

            const checkpoint = {
                timestamp: Date.now(),
                mode: state.session.currentMode || 'learn',
                stage: state.session.stage,
                currentWordItem: state.session.currentWordItem,
                currentWord: state.session.currentWordItem?.word || state.session.currentWord,
                activeQueue: state.session.activeQueue,
                completedWords: state.session.completedWords,
                backlog: state.session.backlog,
                batchTotal: state.session.batchTotal,
                batchWords: state.session.batchWords,
                spellingIndex: state.session.spellingIndex,
                spellingWords: state.session.spellingWords,
                progress: state.session.progress
            };
            localStorage.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(checkpoint));
        } catch (e) {
            console.warn('[Vocab] Failed to save session checkpoint:', e);
        }
    }

    function loadSessionCheckpoint() {
        try {
            const raw = localStorage.getItem(CHECKPOINT_STORAGE_KEY);
            if (raw) {
                const cp = JSON.parse(raw);
                if (cp && (cp.currentWord || (cp.activeQueue && cp.activeQueue.length))) {
                    return cp;
                }
            }
        } catch (_) {}
        return null;
    }

    function clearSessionCheckpoint() {
        try {
            localStorage.removeItem(CHECKPOINT_STORAGE_KEY);
        } catch (_) {}
    }

    function resetSessionState() {
        stopActivePronunciation();
        state.session.backlog = [];
        state.session.activeQueue = [];
        state.session.completedWords = [];
        state.session.currentWordItem = null;
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
                    <div class="vocab-topbar__section vocab-topbar__section--center" data-vocab-role="progress" hidden>
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
                        <button class="btn btn-primary" type="button" data-action="primary-cta" hidden>开始复习</button>
                        <div class="vocab-topbar__menu">
                            <button class="btn btn-ghost btn-icon" type="button" data-action="toggle-menu" aria-haspopup="true" aria-expanded="false">⋮</button>
                            <div class="vocab-menu" data-vocab-role="menu" hidden>
                                <div class="vocab-menu__panel" data-vocab-role="menu-panel-main">
                                    <button type="button" data-action="menu-view-learned">📚 全部已学单词</button>
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
            <!-- 模式选择首页仪表盘 (Dashboard) -->
            <section class="vocab-mode-dashboard" data-vocab-role="mode-dashboard">
                <div class="vocab-mode-grid">
                    <div class="vocab-mode-card" data-action="start-learn-mode" role="button" tabindex="0">
                        <div class="vocab-mode-header">
                            <h3 class="vocab-mode-title">📖 Learning</h3>
                            <span class="vocab-mode-badge">新词学习</span>
                        </div>
                        <div class="vocab-mode-number"><span data-vocab-role="learn-count">0</span> <span style="font-size: 1.1rem; font-weight: 500; color: var(--text-muted, #94a3b8);">词</span></div>
                        <p class="vocab-mode-desc">按你的掌握目标推送全新核心词汇，打牢词汇基础。</p>
                        <div class="vocab-mode-action-btn">
                            <span data-vocab-role="learn-btn-label">开始学习</span> →
                        </div>
                    </div>

                    <div class="vocab-mode-card" data-action="start-review-mode" role="button" tabindex="0">
                        <div class="vocab-mode-header">
                            <h3 class="vocab-mode-title">🔁 Review</h3>
                            <span class="vocab-mode-badge" style="background: rgba(37, 99, 235, 0.12); color: #2563eb;">智能复习</span>
                        </div>
                        <div class="vocab-mode-number" style="color: #2563eb;"><span data-vocab-role="review-count">0</span> <span style="font-size: 1.1rem; font-weight: 500; color: var(--text-muted, #94a3b8);">词</span></div>
                        <p class="vocab-mode-desc">基于艾宾浩斯抗遗忘记忆曲线，精准巩固临界记忆词汇。</p>
                        <div class="vocab-mode-action-btn">
                            <span data-vocab-role="review-btn-label">开始复习</span> →
                        </div>
                    </div>
                </div>

                <!-- 词单与刷词大厅入口 -->
                <div style="margin-top: 28px; text-align: center;">
                    <button type="button" class="btn btn-outline" data-action="open-wordlist" style="border-radius: 9999px; padding: 12px 28px; font-weight: 600; color: #334155; background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(16px); border: 1px solid rgba(203, 213, 225, 0.85); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04); cursor: pointer; transition: all 0.2s ease;">
                        📚 已学词单 · 刷词与听写 (<span data-vocab-role="total-learned-count">0</span> 词) →
                    </button>
                </div>
            </section>

            <main class="vocab-body" data-vocab-role="main" hidden>
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
                const mainBody = state.container?.querySelector('[data-vocab-role="main"]');
                const modeDash = state.container?.querySelector('[data-vocab-role="mode-dashboard"]');
                const topProgress = state.container?.querySelector('[data-vocab-role="progress"]');
                if (mainBody && !mainBody.hasAttribute('hidden')) {
                    // 如果正在背词会话中，返回模式选择仪表盘并隐藏会话专属进度条
                    mainBody.setAttribute('hidden', 'hidden');
                    if (modeDash) modeDash.removeAttribute('hidden');
                    if (topProgress) topProgress.setAttribute('hidden', 'hidden');
                    updateModeCounts();
                    return;
                }
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
                if (action === 'menu-view-learned') {
                    openWordlistView('all');
                    return;
                }
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
                    startSelectedMode('review');
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
        if (state.container && !state.container.dataset.modeBound) {
            state.container.addEventListener('click', (event) => {
                const trigger = event.target.closest('[data-action]');
                if (!trigger) return;
                const action = trigger.dataset?.action;

                if (action === 'start-learn-mode') {
                    startSelectedMode('learn');
                }
                if (action === 'start-review-mode') {
                    startSelectedMode('review');
                }
                if (action === 'open-wordlist') {
                    openWordlistView('all');
                }
            });
            state.container.dataset.modeBound = 'true';
        }
        if (!state.lifecycleBound) {
            window.addEventListener('beforeunload', flushVocabStudyTime);
            window.addEventListener('pagehide', flushVocabStudyTime);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') flushVocabStudyTime();
            });
            document.querySelectorAll('.nav-btn').forEach(btn => {
                btn.addEventListener('click', flushVocabStudyTime);
            });
            state.lifecycleBound = true;
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
                if (state.session.stage === 'recognition' && !isFieldActive) {
                    const subStage = state.session.subStage || 'testing';
                    const passStage = state.session.currentWordItem?.passStage || 0;
                    if (subStage === 'testing') {
                        if (passStage === 1) {
                            if (event.code === 'Digit1' || event.code === 'KeyJ' || event.code === 'Enter') {
                                event.preventDefault();
                                handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-p2-know' } }) }, preventDefault: () => {} });
                                return;
                            }
                            if (event.code === 'Digit2' || event.code === 'KeyK') {
                                event.preventDefault();
                                handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-p2-unknown' } }) }, preventDefault: () => {} });
                                return;
                            }
                        } else {
                            if (event.code === 'Digit1' || event.code === 'KeyJ' || event.code === 'Enter') {
                                event.preventDefault();
                                handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-know' } }) }, preventDefault: () => {} });
                                return;
                            }
                            if (event.code === 'Digit2' || event.code === 'Space') {
                                event.preventDefault();
                                handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-hint' } }) }, preventDefault: () => {} });
                                return;
                            }
                            if (event.code === 'Digit3' || event.code === 'KeyK') {
                                event.preventDefault();
                                handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-unknown' } }) }, preventDefault: () => {} });
                                return;
                            }
                        }
                    } else if (subStage === 'hint-revealed') {
                        if (event.code === 'Digit1' || event.code === 'KeyJ') {
                            event.preventDefault();
                            handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-hint-wrong' } }) }, preventDefault: () => {} });
                            return;
                        }
                        if (event.code === 'Digit2' || event.code === 'KeyK' || event.code === 'Enter') {
                            event.preventDefault();
                            handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-hint-correct' } }) }, preventDefault: () => {} });
                            return;
                        }
                    } else if (subStage === 'detail-review') {
                        if (event.code === 'Enter' || event.code === 'Space' || event.code === 'Digit1') {
                            event.preventDefault();
                            handleCardAction({ target: { closest: () => ({ dataset: { action: 'action-detail-next' } }) }, preventDefault: () => {} });
                            return;
                        }
                    }
                    if (event.code === 'KeyR') {
                        event.preventDefault();
                        playWordPronunciation(state.session.currentWord);
                        return;
                    }
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
        const stats = state.session.progress || {};
        let total = stats.total || 0;
        let completed = stats.completed || 0;

        // 如果当前在主页仪表盘或 total 为 0，读取上次断点同步最顶上的进度条
        if (!total) {
            const cp = loadSessionCheckpoint();
            if (cp && cp.progress && cp.progress.total > 0) {
                total = cp.progress.total;
                completed = cp.progress.completed || 0;
            }
        }

        const accuracy = completed > 0
            ? Math.min(100, Math.max(0, Math.round((Math.min(stats.correct || 0, completed) / completed) * 100)))
            : 0;
        let pendingCurrent = ['recognition', 'spelling'].includes(state.session.stage) ? 1 : 0;
        if (state.session.stage === 'feedback') {
            pendingCurrent = 0;
        }
        const current = total ? Math.min(completed + pendingCurrent, total) : 0;

        if (state.elements.progressCount) {
            state.elements.progressCount.textContent = `${current} / ${total}`;
        }
        const chips = state.elements.progressStats.querySelectorAll('[data-chip]');
        chips.forEach((chip) => {
            const key = chip.dataset.chip;
            if (key === 'new') {
                chip.textContent = `新词 ${state.session.newTotal || 0}`;
            } else if (key === 'review') {
                chip.textContent = `复习 ${state.session.dueTotal || 0}`;
            } else if (key === 'accuracy') {
                chip.textContent = `正确率 ${accuracy}%`;
            }
        });
        if (state.elements.progressBar) {
            const percent = total ? Math.round((completed / total) * 100) : 0;
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
        const trigger = event.target?.closest ? event.target.closest('[data-action]') : null;
        const action = trigger?.dataset?.action;
        if (!action) {
            return;
        }
        if (event.preventDefault) event.preventDefault();

        // 1. 第一关认知动作
        if (action === 'action-know') {
            const item = state.session.currentWordItem;
            const w = normalizeWord(item?.word || state.session.currentWord);
            if (item && w) {
                item.passStage = 2;
                const completed = getCompletedWords();
                if (!completed.some(cw => (cw.id || cw.word) === (w.id || w.word))) {
                    completed.push(w);
                }
                if (window.StudyStatsManager) {
                    try { window.StudyStatsManager.recordWordStudied(w.word); } catch (_) {}
                }
            }
            nextCard();
            return;
        }
        if (action === 'action-hint') {
            state.session.subStage = 'hint-revealed';
            const w = normalizeWord(state.session.currentWord || state.session.currentWordItem?.word);
            if (w) playWordPronunciation(w);
            render();
            return;
        }
        if (action === 'action-unknown') {
            state.session.subStage = 'detail-review';
            if (state.session.currentWordItem) {
                state.session.currentWordItem.passStage = 0;
            }
            const w = normalizeWord(state.session.currentWord || state.session.currentWordItem?.word);
            if (w) playWordPronunciation(w);
            render();
            return;
        }
        if (action === 'action-hint-correct') {
            const item = state.session.currentWordItem;
            if (item) {
                item.passStage = 1;
                interleaveWord(item);
            }
            nextCard();
            return;
        }
        if (action === 'action-hint-wrong') {
            const item = state.session.currentWordItem;
            if (item) {
                item.passStage = 0;
                interleaveWord(item);
            }
            nextCard();
            return;
        }
        if (action === 'action-detail-next') {
            const item = state.session.currentWordItem;
            if (item) {
                item.passStage = 0;
                interleaveWord(item);
            }
            nextCard();
            return;
        }

        // 2. 第二关盲测动作
        if (action === 'action-p2-know') {
            const item = state.session.currentWordItem;
            const w = normalizeWord(item?.word || state.session.currentWord);
            if (item && w) {
                item.passStage = 2;
                const completed = getCompletedWords();
                if (!completed.some(cw => (cw.id || cw.word) === (w.id || w.word))) {
                    completed.push(w);
                }
                if (window.StudyStatsManager) {
                    try { window.StudyStatsManager.recordWordStudied(w.word); } catch (_) {}
                }
            }
            nextCard();
            return;
        }
        if (action === 'action-p2-unknown') {
            const item = state.session.currentWordItem;
            if (item) {
                item.passStage = 0;
            }
            state.session.subStage = 'detail-review';
            const w = normalizeWord(state.session.currentWord || state.session.currentWordItem?.word);
            if (w) playWordPronunciation(w);
            render();
            return;
        }

        // 3. 通用辅助动作
        if (action === 'play-pronounce') {
            const w = normalizeWord(state.session.currentWord || state.session.currentWordItem?.word);
            if (w) playWordPronunciation(w);
            return;
        }
        if (action === 'open-dict-drawer') {
            const w = normalizeWord(state.session.currentWord || state.session.currentWordItem?.word);
            if (w) openDictionaryDrawer(w);
            return;
        }
        if (action === 'mark-familiar') {
            markCurrentWordFamiliar(trigger);
            return;
        }
        if (action === 'return-mode-dash') {
            const mainBody = state.container?.querySelector('[data-vocab-role="main"]');
            const modeDash = state.container?.querySelector('[data-vocab-role="mode-dashboard"]');
            const topProgress = state.container?.querySelector('[data-vocab-role="progress"]');
            if (mainBody) mainBody.setAttribute('hidden', 'hidden');
            if (modeDash) modeDash.removeAttribute('hidden');
            if (topProgress) topProgress.setAttribute('hidden', 'hidden');
            updateModeCounts();
            return;
        }

        // 4. 组末集中拼写与结算动作
        if (action === 'spelling-submit') {
            checkBatchSpelling();
            return;
        }
        if (action === 'spelling-hint') {
            giveBatchSpellingHint();
            return;
        }
        if (action === 'spelling-skip') {
            skipBatchSpelling();
            return;
        }
        if (action === 'start-next-batch') {
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
        const item = state.session.currentWordItem;
        const word = normalizeWord(item?.word || state.session.currentWord);
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
            if (item) {
                item.passStage = 2;
            }
            if (!state.session.completedWords.some(cw => (cw.id || cw.word) === (word.id || word.word))) {
                state.session.completedWords.push(word);
            }
            state.session.activeQueue = (state.session.activeQueue || []).filter((it) => {
                const nw = normalizeWord(it.word || it);
                return nw && (nw.id || nw.word) !== (word.id || word.word);
            });
            state.session.backlog = (state.session.backlog || []).filter((it) => {
                const nw = normalizeWord(it.word || it);
                return nw && (nw.id || nw.word) !== (word.id || word.word);
            });
            
            // 实时记录到全局学习统计，确保立即在统计卡片上反映
            if (window.StudyStatsManager) {
                try {
                    window.StudyStatsManager.recordWordStudied(word.word);
                    window.StudyStatsManager.addVocabStudyDuration(15);
                    window.StudyStatsManager.render();
                } catch (_) {}
            }
            saveSessionCheckpoint();

            showFeedbackMessage(`“${word.word}”已标为熟词并通关！`, 'success');
            announce(`${word.word} 已标为熟词`);
            nextCard();
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

        // 记录背单词学习时间与词汇量
        if (window.StudyStatsManager && word && word.word) {
            try {
                window.StudyStatsManager.recordWordStudied(word.word);
                window.StudyStatsManager.addVocabStudyDuration(15);
            } catch (_) {}
        }
        
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
        
        // 统计本轮答题进度与结果（每学完/过完一个词即前进）
        if (!Array.isArray(session.completedWordIds)) {
            session.completedWordIds = [];
        }
        if (word && word.id && !session.completedWordIds.includes(word.id)) {
            session.completedWordIds.push(word.id);
            session.progress.completed = Math.min(session.progress.total, session.completedWordIds.length);
        }
        if (finalQuality === 'wrong') {
            session.progress.wrong += 1;
        } else if (finalQuality === 'hard' || spellingAttempts > 0) {
            session.progress.near += 1;
        } else {
            session.progress.correct += 1;
        }
        saveSessionCheckpoint();
        
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

    function getCompletedWords() {
        if (!Array.isArray(state.session.completedWords)) {
            state.session.completedWords = [];
        }
        return state.session.completedWords;
    }

    function normalizeWord(raw) {
        if (!raw) return null;
        let candidate = raw;
        if (typeof raw === 'string') {
            const all = state.store?.getWords ? state.store.getWords() : [];
            const found = all.find(w => w.word === raw || w.id === raw);
            return found ? { ...found } : { id: raw, word: raw, meaning: '暂无释义', phonetic: '', example: '' };
        }
        if (candidate.wordObj) {
            candidate = candidate.wordObj;
        }
        while (candidate && candidate.word && typeof candidate.word === 'object') {
            candidate = candidate.word;
        }
        if (!candidate || !candidate.word) {
            return null;
        }
        const wStr = String(candidate.word).trim();
        // If candidate.meaning is missing, look up in store
        if ((!candidate.meaning || candidate.meaning === '暂无释义') && state.store?.getWords) {
            const all = state.store.getWords();
            const found = all.find(w => w.word === wStr || (candidate.id && w.id === candidate.id));
            if (found && found.meaning) {
                candidate = { ...found, ...candidate, meaning: found.meaning };
            }
        }
        return {
            id: candidate.id || wStr,
            word: wStr,
            phonetic: candidate.phonetic || '',
            meaning: candidate.meaning || '暂无释义',
            example: candidate.example || '',
            exampleCn: candidate.exampleCn || candidate.translation || '',
            familiar: Boolean(candidate.familiar),
            correctCount: Number(candidate.correctCount || 0),
            lastReviewed: candidate.lastReviewed || null,
            nextReview: candidate.nextReview || null
        };
    }

    function interleaveWord(item) {
        const q = state.session.activeQueue;
        if (!q || !q.length) {
            state.session.activeQueue = [item];
            return;
        }
        // 智能穿插：插入到后续第 2~4 个位置，若队列较短则插入末尾
        const minPos = Math.min(q.length, 2);
        const maxPos = Math.min(q.length, 4);
        const insertPos = Math.floor(Math.random() * (maxPos - minPos + 1)) + minPos;
        q.splice(insertPos, 0, item);
    }

    function nextCard() {
        stopActivePronunciation();
        const session = state.session;
        session.subStage = 'testing';
        session.meaningVisible = false;

        // 如果本批次队列中还有未通过两关的词，继续推进
        if (session.activeQueue && session.activeQueue.length > 0) {
            session.currentWordItem = session.activeQueue.shift();
            session.currentWord = session.currentWordItem ? normalizeWord(session.currentWordItem.word) : null;
            if (session.currentWordItem) {
                session.currentWordItem.word = session.currentWord;
            }
            if (session.progress) {
                session.progress.completed = session.completedWords?.length || 0;
            }
            saveSessionCheckpoint();
            render();
            return;
        }

        // 本批次单词全部完成双关认知（activeQueue 为空）！
        // 自动统一进入组末集中拼写模式！
        startBatchSpelling(session.completedWords);
    }

    function startBatchSpelling(words) {
        const session = state.session;
        session.stage = 'batch-spelling';
        session.spellingWords = Array.isArray(words) && words.length 
            ? words.map(w => normalizeWord(w)).filter(Boolean)
            : (session.batchWords || []).map(w => normalizeWord(w)).filter(Boolean);
        session.spellingIndex = 0;
        session.spellingInput = '';
        session.spellingHintChars = 0;
        session.spellingFeedback = '';
        saveSessionCheckpoint();
        render();
    }

    function checkBatchSpelling() {
        const session = state.session;
        const words = session.spellingWords || [];
        const currentWord = words[session.spellingIndex] ? normalizeWord(words[session.spellingIndex]) : null;
        if (!currentWord) return;

        const card = state.elements.sessionCard;
        const input = card?.querySelector('[data-field="batch-spell-input"]');
        const feedback = card?.querySelector('[data-field="batch-spell-feedback"]');

        const typed = (input?.value || session.spellingInput || '').trim().toLowerCase();
        const target = String(currentWord.word || '').trim().toLowerCase();

        if (typed === target) {
            if (feedback) {
                feedback.style.color = '#10b981';
                feedback.textContent = '✓ 拼写正确！';
            }
            if (input) {
                input.style.borderColor = '#10b981';
                input.style.background = '#f0fdf4';
            }
            playWordPronunciation(currentWord);
            setTimeout(() => {
                session.spellingIndex += 1;
                session.spellingInput = '';
                session.spellingHintChars = 0;
                session.spellingFeedback = '';
                if (session.spellingIndex >= session.spellingWords.length) {
                    finishBatchSession();
                } else {
                    render();
                }
            }, 600);
        } else {
            if (feedback) {
                feedback.style.color = '#ea580c';
                feedback.textContent = '拼写不匹配，再试一次或点击提示';
            }
            if (input) {
                input.style.borderColor = '#ef4444';
                input.focus();
            }
        }
    }

    function giveBatchSpellingHint() {
        const session = state.session;
        const words = session.spellingWords || [];
        const currentWord = words[session.spellingIndex] ? normalizeWord(words[session.spellingIndex]) : null;
        if (!currentWord) return;

        const card = state.elements.sessionCard;
        const input = card?.querySelector('[data-field="batch-spell-input"]');
        const target = String(currentWord.word || '').trim();

        session.spellingHintChars = Math.min((session.spellingHintChars || 0) + 1, target.length);
        const hintPart = target.slice(0, session.spellingHintChars);
        session.spellingInput = hintPart;
        if (input) {
            input.value = hintPart;
            input.focus();
        }
    }

    function skipBatchSpelling() {
        const session = state.session;
        const words = session.spellingWords || [];
        const currentWord = words[session.spellingIndex] ? normalizeWord(words[session.spellingIndex]) : null;
        if (!currentWord) return;

        const card = state.elements.sessionCard;
        const input = card?.querySelector('[data-field="batch-spell-input"]');
        const feedback = card?.querySelector('[data-field="batch-spell-feedback"]');
        const target = String(currentWord.word || '').trim();

        if (input) input.value = target;
        if (feedback) {
            feedback.style.color = '#ea580c';
            feedback.textContent = `正确拼写为: ${target}`;
        }
        playWordPronunciation(currentWord);
        setTimeout(() => {
            session.spellingIndex += 1;
            session.spellingInput = '';
            session.spellingHintChars = 0;
            session.spellingFeedback = '';
            if (session.spellingIndex >= session.spellingWords.length) {
                finishBatchSession();
            } else {
                render();
            }
        }, 1200);
    }

    async function finishBatchSession() {
        const session = state.session;
        session.stage = 'batch-summary';

        // 统一提交本组全部已学单词并记录艾宾浩斯复习时间
        const now = new Date();
        for (const rawW of (session.spellingWords || [])) {
            const w = normalizeWord(rawW);
            if (!w) continue;
            try {
                const patch = state.scheduler.scheduleAfterResult(w, 'good', now);
                await state.store.updateWord(w.id, {
                    ...patch,
                    lastReviewed: now.toISOString()
                });
                if (window.StudyStatsManager) {
                    window.StudyStatsManager.recordWordStudied(w.word);
                    window.StudyStatsManager.addVocabStudyDuration(30);
                }
            } catch (_) {}
        }
        if (window.StudyStatsManager) {
            try { window.StudyStatsManager.render(); } catch (_) {}
        }

        clearSessionCheckpoint();
        render();
    }

    function startBatch(force) {
        const session = state.session;
        if (!force && session.activeQueue && session.activeQueue.length) {
            return;
        }
        if ((!session.backlog || session.backlog.length === 0) && (!session.activeQueue || session.activeQueue.length === 0)) {
            session.stage = 'complete';
            render();
            return;
        }
        state.ui.sidePanelManual = null;
        session.batchIndex += 1;
        const batchLimit = session.batchSize || DEFAULT_BATCH_SIZE;
        const rawBatch = (session.backlog || []).splice(0, batchLimit);
        const validWords = rawBatch.map(w => normalizeWord(w)).filter(Boolean);

        session.activeQueue = validWords.map((w) => ({ word: w, passStage: 0 }));
        session.batchTotal = session.activeQueue.length;
        session.batchWords = validWords.map((w) => ({ ...w }));
        session.completedWords = [];
        session.currentWordItem = session.activeQueue.shift() || null;
        session.currentWord = session.currentWordItem?.word || null;
        session.subStage = 'testing';
        session.progress = {
            total: session.batchTotal,
            completed: 0,
            correct: 0,
            near: 0,
            wrong: 0
        };
        hideDueBanner();
        session.stage = 'recognition';
        saveSessionCheckpoint();
        render();
    }

    function endCurrentSession() {
        state.session.stage = 'complete';
        render();
        navigateToMoreView();
    }

    function playWordPronunciation(wordObj) {
        if (!wordObj || !wordObj.word) return;
        const audioUrl = buildBritishPronunciationUrl(wordObj.word);
        if (audioUrl) {
            const audio = new Audio(audioUrl);
            audio.play().catch(() => {
                if ('speechSynthesis' in window) {
                    const u = new SpeechSynthesisUtterance(wordObj.word);
                    u.lang = 'en-GB';
                    window.speechSynthesis.speak(u);
                }
            });
        } else if ('speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance(wordObj.word);
            u.lang = 'en-GB';
            window.speechSynthesis.speak(u);
        }
    }

    function isLearnedWord(w) {
        if (!w) return false;
        return Boolean(w.familiar || w.lastReviewed || w.nextReview || (Number(w.correctCount || 0) > 0));
    }

    function formatWordDate(w) {
        if (!w) return '核心词汇';
        const raw = w.familiarAt || w.lastReviewed;
        if (!raw) return '已学词汇';
        const d = new Date(raw);
        if (isNaN(d.getTime())) return '已学词汇';
        try {
            return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
        } catch (_) {
            return '已学词汇';
        }
    }

    function getWordsByScope(scope = state.selectedScope || 'all') {
        const store = state.store || window.VocabStore;
        if (!store || typeof store.getWords !== 'function') return [];
        const words = store.getWords();
        const config = typeof store.getConfig === 'function' ? store.getConfig() : {};
        const masteryTarget = Number(config.masteryCount || 4);

        const learned = words.filter((w) => isLearnedWord(w));
        if (scope === 'mastered') {
            return learned.filter((w) => w.familiar === true || Number(w.correctCount || 0) >= masteryTarget);
        }
        if (scope === 'reviewing') {
            return learned.filter((w) => !(w.familiar === true || Number(w.correctCount || 0) >= masteryTarget));
        }
        return learned;
    }

    function saveImmersiveIndex(scope, index) {
        try {
            localStorage.setItem(`vocab_immersive_pos_${scope || 'all'}`, String(index));
        } catch (_) {}
    }

    function loadImmersiveIndex(scope) {
        try {
            const v = localStorage.getItem(`vocab_immersive_pos_${scope || 'all'}`);
            return v !== null ? Number(v) : 0;
        } catch (_) {
            return 0;
        }
    }

    // 权威词典抽屉 (剑桥/牛津权威中英释义、例句与音标，站内直接查看无需跳转)
    async function openDictionaryDrawer(wordObj) {
        if (!wordObj || !wordObj.word) return;
        const word = wordObj.word;

        document.querySelectorAll('.vocab-dict-drawer').forEach(el => el.remove());

        const drawer = document.createElement('div');
        drawer.className = 'vocab-dict-drawer';
        drawer.innerHTML = `
            <div class="vocab-dict-drawer-panel">
                <div style="padding: 16px 20px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; background: #ffffff;">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 1.25rem;">📖</span>
                        <h3 style="margin: 0; font-size: 1.15rem; font-weight: 700; color: #0f172a;">权威学术词典</h3>
                    </div>
                    <button type="button" class="vocab-tool-close-btn" data-action="close-dict-drawer" style="border: none; background: transparent; font-size: 1.3rem; cursor: pointer; color: #64748b;">✕</button>
                </div>
                <div class="vocab-dict-body">
                    <div style="margin-bottom: 24px;">
                        <div style="display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px;">
                            <h2 style="margin: 0; font-size: 2rem; font-weight: 800; color: #ea580c; letter-spacing: -0.02em;">${word}</h2>
                            <button type="button" class="btn btn-sm btn-ghost" data-action="play-dict-audio" style="font-size: 0.95rem; color: #475569; padding: 4px 10px; border-radius: 999px; background: #f1f5f9;">
                                🔊 <span data-field="dict-phonetic">${wordObj.phonetic ? `/${wordObj.phonetic}/` : '发音'}</span>
                            </button>
                        </div>
                        <div style="font-size: 1.05rem; font-weight: 600; color: #1e293b; line-height: 1.4; padding: 12px 16px; background: rgba(234, 88, 12, 0.06); border-radius: 12px; border-left: 4px solid #ea580c;">
                            ${wordObj.meaning || ''}
                        </div>
                    </div>

                    <div style="margin-bottom: 24px;">
                        <div style="font-size: 0.85rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 14px;">
                            官方学术释义与权威语料 (Cambridge / Oxford)
                        </div>
                        <div data-field="dict-definitions-container">
                            <div style="display: flex; align-items: center; gap: 10px; color: #94a3b8; padding: 16px 0;">
                                <div class="spinner" style="width: 20px; height: 20px; border-width: 2px;"></div>
                                <span>正在检索剑桥/牛津官方学术释义…</span>
                            </div>
                        </div>
                    </div>

                    <div style="margin-top: auto; padding-top: 24px; border-top: 1px solid #f1f5f9; text-align: center;">
                        <a href="https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(word)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline" style="border-radius: 999px; padding: 10px 24px; font-size: 0.9rem; font-weight: 600; color: #2563eb; border-color: #bfdbfe; background: rgba(37,99,235,0.04); text-decoration: none; display: inline-flex; align-items: center; gap: 6px;">
                            在剑桥词典官网查看完整语法长篇 ↗
                        </a>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(drawer);

        drawer.addEventListener('click', (e) => {
            if (e.target === drawer || e.target.closest('[data-action="close-dict-drawer"]')) {
                drawer.remove();
            } else if (e.target.closest('[data-action="play-dict-audio"]')) {
                playWordPronunciation(wordObj);
            }
        });

        const defContainer = drawer.querySelector('[data-field="dict-definitions-container"]');
        const phoneticEl = drawer.querySelector('[data-field="dict-phonetic"]');

        try {
            const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
            if (!resp.ok) throw new Error('API not ok');
            const data = await resp.json();
            if (Array.isArray(data) && data.length > 0) {
                const entry = data[0];
                if (!wordObj.phonetic && entry.phonetic) {
                    phoneticEl.textContent = entry.phonetic;
                }
                let defsHtml = '';
                (entry.meanings || []).slice(0, 3).forEach((meaning) => {
                    const pos = meaning.partOfSpeech || '';
                    (meaning.definitions || []).slice(0, 2).forEach((def) => {
                        defsHtml += `
                            <div class="vocab-dict-def-item">
                                <div class="vocab-dict-def-en">
                                    <span class="vocab-dict-pos-tag">${pos}</span>
                                    ${def.definition}
                                </div>
                                ${def.example ? `<div class="vocab-dict-example">“${def.example}”</div>` : ''}
                            </div>
                        `;
                    });
                });
                defContainer.innerHTML = defsHtml || '<div style="color: #64748b;">已收录核心考点语义。</div>';
                return;
            }
        } catch (_) {}

        defContainer.innerHTML = `
            <div class="vocab-dict-def-item">
                <div class="vocab-dict-def-en">
                    <span class="vocab-dict-pos-tag">考点核心</span>
                    ${wordObj.meaning || '权威语义'}
                </div>
                ${wordObj.example ? `<div class="vocab-dict-example">“${wordObj.example}”</div>` : ''}
            </div>
        `;
    }

    // 1. 沉浸刷词 (支持指定起始词索引，断点自动续刷，内置词典)
    function startImmersiveRunner(customWords = null, startIndex = -1, scope = null) {
        const currentScope = scope || state.selectedScope || 'all';
        const words = customWords && customWords.length ? customWords : getWordsByScope(currentScope);
        if (!words.length) {
            showFeedbackMessage('当前选中的分类下暂无单词，请前往上方 Learning 学习新词！', 'info');
            return;
        }

        let currentIndex = startIndex >= 0 ? startIndex : loadImmersiveIndex(currentScope);
        if (currentIndex >= words.length || currentIndex < 0) {
            currentIndex = 0;
        }

        let isMasked = true;

        const modal = document.createElement('div');
        modal.className = 'vocab-tool-modal';
        modal.innerHTML = `
            <div class="vocab-tool-dialog" style="max-width: 620px;">
                <div class="vocab-tool-header">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <button type="button" class="vocab-tool-close-btn" data-action="close-runner" title="退出刷词">✕</button>
                        <span style="font-weight: 600; color: #64748b; font-size: 0.95rem;" data-field="runner-index">1 / ${words.length}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <button type="button" class="btn btn-sm btn-ghost" data-action="open-dict" style="color: #2563eb; font-weight: 600; font-size: 0.9rem;">
                            📖 词典
                        </button>
                        <button type="button" class="btn btn-sm btn-ghost" data-action="mark-familiar" style="color: #ea580c; font-weight: 600; font-size: 0.9rem;">
                            ⭐ 标为熟词
                        </button>
                    </div>
                </div>
                <div class="vocab-tool-content" style="padding: 24px 20px;">
                    <div class="immersive-word-card">
                        <div class="immersive-word-title" data-field="runner-word">word</div>
                        <button type="button" class="immersive-word-phonetic" data-action="play-audio">
                            <span>🔊</span> <span data-field="runner-phonetic">/phonetic/</span>
                        </button>
                        <div class="immersive-meaning-box is-masked" data-action="toggle-mask">
                            <div class="immersive-meaning-text" data-field="runner-meaning">释义</div>
                            <div class="immersive-meaning-hint">👆 点击卡片空白处展开释义</div>
                        </div>
                        <div class="immersive-example-box" data-field="runner-example" style="display: none;"></div>
                    </div>
                </div>
                <div class="immersive-nav-bar">
                    <button type="button" class="btn btn-outline" data-action="prev-word" style="border-radius: 999px; padding: 8px 24px;">← 上一个</button>
                    <button type="button" class="btn btn-primary" data-action="next-word" style="border-radius: 999px; padding: 8px 28px; background: #ea580c; border-color: #ea580c;">下一个 →</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        function updateCard() {
            const w = words[currentIndex];
            if (!w) return;
            isMasked = true;
            modal.querySelector('[data-field="runner-index"]').textContent = `${currentIndex + 1} / ${words.length}`;
            modal.querySelector('[data-field="runner-word"]').textContent = w.word;
            modal.querySelector('[data-field="runner-phonetic"]').textContent = w.phonetic ? `/${w.phonetic}/` : '发音';
            modal.querySelector('[data-field="runner-meaning"]').textContent = w.meaning || '暂无释义';

            const meaningBox = modal.querySelector('.immersive-meaning-box');
            meaningBox.classList.add('is-masked');
            meaningBox.querySelector('.immersive-meaning-hint').style.display = 'block';

            const exampleBox = modal.querySelector('[data-field="runner-example"]');
            if (w.example) {
                exampleBox.textContent = `“${w.example}”`;
                exampleBox.style.display = 'block';
            } else {
                exampleBox.style.display = 'none';
            }

            saveImmersiveIndex(currentScope, currentIndex);
            playWordPronunciation(w);
        }

        modal.addEventListener('click', async (e) => {
            const trigger = e.target.closest('[data-action]');
            const action = trigger?.dataset?.action;
            if (action === 'close-runner') {
                modal.remove();
                updateModeCounts();
            } else if (action === 'toggle-mask') {
                const box = modal.querySelector('.immersive-meaning-box');
                isMasked = !isMasked;
                box.classList.toggle('is-masked', isMasked);
                box.querySelector('.immersive-meaning-hint').style.display = isMasked ? 'block' : 'none';
            } else if (action === 'play-audio') {
                playWordPronunciation(words[currentIndex]);
            } else if (action === 'open-dict') {
                openDictionaryDrawer(words[currentIndex]);
            } else if (action === 'next-word') {
                if (currentIndex < words.length - 1) {
                    currentIndex++;
                    updateCard();
                } else {
                    showFeedbackMessage('🎉 本组单词已全部刷完！', 'success');
                    modal.remove();
                    updateModeCounts();
                }
            } else if (action === 'prev-word') {
                if (currentIndex > 0) {
                    currentIndex--;
                    updateCard();
                }
            } else if (action === 'mark-familiar') {
                const w = words[currentIndex];
                if (w && state.store) {
                    await state.store.updateWord(w.id, { familiar: true, familiarAt: new Date().toISOString(), correctCount: 5 });
                    showFeedbackMessage(`“${w.word}”已标为熟词`, 'success');
                    if (window.StudyStatsManager) window.StudyStatsManager.recordWordStudied(w.word);
                    if (currentIndex < words.length - 1) {
                        currentIndex++;
                        updateCard();
                    } else {
                        modal.remove();
                        updateModeCounts();
                    }
                }
            }
        });

        updateCard();
    }

    // 2. 听写设置与运行
    function openDictationModal(customWords = null) {
        const words = customWords && customWords.length ? customWords : getWordsByScope(state.selectedScope);
        if (!words.length) {
            showFeedbackMessage('当前选中的分类下暂无已学单词，请前往上方 Learning 学习新词！', 'info');
            return;
        }

        const modal = document.createElement('div');
        modal.className = 'vocab-tool-modal';
        modal.innerHTML = `
            <div class="vocab-tool-dialog" style="max-width: 520px;">
                <div class="vocab-tool-header">
                    <h3 style="margin: 0; font-size: 1.25rem;">听写设置</h3>
                    <button type="button" class="vocab-tool-close-btn" data-action="close-dict-modal">✕</button>
                </div>
                <div class="vocab-tool-content" style="padding: 24px;">
                    <div style="display: flex; gap: 12px; margin-bottom: 24px;">
                        <button type="button" class="dict-mode-btn is-active" data-dict-mode="pron" style="flex: 1; padding: 14px 12px; border-radius: 16px; border: 2px solid #ea580c; background: rgba(234, 88, 12, 0.05); cursor: pointer; text-align: center;">
                            <div style="font-weight: 700; color: #ea580c; font-size: 1rem;">听发音</div>
                            <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 4px;">写单词 / 释义</div>
                        </button>
                        <button type="button" class="dict-mode-btn" data-dict-mode="meaning" style="flex: 1; padding: 14px 12px; border-radius: 16px; border: 1px solid #e2e8f0; background: #ffffff; cursor: pointer; text-align: center;">
                            <div style="font-weight: 700; color: #475569; font-size: 1rem;">听释义</div>
                            <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 4px;">写单词</div>
                        </button>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <div style="font-weight: 600; font-size: 0.92rem; color: #334155; margin-bottom: 10px;">单词播放次数</div>
                        <div style="display: flex; gap: 10px;" data-role="repeat-group">
                            <button type="button" class="btn btn-outline dict-chip-btn" data-repeat="1" style="flex: 1; border-radius: 12px;">1次</button>
                            <button type="button" class="btn btn-primary dict-chip-btn is-selected" data-repeat="2" style="flex: 1; border-radius: 12px; background: #ea580c; border-color: #ea580c;">2次</button>
                            <button type="button" class="btn btn-outline dict-chip-btn" data-repeat="3" style="flex: 1; border-radius: 12px;">3次</button>
                        </div>
                    </div>

                    <div style="margin-bottom: 24px;">
                        <div style="font-weight: 600; font-size: 0.92rem; color: #334155; margin-bottom: 10px;">单词播放间隔</div>
                        <div style="display: flex; gap: 10px;" data-role="interval-group">
                            <button type="button" class="btn btn-outline dict-chip-btn" data-interval="2" style="flex: 1; border-radius: 12px;">2秒</button>
                            <button type="button" class="btn btn-primary dict-chip-btn is-selected" data-interval="4" style="flex: 1; border-radius: 12px; background: #ea580c; border-color: #ea580c;">4秒</button>
                            <button type="button" class="btn btn-outline dict-chip-btn" data-interval="6" style="flex: 1; border-radius: 12px;">6秒</button>
                            <button type="button" class="btn btn-outline dict-chip-btn" data-interval="8" style="flex: 1; border-radius: 12px;">8秒</button>
                        </div>
                    </div>

                    <button type="button" class="btn btn-primary" data-action="start-dictation" style="width: 100%; padding: 14px; border-radius: 16px; font-weight: 700; font-size: 1.05rem; background: #ea580c; border-color: #ea580c; box-shadow: 0 4px 16px rgba(234, 88, 12, 0.3);">
                        准备好纸笔，开始听写 (${words.length}词)
                    </button>
                </div>
            </div>
        `;

        let dictMode = 'pron';
        let repeatTimes = 2;
        let intervalSeconds = 4;

        modal.addEventListener('click', (e) => {
            const trigger = e.target.closest('button');
            if (!trigger) return;

            if (trigger.dataset.action === 'close-dict-modal') {
                modal.remove();
            } else if (trigger.dataset.dictMode) {
                dictMode = trigger.dataset.dictMode;
                modal.querySelectorAll('.dict-mode-btn').forEach((b) => {
                    const active = b.dataset.dictMode === dictMode;
                    b.style.borderColor = active ? '#ea580c' : '#e2e8f0';
                    b.style.background = active ? 'rgba(234, 88, 12, 0.05)' : '#ffffff';
                    b.querySelector('div').style.color = active ? '#ea580c' : '#475569';
                });
            } else if (trigger.dataset.repeat) {
                repeatTimes = Number(trigger.dataset.repeat);
                modal.querySelectorAll('[data-repeat]').forEach((b) => {
                    const sel = Number(b.dataset.repeat) === repeatTimes;
                    b.className = sel ? 'btn btn-primary dict-chip-btn' : 'btn btn-outline dict-chip-btn';
                    b.style.background = sel ? '#ea580c' : '';
                    b.style.borderColor = sel ? '#ea580c' : '';
                });
            } else if (trigger.dataset.interval) {
                intervalSeconds = Number(trigger.dataset.interval);
                modal.querySelectorAll('[data-interval]').forEach((b) => {
                    const sel = Number(b.dataset.interval) === intervalSeconds;
                    b.className = sel ? 'btn btn-primary dict-chip-btn' : 'btn btn-outline dict-chip-btn';
                    b.style.background = sel ? '#ea580c' : '';
                    b.style.borderColor = sel ? '#ea580c' : '';
                });
            } else if (trigger.dataset.action === 'start-dictation') {
                modal.remove();
                runDictationSession({ words, dictMode, repeatTimes, intervalSeconds });
            }
        });

        document.body.appendChild(modal);
    }

    function runDictationSession({ words, dictMode, repeatTimes, intervalSeconds }) {
        let index = 0;
        let isPaused = false;
        let timer = null;

        const modal = document.createElement('div');
        modal.className = 'vocab-tool-modal';
        modal.innerHTML = `
            <div class="vocab-tool-dialog" style="max-width: 540px; text-align: center;">
                <div class="vocab-tool-header">
                    <span style="font-weight: 700; color: #ea580c;">听写中</span>
                    <button type="button" class="vocab-tool-close-btn" data-action="stop-dictation">✕</button>
                </div>
                <div class="vocab-tool-content" style="padding: 40px 24px;">
                    <div style="font-size: 1.1rem; color: #64748b; font-weight: 600; margin-bottom: 20px;" data-field="dict-index">第 1 / ${words.length} 词</div>
                    <div style="width: 100px; height: 100px; border-radius: 50%; background: rgba(234, 88, 12, 0.1); color: #ea580c; font-size: 2.5rem; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;" data-field="dict-pulse">
                        🔊
                    </div>
                    <div style="font-size: 1.4rem; font-weight: 700; color: #0f172a; margin-bottom: 8px; min-height: 36px;" data-field="dict-prompt">正在播报…</div>
                    <div style="font-size: 0.95rem; color: #94a3b8; margin-bottom: 28px;">请在纸上快速写下对应英文单词</div>
                    <button type="button" class="btn btn-outline" data-action="reveal-answer" style="border-radius: 999px; padding: 6px 18px; font-size: 0.88rem;">👁️ 偷看答案</button>
                    <div data-field="dict-answer" style="display: none; margin-top: 16px; font-size: 1.2rem; font-weight: 700; color: #ea580c;"></div>
                </div>
                <div class="immersive-nav-bar">
                    <button type="button" class="btn btn-outline" data-action="replay-word" style="border-radius: 999px;">🔁 重放</button>
                    <button type="button" class="btn btn-outline" data-action="pause-resume" style="border-radius: 999px;">⏸ 暂停</button>
                    <button type="button" class="btn btn-primary" data-action="next-dict-word" style="border-radius: 999px; background: #ea580c; border-color: #ea580c;">下一个 →</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        function playWord(timesLeft = repeatTimes) {
            if (index >= words.length) {
                showFeedbackMessage('🎉 听写全部完成！', 'success');
                modal.remove();
                return;
            }
            const w = words[index];
            modal.querySelector('[data-field="dict-index"]').textContent = `第 ${index + 1} / ${words.length} 词`;
            modal.querySelector('[data-field="dict-answer"]').style.display = 'none';
            modal.querySelector('[data-field="dict-answer"]').textContent = `${w.word} (${w.meaning})`;

            if (dictMode === 'meaning') {
                modal.querySelector('[data-field="dict-prompt"]').textContent = w.meaning || '释义播报';
                if ('speechSynthesis' in window) {
                    const u = new SpeechSynthesisUtterance(w.meaning);
                    u.lang = 'zh-CN';
                    window.speechSynthesis.speak(u);
                }
            } else {
                modal.querySelector('[data-field="dict-prompt"]').textContent = '请听发音…';
                playWordPronunciation(w);
            }

            if (timesLeft > 1) {
                timer = setTimeout(() => {
                    if (!isPaused) playWord(timesLeft - 1);
                }, 2000);
            } else {
                timer = setTimeout(() => {
                    if (!isPaused) {
                        index++;
                        playWord(repeatTimes);
                    }
                }, intervalSeconds * 1000);
            }
        }

        modal.addEventListener('click', (e) => {
            const trigger = e.target.closest('button');
            if (!trigger) return;
            const action = trigger.dataset.action;
            if (action === 'stop-dictation') {
                clearTimeout(timer);
                modal.remove();
            } else if (action === 'reveal-answer') {
                const ans = modal.querySelector('[data-field="dict-answer"]');
                ans.style.display = ans.style.display === 'none' ? 'block' : 'none';
            } else if (action === 'replay-word') {
                clearTimeout(timer);
                playWord(repeatTimes);
            } else if (action === 'pause-resume') {
                isPaused = !isPaused;
                trigger.textContent = isPaused ? '▶ 继续' : '⏸ 暂停';
                if (!isPaused) playWord(1);
            } else if (action === 'next-dict-word') {
                clearTimeout(timer);
                index++;
                playWord(repeatTimes);
            }
        });

        playWord(repeatTimes);
    }

    // 3. 随手拼
    function startQuickSpellingRunner(customWords = null) {
        const words = customWords && customWords.length ? customWords : getWordsByScope(state.selectedScope);
        if (!words.length) {
            showFeedbackMessage('当前选中的分类下暂无已学单词，请前往上方 Learning 学习新词！', 'info');
            return;
        }

        let currentIndex = 0;
        let hintChars = 0;

        const modal = document.createElement('div');
        modal.className = 'vocab-tool-modal';
        modal.innerHTML = `
            <div class="vocab-tool-dialog" style="max-width: 560px;">
                <div class="vocab-tool-header">
                    <span style="font-weight: 600; color: #64748b; font-size: 0.95rem;" data-field="spell-index">1 / ${words.length}</span>
                    <button type="button" class="vocab-tool-close-btn" data-action="close-spell">✕</button>
                </div>
                <div class="vocab-tool-content" style="padding: 36px 24px; text-align: center;">
                    <div style="font-size: 1.4rem; font-weight: 700; color: #1e293b; margin-bottom: 28px; line-height: 1.4;" data-field="spell-meaning">中文释义</div>
                    <div style="margin-bottom: 24px;">
                        <input type="text" class="quick-spell-input" placeholder="输入英文拼写…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-field="spell-input" />
                    </div>
                    <div style="min-height: 24px; font-size: 0.95rem; font-weight: 600; margin-bottom: 12px;" data-field="spell-feedback"></div>
                </div>
                <div class="immersive-nav-bar" style="justify-content: space-around;">
                    <button type="button" class="btn btn-outline" data-action="give-up" style="border-radius: 999px; padding: 8px 20px;">✕ 看答案</button>
                    <button type="button" class="btn btn-outline" data-action="give-hint" style="border-radius: 999px; padding: 8px 20px;">💡 提示</button>
                    <button type="button" class="btn btn-primary" data-action="submit-spell" style="border-radius: 999px; padding: 8px 28px; background: #ea580c; border-color: #ea580c;">✓ 确认</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        const inputEl = modal.querySelector('[data-field="spell-input"]');
        const feedbackEl = modal.querySelector('[data-field="spell-feedback"]');

        function updateWord() {
            const w = words[currentIndex];
            if (!w) return;
            hintChars = 0;
            modal.querySelector('[data-field="spell-index"]').textContent = `${currentIndex + 1} / ${words.length}`;
            modal.querySelector('[data-field="spell-meaning"]').textContent = w.meaning || '释义';
            inputEl.value = '';
            inputEl.style.borderColor = '#cbd5e1';
            feedbackEl.textContent = '';
            setTimeout(() => inputEl.focus(), 80);
        }

        function checkAnswer() {
            const w = words[currentIndex];
            const typed = inputEl.value.trim().toLowerCase();
            const target = String(w.word || '').trim().toLowerCase();
            if (typed === target) {
                feedbackEl.style.color = '#16a34a';
                feedbackEl.textContent = `🎉 正确！${w.word}`;
                playWordPronunciation(w);
                setTimeout(() => {
                    if (currentIndex < words.length - 1) {
                        currentIndex++;
                        updateWord();
                    } else {
                        showFeedbackMessage('🎉 随手拼全部通关！', 'success');
                        modal.remove();
                    }
                }, 800);
            } else {
                inputEl.style.borderColor = '#ef4444';
                feedbackEl.style.color = '#ef4444';
                feedbackEl.textContent = '拼写不符，再试一次或点击“💡 提示”';
            }
        }

        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') checkAnswer();
        });

        modal.addEventListener('click', (e) => {
            const trigger = e.target.closest('button');
            if (!trigger) return;
            const action = trigger.dataset.action;
            if (action === 'close-spell') {
                modal.remove();
            } else if (action === 'submit-spell') {
                checkAnswer();
            } else if (action === 'give-hint') {
                const target = String(words[currentIndex]?.word || '');
                hintChars = Math.min(hintChars + 1, target.length);
                inputEl.value = target.slice(0, hintChars);
                inputEl.focus();
            } else if (action === 'give-up') {
                const w = words[currentIndex];
                feedbackEl.style.color = '#ea580c';
                feedbackEl.textContent = `正确答案: ${w.word}`;
                inputEl.value = w.word;
                playWordPronunciation(w);
            }
        });

        updateWord();
    }

    // 4. 导出当前选定分类单词
    function exportCurrentScopeWords(customWords = null, customScope = null) {
        const words = customWords && customWords.length ? customWords : getWordsByScope(customScope || state.selectedScope);
        if (!words.length) {
            showFeedbackMessage('当前选中的分类下暂无已学单词，无可导出内容！', 'info');
            return;
        }

        const scopeNameMap = { all: '全部已学单词', reviewing: '复习中单词', mastered: '已掌握熟词' };
        const scopeTitle = scopeNameMap[customScope || state.selectedScope] || '已学单词';

        const printWin = window.open('', '_blank');
        if (!printWin) {
            showFeedbackMessage('浏览器拦截了导出窗口，请允许弹出窗口！', 'warning');
            return;
        }

        const rows = words.map((w, i) => `
            <tr>
                <td style="width: 40px; text-align: center; color: #94a3b8;">${i + 1}</td>
                <td style="font-weight: bold; width: 140px;">${w.word}</td>
                <td style="color: #64748b; font-family: monospace; width: 120px;">${w.phonetic ? `/${w.phonetic}/` : ''}</td>
                <td style="color: #334155;">${w.meaning || ''}</td>
                <td style="color: #64748b; font-style: italic;">${w.example || ''}</td>
            </tr>
        `).join('');

        printWin.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>IELTS 雅思词汇复习单 - ${scopeTitle}</title>
                <style>
                    body { font-family: system-ui, -apple-system, sans-serif; padding: 24px; color: #0f172a; }
                    h2 { margin: 0 0 8px; }
                    .meta { color: #64748b; font-size: 0.9rem; margin-bottom: 20px; }
                    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
                    th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 8px; text-align: left; }
                    th { background: #f8fafc; color: #475569; }
                    @media print { button { display: none; } }
                </style>
            </head>
            <body>
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div>
                        <h2>IELTS 雅思核心词库 · ${scopeTitle} (${words.length} 词)</h2>
                        <div class="meta">导出时间: ${new Date().toLocaleString()} · 雅思练习与背词系统</div>
                    </div>
                    <button onclick="window.print()" style="padding: 8px 18px; border-radius: 8px; background: #ea580c; color: #fff; border: none; font-weight: 600; cursor: pointer;">🖨️ 立即打印 / 存为 PDF</button>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>单词</th>
                            <th>音标</th>
                            <th>中文释义</th>
                            <th>例句</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </body>
            </html>
        `);
        printWin.document.close();
    }

    // 5. 核心：已学词单大厅 (对标图 1 原型：全词列表 + 点词即从该词开始刷 + 底部3大工具)
    function openWordlistView(initialScope = 'all') {
        let currentScope = initialScope;
        let hideMeanings = false;
        let searchQuery = '';

        document.querySelectorAll('.vocab-wordlist-shell').forEach((el) => el.remove());

        const shell = document.createElement('div');
        shell.className = 'vocab-wordlist-shell';
        shell.innerHTML = `
            <!-- 顶部导航栏 -->
            <div class="vocab-wordlist-topbar">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <button type="button" class="btn btn-icon btn-ghost" data-action="close-wordlist" style="font-size: 1.3rem; padding: 4px 8px;">←</button>
                    <h3 style="margin: 0; font-size: 1.15rem; font-weight: 700; color: #0f172a;" data-field="wordlist-title">已学词库</h3>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <button type="button" class="btn btn-icon btn-ghost" data-action="toggle-wordlist-eye" title="遮挡/显示释义自测" style="font-size: 1.25rem;">👁️</button>
                    <button type="button" class="btn btn-icon btn-ghost" data-action="wordlist-export" title="导出当前词表" style="font-size: 1.2rem;">📄</button>
                </div>
            </div>

            <!-- 顶部常驻分类胶囊标签 -->
            <div style="display: flex; justify-content: center; padding: 12px 16px 6px; background: #ffffff; border-bottom: 1px solid #f1f5f9;">
                <div class="vocab-scope-capsules" style="margin: 0;">
                    <button class="vocab-scope-capsule is-active" type="button" data-wordlist-scope="all">
                        <span>全部已学</span>
                        <span class="vocab-scope-capsule__count" data-wordlist-count="all">0</span>
                    </button>
                    <button class="vocab-scope-capsule" type="button" data-wordlist-scope="reviewing">
                        <span>复习中</span>
                        <span class="vocab-scope-capsule__count" data-wordlist-count="reviewing">0</span>
                    </button>
                    <button class="vocab-scope-capsule" type="button" data-wordlist-scope="mastered">
                        <span>已掌握</span>
                        <span class="vocab-scope-capsule__count" data-wordlist-count="mastered">0</span>
                    </button>
                </div>
            </div>

            <!-- 搜索框 -->
            <div class="vocab-wordlist-search-bar">
                <input type="search" placeholder="🔍 搜索单词、中文释义…" style="width: 100%; padding: 8px 16px; border-radius: 999px; border: 1px solid #e2e8f0; outline: none; font-size: 0.92rem;" data-field="wordlist-search" />
            </div>

            <!-- 单词列表主区域 -->
            <div class="vocab-wordlist-content" data-field="wordlist-container"></div>

            <!-- 悬浮在底部的 3 大胶囊工具 (沉浸刷词、听写、随手拼) -->
            <div class="vocab-wordlist-dock">
                <button class="vocab-dock__item" type="button" data-wordlist-action="immersive" title="沉浸刷词">
                    <span class="vocab-dock__icon">⚡</span>
                    <span class="vocab-dock__label">沉浸刷词</span>
                </button>
                <div class="vocab-dock__divider"></div>
                <button class="vocab-dock__item" type="button" data-wordlist-action="dictation" title="听写模式">
                    <span class="vocab-dock__icon">✍️</span>
                    <span class="vocab-dock__label">听写</span>
                </button>
                <button class="vocab-dock__item" type="button" data-wordlist-action="quick-spell" title="随手拼">
                    <span class="vocab-dock__icon">🔤</span>
                    <span class="vocab-dock__label">随手拼</span>
                </button>
            </div>
        `;

        document.body.appendChild(shell);

        const listContainer = shell.querySelector('[data-field="wordlist-container"]');
        const searchInput = shell.querySelector('[data-field="wordlist-search"]');

        function updateCounts() {
            const allWords = getWordsByScope('all');
            const revWords = getWordsByScope('reviewing');
            const masWords = getWordsByScope('mastered');

            const allCountEl = shell.querySelector('[data-wordlist-count="all"]');
            if (allCountEl) allCountEl.textContent = allWords.length;

            const revCountEl = shell.querySelector('[data-wordlist-count="reviewing"]');
            if (revCountEl) revCountEl.textContent = revWords.length;

            const masCountEl = shell.querySelector('[data-wordlist-count="mastered"]');
            if (masCountEl) masCountEl.textContent = masWords.length;
        }

        function getCurrentFilteredWords() {
            const scopeWords = getWordsByScope(currentScope);
            if (!searchQuery) return scopeWords;
            return scopeWords.filter(
                (w) =>
                    (w.word || '').toLowerCase().includes(searchQuery) ||
                    (w.meaning || '').toLowerCase().includes(searchQuery)
            );
        }

        function renderList() {
            updateCounts();
            const words = getCurrentFilteredWords();

            if (!words.length) {
                listContainer.innerHTML = `
                    <div style="text-align: center; color: #94a3b8; padding: 60px 20px;">
                        <div style="font-size: 2.5rem; margin-bottom: 12px;">📭</div>
                        <p style="font-size: 1rem; margin: 0;">当前分类下暂无单词</p>
                    </div>
                `;
                return;
            }

            // 按日期或分组构建列表
            const groups = {};
            words.forEach((w, index) => {
                const dateKey = formatWordDate(w);
                if (!groups[dateKey]) groups[dateKey] = [];
                groups[dateKey].push({ word: w, globalIndex: index });
            });

            let html = '';
            for (const [dateLabel, groupItems] of Object.entries(groups)) {
                html += `
                    <div style="margin-bottom: 22px;">
                        <div style="font-size: 0.88rem; font-weight: 600; color: #94a3b8; margin-bottom: 8px; padding-left: 4px; display: flex; justify-content: space-between;">
                            <span>${dateLabel}</span>
                            <span>${groupItems.length} 词</span>
                        </div>
                        <div style="background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.02);">
                            ${groupItems
                                .map(
                                    ({ word: w, globalIndex }) => `
                                <div class="vocab-wordlist-row" data-action="click-word-row" data-word-index="${globalIndex}">
                                    <div>
                                        <div style="display: flex; align-items: baseline; gap: 8px;">
                                            <span style="font-weight: 700; color: #0f172a; font-size: 1.05rem;">${w.word}</span>
                                            <span style="font-family: monospace; color: #64748b; font-size: 0.85rem;">${w.phonetic ? `/${w.phonetic}/` : ''}</span>
                                        </div>
                                        <div style="font-size: 0.88rem; color: #475569; margin-top: 3px; ${hideMeanings ? 'filter: blur(6px); user-select: none;' : ''}">${w.meaning || ''}</div>
                                    </div>
                                    <div style="display: flex; align-items: center; gap: 6px;">
                                        <button type="button" class="btn btn-icon btn-ghost" data-action="play-row-audio" data-word="${w.word}" title="发音" style="color: #64748b; font-size: 1.1rem;">🔊</button>
                                    </div>
                                </div>
                            `
                                )
                                .join('')}
                        </div>
                    </div>
                `;
            }

            listContainer.innerHTML = html;
        }

        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim().toLowerCase();
            renderList();
        });

        shell.addEventListener('click', (e) => {
            const trigger = e.target.closest('[data-action], [data-wordlist-scope], [data-wordlist-action]');
            if (!trigger) return;

            // 1. 分类胶囊切换
            if (trigger.dataset.wordlistScope) {
                currentScope = trigger.dataset.wordlistScope;
                shell.querySelectorAll('[data-wordlist-scope]').forEach((btn) => {
                    btn.classList.toggle('is-active', btn.dataset.wordlistScope === currentScope);
                });
                renderList();
                return;
            }

            // 2. 顶部操作
            const action = trigger.dataset.action;
            if (action === 'close-wordlist') {
                shell.remove();
                updateModeCounts();
                return;
            }
            if (action === 'toggle-wordlist-eye') {
                hideMeanings = !hideMeanings;
                trigger.textContent = hideMeanings ? '🙈' : '👁️';
                renderList();
                return;
            }
            if (action === 'wordlist-export') {
                exportCurrentScopeWords(getCurrentFilteredWords(), currentScope);
                return;
            }
            if (action === 'play-row-audio') {
                e.stopPropagation();
                playWordPronunciation({ word: trigger.dataset.word });
                return;
            }

            // 3. 【核心亮点】点哪个单词，就直接从哪个单词开始刷词！
            if (action === 'click-word-row') {
                const clickedIndex = Number(trigger.dataset.wordIndex);
                startImmersiveRunner(getCurrentFilteredWords(), clickedIndex, currentScope);
                return;
            }

            // 4. 底部 3 大悬浮工具操作
            const wordlistAction = trigger.dataset.wordlistAction;
            if (wordlistAction === 'immersive') {
                // 默认续刷上次断点位置
                startImmersiveRunner(getCurrentFilteredWords(), -1, currentScope);
            } else if (wordlistAction === 'dictation') {
                openDictationModal(getCurrentFilteredWords());
            } else if (wordlistAction === 'quick-spell') {
                startQuickSpellingRunner(getCurrentFilteredWords());
            }
        });

        renderList();
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
                    <p class="vocab-card__empty-text">词库已背完或今日无待复习词汇。</p>
                    <div class="vocab-card__actions vocab-card__actions--stack">
                        <button class="btn btn-primary" type="button" data-action="return-mode-dash">返回背单词大厅</button>
                    </div>
                </div>
            `;
            return;
        }
        if (session.stage === 'batch-spelling') {
            renderBatchSpellingCard(card, session);
            return;
        }
        if (session.stage === 'batch-summary') {
            renderBatchSummaryCard(card, session);
            return;
        }
        if (session.stage === 'complete') {
            card.innerHTML = `
                <div class="vocab-batch-complete-card">
                    <div style="font-size: 3rem; margin-bottom: 12px;">🎉</div>
                    <h2 style="font-size: 1.6rem; font-weight: 800; color: #0f172a; margin: 0 0 8px;">今日任务全面完成！</h2>
                    <p style="color: #64748b; font-size: 0.95rem; margin-bottom: 24px;">太棒了！所有单词任务均已搞定，坚持就是胜利！</p>
                    <div style="display: flex; justify-content: center; gap: 12px;">
                        <button type="button" class="btn btn-primary" data-action="return-mode-dash" style="background: #ea580c; border-radius: 12px; padding: 10px 24px;">返回大厅</button>
                    </div>
                </div>
            `;
            return;
        }

        // 默认双关穿插认词卡片
        renderTwoPassCard(card, session);
    }

    function renderTwoPassCard(card, session) {
        const item = session.currentWordItem;
        const word = normalizeWord(item?.word || session.currentWord);
        if (!word) {
            card.innerHTML = `
                <div class="vocab-card vocab-card--placeholder">
                    <p>准备下一条词汇…</p>
                </div>
            `;
            return;
        }

        const passStage = item?.passStage || 0; // 0: 初始, 1: 盲测, 2: 通关
        const isPhase2 = passStage === 1;
        const subStage = session.subStage || 'testing';

        const dot1 = passStage >= 1 ? 'is-done' : '';
        const dot2 = passStage >= 2 ? 'is-done' : '';

        const safeWord = escapeHtml(word.word);
        const phonetic = normalizePhoneticValue(word.phonetic);
        const safeMeaning = escapeHtml(word.meaning || '暂无释义');
        const safeExample = escapeHtml(word.example || '');
        const safeExampleCn = escapeHtml(word.exampleCn || '');

        let exampleEnHtml = safeExample;
        if (safeExample && word.word) {
            try {
                const regex = new RegExp(`\\b(${word.word}[a-z]*)\\b`, 'gi');
                exampleEnHtml = safeExample.replace(regex, '<strong>$1</strong>');
            } catch (_) {}
        }

        const completedCount = session.completedWords?.length || 0;
        const totalCount = session.batchTotal || (completedCount + (session.activeQueue?.length || 0) + 1);

        let bodyContentHtml = '';
        let actionsHtml = '';

        if (subStage === 'testing') {
            if (isPhase2) {
                // 第二关盲测
                bodyContentHtml = `
                    <div class="vocab-blind-banner">本词最后一关：请在无提示的情况下凭直觉判断</div>
                    <div class="vocab-masked-strip" style="cursor: default;">
                        <span>最后一关盲测中（释义与例句已隐藏）</span>
                    </div>
                `;
                actionsHtml = `
                    <div class="vocab-action-grid-2">
                        <button type="button" class="vocab-flow-btn vocab-flow-btn--green" data-action="action-p2-know">
                            <span>认识</span>
                        </button>
                        <button type="button" class="vocab-flow-btn vocab-flow-btn--red" data-action="action-p2-unknown">
                            <span>不认识</span>
                        </button>
                    </div>
                `;
            } else {
                // 第一关初见
                bodyContentHtml = `
                    <div class="vocab-masked-strip" data-action="action-hint" title="点击展开释义">
                        <span>释义已遮挡 · 尝试凭直觉回忆（点击或下方选择）</span>
                    </div>
                    ${safeExample ? `
                        <div class="vocab-revealed-panel" style="padding: 12px 18px; margin-top: 4px;">
                            <div style="font-size: 0.85rem; color: #94a3b8; font-weight: 600; margin-bottom: 4px;">例句参考：</div>
                            <div class="vocab-revealed-example" style="border: none; padding: 0;">${exampleEnHtml}</div>
                        </div>
                    ` : ''}
                `;
                actionsHtml = `
                    <div class="vocab-action-grid-3">
                        <button type="button" class="vocab-flow-btn vocab-flow-btn--green" data-action="action-know">
                            <span>认识</span>
                        </button>
                        <button type="button" class="vocab-flow-btn vocab-flow-btn--yellow" data-action="action-hint">
                            <span>模糊</span>
                        </button>
                        <button type="button" class="vocab-flow-btn vocab-flow-btn--red" data-action="action-unknown">
                            <span>不认识</span>
                        </button>
                    </div>
                `;
            }
        } else if (subStage === 'hint-revealed') {
            bodyContentHtml = `
                <div class="vocab-revealed-panel">
                    <div class="vocab-revealed-def">${safeMeaning}</div>
                    ${safeExample ? `
                        <div class="vocab-revealed-example">
                            <div>${exampleEnHtml}</div>
                            ${safeExampleCn ? `<div class="vocab-revealed-example-cn">${safeExampleCn}</div>` : ''}
                        </div>
                    ` : ''}
                </div>
            `;
            actionsHtml = `
                <div class="vocab-action-grid-2">
                    <button type="button" class="vocab-flow-btn vocab-flow-btn--red" data-action="action-hint-wrong">
                        <span>记错了</span>
                    </button>
                    <button type="button" class="vocab-flow-btn vocab-flow-btn--green" data-action="action-hint-correct">
                        <span>记对了</span>
                    </button>
                </div>
            `;
        } else if (subStage === 'detail-review') {
            bodyContentHtml = `
                <div class="vocab-revealed-panel">
                    <div class="vocab-revealed-def">${safeMeaning}</div>
                    ${safeExample ? `
                        <div class="vocab-revealed-example">
                            <div>${exampleEnHtml}</div>
                            ${safeExampleCn ? `<div class="vocab-revealed-example-cn">${safeExampleCn}</div>` : ''}
                        </div>
                    ` : ''}
                </div>
            `;
            actionsHtml = `
                <div style="text-align: center; margin-top: 14px;">
                    <button type="button" class="btn btn-primary" data-action="action-detail-next" style="padding: 12px 36px; border-radius: 12px; font-size: 1.05rem; background: #ea580c;">
                        下一个单词 →
                    </button>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="vocab-card vocab-card--recognition">
                <div class="vocab-card__utility-row">
                    <button class="btn btn-ghost btn-sm" type="button" data-action="return-mode-dash" style="padding: 4px 10px; border-radius: 8px;">
                        ‹ 返回大厅
                    </button>
                    <div class="vocab-card__step">
                        ${isPhase2 ? '本词最后一关 · 盲测' : '第一关 · 认知学习'} · 词 ${completedCount + 1} / ${totalCount}
                    </div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button class="vocab-card__familiar ${word.familiar ? 'is-familiar' : ''}" type="button" data-action="mark-familiar" title="已经完全掌握，直接通关并标熟">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.9L12 3.5Z"></path></svg>
                            <span>${word.familiar ? '已标熟' : '标为熟词'}</span>
                        </button>
                    </div>
                </div>

                <div class="vocab-twopass-wordline">
                    <div class="vocab-twopass-word-row">
                        <h2 class="vocab-twopass-word">${safeWord}</h2>
                        <span class="vocab-phase-dots" title="通关进度：需通过两关">
                            <span class="vocab-phase-dot ${dot1}"></span>
                            <span class="vocab-phase-dot ${dot2}"></span>
                        </span>
                    </div>
                    <div class="vocab-card__pronunciation">
                        <button class="vocab-card__pronounce" type="button" data-action="play-pronounce">
                            <span class="vocab-card__pronounce-icon">🔊</span>
                            <span class="vocab-card__pronounce-label">真人英音 ${phonetic ? `/${phonetic}/` : ''}</span>
                        </button>
                        <button class="vocab-card__pronounce" type="button" data-action="open-dict-drawer" style="margin-left: 8px;">
                            <span class="vocab-card__pronounce-icon">📖</span>
                            <span class="vocab-card__pronounce-label">权威词典</span>
                        </button>
                    </div>
                </div>

                ${bodyContentHtml}
                ${actionsHtml}
            </div>
        `;
    }

    function renderBatchSpellingCard(card, session) {
        const words = session.spellingWords || [];
        const index = session.spellingIndex || 0;
        const currentWord = words[index] ? normalizeWord(words[index]) : null;
        if (!currentWord) {
            finishBatchSession();
            return;
        }

        const safeMeaning = escapeHtml(currentWord.meaning || '暂无释义');

        card.innerHTML = `
            <div class="vocab-card vocab-card--spelling">
                <div class="vocab-card__utility-row">
                    <button class="btn btn-ghost btn-sm" type="button" data-action="return-mode-dash">‹ 返回大厅</button>
                    <div class="vocab-card__step">✍️ 组末拼写巩固 · 第 ${index + 1} / ${words.length} 词</div>
                    <button class="vocab-card__pronounce" type="button" data-action="open-dict-drawer">📖 词典</button>
                </div>

                <div class="vocab-batch-spell-box">
                    <div style="font-size: 0.95rem; color: #64748b; font-weight: 600;">根据中文释义拼写英文单词：</div>
                    <div class="vocab-batch-spell-def">${safeMeaning}</div>

                    <div>
                        <input type="text" class="vocab-batch-spell-input" placeholder="在此输入英文拼写…" autocomplete="off" spellcheck="false" data-field="batch-spell-input" value="${escapeHtml(session.spellingInput || '')}" autofocus />
                    </div>

                    <div class="vocab-batch-spell-msg" data-field="batch-spell-feedback">${session.spellingFeedback || ''}</div>

                    <div style="display: flex; justify-content: center; gap: 14px; margin-top: 16px;">
                        <button type="button" class="btn btn-soft" data-action="spelling-hint" style="border-radius: 999px; padding: 10px 20px;">💡 首字母提示</button>
                        <button type="button" class="btn btn-ghost" data-action="spelling-skip" style="border-radius: 999px; padding: 10px 20px;">看答案</button>
                        <button type="button" class="btn btn-primary" data-action="spelling-submit" style="border-radius: 999px; padding: 10px 28px; background: #ea580c;">确认 (Enter)</button>
                    </div>
                </div>
            </div>
        `;

        const input = card.querySelector('[data-field="batch-spell-input"]');
        if (input) {
            input.focus();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    checkBatchSpelling();
                }
            });
            input.addEventListener('input', (e) => {
                session.spellingInput = e.target.value;
            });
        }
    }

    function renderBatchSummaryCard(card, session) {
        const words = (session.spellingWords || []).map(w => normalizeWord(w)).filter(Boolean);
        card.innerHTML = `
            <div class="vocab-card vocab-card--summary" style="text-align: center; padding: 36px 28px;">
                <div style="font-size: 3rem; margin-bottom: 8px;">🎉</div>
                <h2 style="font-size: 1.7rem; font-weight: 800; color: #0f172a; margin: 0 0 8px;">本组 ${words.length} 词全面通关！</h2>
                <p style="color: #64748b; font-size: 0.98rem; margin-bottom: 24px;">你已完成两关穿插认知与集中拼写，已正式记入今日已学词库！</p>

                <div style="max-height: 240px; overflow-y: auto; text-align: left; padding: 14px 18px; background: rgba(255, 255, 255, 0.8); border-radius: 14px; margin-bottom: 28px; border: 1px solid #e2e8f0;">
                    ${words.map((w, i) => `
                        <div style="display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 0.95rem;">
                            <span style="font-weight: 700; color: #0f172a;">${i + 1}. ${escapeHtml(w.word)} <span style="font-weight: normal; color: #64748b; font-size: 0.85rem;">/${escapeHtml(w.phonetic)}/</span></span>
                            <span style="color: #475569; font-size: 0.88rem; max-width: 55%; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(w.meaning || '')}</span>
                        </div>
                    `).join('')}
                </div>

                <div style="display: flex; justify-content: center; gap: 14px;">
                    <button type="button" class="btn btn-primary" data-action="start-next-batch" style="padding: 12px 28px; font-weight: 700; font-size: 1.05rem; background: #ea580c; border-radius: 12px;">👉 学习下一组 (${session.batchSize || 10} 词)</button>
                    <button type="button" class="btn btn-outline" data-action="return-mode-dash" style="padding: 12px 24px; font-weight: 600; border-radius: 12px;">🏠 返回背单词大厅</button>
                </div>
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

    function updateModeCounts() {
        if (!state.store) return;
        const stats = computeStats();
        const newTotal = stats?.newCandidateCount || 0;
        const dueTotal = stats?.dueCount || 0;

        const learnEl = state.container?.querySelector('[data-vocab-role="learn-count"]');
        if (learnEl) learnEl.textContent = newTotal;

        const reviewEl = state.container?.querySelector('[data-vocab-role="review-count"]');
        if (reviewEl) reviewEl.textContent = dueTotal;

        // 更新三个胶囊标签计数
        const allWords = state.store.getWords ? state.store.getWords() : [];
        const config = typeof state.store.getConfig === 'function' ? state.store.getConfig() : {};
        const masteryTarget = Number(config.masteryCount || 4);
        const learned = allWords.filter((w) => isLearnedWord(w));
        const mastered = learned.filter((w) => w.familiar === true || Number(w.correctCount || 0) >= masteryTarget);
        const reviewing = learned.filter((w) => !(w.familiar === true || Number(w.correctCount || 0) >= masteryTarget));

        const allScopeEl = state.container?.querySelector('[data-scope-count="all"]');
        if (allScopeEl) allScopeEl.textContent = learned.length;

        const reviewingScopeEl = state.container?.querySelector('[data-scope-count="reviewing"]');
        if (reviewingScopeEl) reviewingScopeEl.textContent = reviewing.length;

        const masteredScopeEl = state.container?.querySelector('[data-scope-count="mastered"]');
        if (masteredScopeEl) masteredScopeEl.textContent = mastered.length;

        const totalLearnedEl = state.container?.querySelector('[data-vocab-role="total-learned-count"]');
        if (totalLearnedEl) totalLearnedEl.textContent = learned.length;

        const checkpoint = loadSessionCheckpoint();
        const learnBtnLabel = state.container?.querySelector('[data-vocab-role="learn-btn-label"]');
        const reviewBtnLabel = state.container?.querySelector('[data-vocab-role="review-btn-label"]');

        if (learnBtnLabel) {
            if (checkpoint && checkpoint.mode === 'learn' && checkpoint.progress) {
                learnBtnLabel.textContent = `继续学习 (${checkpoint.progress.completed}/${checkpoint.progress.total})`;
            } else {
                learnBtnLabel.textContent = '开始学习';
            }
        }
        if (reviewBtnLabel) {
            if (checkpoint && checkpoint.mode === 'review' && checkpoint.progress) {
                reviewBtnLabel.textContent = `继续复习 (${checkpoint.progress.completed}/${checkpoint.progress.total})`;
            } else {
                reviewBtnLabel.textContent = '开始复习';
            }
        }

        // 同步最顶部的本轮进度与进度条
        updateProgressStats();

        // 严格保证：若当前在模式选择首页仪表盘，会话进度条必须隐藏！
        const modeDash = state.container?.querySelector('[data-vocab-role="mode-dashboard"]');
        const topProgress = state.container?.querySelector('[data-vocab-role="progress"]');
        if (modeDash && !modeDash.hasAttribute('hidden')) {
            if (topProgress) topProgress.setAttribute('hidden', 'hidden');
        }
    }

    function startSelectedMode(mode) {
        const preferNew = mode === 'learn';
        const checkpoint = loadSessionCheckpoint();
        const mainBody = state.container?.querySelector('[data-vocab-role="main"]');
        const modeDash = state.container?.querySelector('[data-vocab-role="mode-dashboard"]');
        const topProgress = state.container?.querySelector('[data-vocab-role="progress"]');

        state.session.currentMode = mode;
        sessionActiveStartTime = Date.now();

        if (mode === 'review') {
            const dueWords = state.store?.getDueWords ? state.store.getDueWords() : [];
            const hasReviewCheckpoint = checkpoint && checkpoint.mode === 'review' && checkpoint.currentWord;
            if (!hasReviewCheckpoint && (!dueWords || dueWords.length === 0)) {
                showFeedbackMessage('🎉 太棒了！今日到期的待复习单词为 0，建议前往 Learning 学习新词，或使用下方工具刷词温故。', 'info');
                return;
            }
        }

        if (checkpoint && (!checkpoint.mode || checkpoint.mode === mode)) {
            try {
                Object.assign(state.session, checkpoint);
                // 确保所有词汇和队列数据全部被 normalizeWord 彻底规范化！
                if (state.session.currentWordItem) {
                    const nw = normalizeWord(state.session.currentWordItem.word || state.session.currentWordItem);
                    state.session.currentWordItem = { word: nw, passStage: state.session.currentWordItem.passStage || 0 };
                    state.session.currentWord = nw;
                } else if (state.session.currentWord) {
                    const nw = normalizeWord(state.session.currentWord);
                    state.session.currentWord = nw;
                    state.session.currentWordItem = { word: nw, passStage: 0 };
                } else if (state.session.activeQueue?.length) {
                    const first = state.session.activeQueue.shift();
                    const nw = normalizeWord(first.word || first);
                    state.session.currentWordItem = { word: nw, passStage: first.passStage || 0 };
                    state.session.currentWord = nw;
                }

                if (Array.isArray(state.session.activeQueue)) {
                    state.session.activeQueue = state.session.activeQueue.map(item => ({
                        word: normalizeWord(item.word || item),
                        passStage: Number(item.passStage) || 0
                    })).filter(it => it.word && it.word.word);
                }

                if (Array.isArray(state.session.completedWords)) {
                    state.session.completedWords = state.session.completedWords.map(w => normalizeWord(w)).filter(Boolean);
                }

                if (Array.isArray(state.session.spellingWords)) {
                    state.session.spellingWords = state.session.spellingWords.map(w => normalizeWord(w)).filter(Boolean);
                }

                if ((state.session.currentWord && state.session.currentWord.word) || state.session.stage === 'batch-spelling' || state.session.stage === 'batch-summary') {
                    state.session.subStage = 'testing';
                    state.session.meaningVisible = false;

                    if (modeDash) modeDash.setAttribute('hidden', 'hidden');
                    if (mainBody) mainBody.removeAttribute('hidden');
                    if (topProgress) topProgress.setAttribute('hidden', 'hidden');
                    render();
                    return;
                }
            } catch (err) {
                console.warn('[Vocab] Checkpoint corrupt, resetting:', err);
                clearSessionCheckpoint();
            }
        }

        // 开启新轮次
        clearSessionCheckpoint();
        if (modeDash) modeDash.setAttribute('hidden', 'hidden');
        if (mainBody) mainBody.removeAttribute('hidden');
        if (topProgress) topProgress.setAttribute('hidden', 'hidden');
        startReviewFlow({ preferNew });
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
        updateModeCounts();

        // 默认显示模式选择首页仪表盘，隐藏顶部进度条
        const mainBody = state.container?.querySelector('[data-vocab-role="main"]');
        const modeDash = state.container?.querySelector('[data-vocab-role="mode-dashboard"]');
        const topProgress = state.container?.querySelector('[data-vocab-role="progress"]');
        if (mainBody) mainBody.setAttribute('hidden', 'hidden');
        if (modeDash) modeDash.removeAttribute('hidden');
        if (topProgress) topProgress.setAttribute('hidden', 'hidden');
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
