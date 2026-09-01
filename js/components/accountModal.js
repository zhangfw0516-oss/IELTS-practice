/**
 * IELTS Atlas - Account & Cloud Sync Modal Component
 * 负责渲染多端账号登录/注册/同步控制面板，以及顶部状态徽标组件。
 */
(function(window) {
    'use strict';

    let currentTab = 'login'; // 'login' | 'register' | 'config'
    let overlayEl = null;
    let badgeEl = null;

    function formatTimeAgo(timestamp) {
        if (!timestamp) return '尚未同步';
        const diff = Date.now() - timestamp;
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60) return '刚刚';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} 分钟前`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} 小时前`;
        const d = new Date(timestamp);
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    const AccountModal = {
        init() {
            this.createBadge();
            this.createModal();
            this.bindEvents();

            if (window.CloudSyncService) {
                window.CloudSyncService.subscribe((state) => {
                    this.updateBadge(state);
                    if (this.isOpen()) {
                        this.renderModalBody(state);
                    }
                });
            }
        },

        createBadge() {
            if (document.getElementById('hero-account-badge')) return;

            badgeEl = document.createElement('button');
            badgeEl.id = 'hero-account-badge';
            badgeEl.className = 'hero-account-badge';
            badgeEl.type = 'button';
            badgeEl.setAttribute('aria-label', '多端账号与云同步');
            badgeEl.innerHTML = `
                <span class="account-status-dot"></span>
                <span class="account-badge-text">☁️ 云同步</span>
            `;

            badgeEl.addEventListener('click', () => {
                this.open();
            });

            // 挂载到顶部标题行右侧
            const headerActions = document.querySelector('.hero-brand-title') || document.querySelector('.hero-header');
            if (headerActions) {
                headerActions.appendChild(badgeEl);
            }
        },

        updateBadge(state) {
            if (!badgeEl) return;
            const dot = badgeEl.querySelector('.account-status-dot');
            const text = badgeEl.querySelector('.account-badge-text');

            dot.className = 'account-status-dot';

            if (!state.isConfigured) {
                text.textContent = '☁️ 配置云同步';
                return;
            }

            if (!state.currentUser) {
                text.textContent = '👤 登录同步';
                return;
            }

            // 已登录状态
            const shortEmail = state.currentUser.email.split('@')[0];
            if (state.status === 'syncing') {
                dot.classList.add('status-syncing');
                text.textContent = '🔄 正在同步...';
            } else if (state.status === 'error') {
                dot.classList.add('status-error');
                text.textContent = `⚠️ 同步异常 · ${shortEmail}`;
            } else {
                dot.classList.add('status-synced');
                text.textContent = `🟢 ${shortEmail}`;
            }
        },

        createModal() {
            if (document.getElementById('account-sync-modal-overlay')) return;

            overlayEl = document.createElement('div');
            overlayEl.id = 'account-sync-modal-overlay';
            overlayEl.className = 'account-modal-overlay';
            overlayEl.innerHTML = `
                <div class="account-modal-card">
                    <div class="account-modal-header">
                        <h3 class="account-modal-title">
                            <span>☁️</span> 多端账号与数据同步
                        </h3>
                        <button class="account-modal-close" aria-label="关闭">&times;</button>
                    </div>
                    <div class="account-modal-body" id="account-modal-body-content">
                        <!-- 动态内容渲染 -->
                    </div>
                </div>
            `;

            document.body.appendChild(overlayEl);

            overlayEl.querySelector('.account-modal-close').addEventListener('click', () => {
                this.close();
            });

            overlayEl.addEventListener('click', (e) => {
                if (e.target === overlayEl) this.close();
            });
        },

        bindEvents() {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isOpen()) {
                    this.close();
                }
            });
        },

        open() {
            if (!overlayEl) this.createModal();
            const serviceState = window.CloudSyncService ? window.CloudSyncService.getState() : { isConfigured: false, currentUser: null };
            this.renderModalBody(serviceState);
            overlayEl.classList.add('active');
        },

        close() {
            if (overlayEl) {
                overlayEl.classList.remove('active');
            }
        },

        isOpen() {
            return overlayEl && overlayEl.classList.contains('active');
        },

        renderModalBody(state) {
            const body = document.getElementById('account-modal-body-content');
            if (!body) return;

            if (state.currentUser) {
                this.renderProfileView(body, state);
                return;
            }

            this.renderAuthTabs(body, state);
        },

        renderAuthTabs(container, state) {
            if (currentTab !== 'login' && currentTab !== 'register') {
                currentTab = 'login';
            }

            container.innerHTML = `
                <div class="account-tabs">
                    <button class="account-tab-btn ${currentTab === 'login' ? 'active' : ''}" data-tab="login">邮箱登录</button>
                    <button class="account-tab-btn ${currentTab === 'register' ? 'active' : ''}" data-tab="register">免费注册</button>
                </div>

                ${state.errorMessage ? `
                    <div class="account-alert alert-error">
                        <span>⚠️</span>
                        <span>${state.errorMessage}</span>
                    </div>
                ` : ''}

                <div id="account-tab-content"></div>
            `;

            container.querySelectorAll('.account-tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    currentTab = btn.getAttribute('data-tab');
                    this.renderModalBody(state);
                });
            });

            const contentEl = container.querySelector('#account-tab-content');
            if (currentTab === 'login') {
                this.renderLoginForm(contentEl, state);
            } else if (currentTab === 'register') {
                this.renderRegisterForm(contentEl, state);
            }
        },

        renderLoginForm(container, state) {
            container.innerHTML = `
                <form id="account-login-form">
                    <div class="account-form-group">
                        <label class="account-form-label" for="login-email">注册邮箱</label>
                        <input class="account-form-input" type="email" id="login-email" placeholder="name@example.com" required autocomplete="email" />
                    </div>
                    <div class="account-form-group">
                        <label class="account-form-label" for="login-password">账号密码</label>
                        <input class="account-form-input" type="password" id="login-password" placeholder="请输入密码" required autocomplete="current-password" />
                    </div>
                    <button type="submit" class="account-btn account-btn-primary" ${state.status === 'syncing' ? 'disabled' : ''}>
                        ${state.status === 'syncing' ? '正在登录并同步...' : '登录并同步云端数据'}
                    </button>
                </form>
                <div class="account-help-note" style="margin-top: 16px;">
                    💡 登录后，背单词掌握度、生词本及做题记录将在电脑与手机端自动实时同步。
                </div>
            `;

            const form = container.querySelector('#account-login-form');
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = form.querySelector('#login-email').value;
                const pwd = form.querySelector('#login-password').value;
                try {
                    await window.CloudSyncService.login(email, pwd);
                } catch (err) {
                    console.warn('[AccountModal] Login failed:', err);
                }
            });
        },

        renderRegisterForm(container, state) {
            container.innerHTML = `
                <form id="account-register-form">
                    <div class="account-form-group">
                        <label class="account-form-label" for="reg-email">注册邮箱</label>
                        <input class="account-form-input" type="email" id="reg-email" placeholder="name@example.com" required autocomplete="email" />
                    </div>
                    <div class="account-form-group">
                        <label class="account-form-label" for="reg-password">设置密码 (至少 6 位)</label>
                        <input class="account-form-input" type="password" id="reg-password" placeholder="设置你的登录密码" minlength="6" required autocomplete="new-password" />
                    </div>
                    <button type="submit" class="account-btn account-btn-primary" ${state.status === 'syncing' ? 'disabled' : ''}>
                        ${state.status === 'syncing' ? '正在注册账号...' : '立即注册并开启云同步'}
                    </button>
                </form>
                <div class="account-help-note" style="margin-top: 16px;">
                    ✨ 注册成功后，当前浏览器里的做题记录和词汇进度将作为第一份云端存档安全保存。
                </div>
            `;

            const form = container.querySelector('#account-register-form');
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = form.querySelector('#reg-email').value;
                const pwd = form.querySelector('#reg-password').value;
                try {
                    await window.CloudSyncService.register(email, pwd);
                } catch (err) {
                    console.warn('[AccountModal] Register failed:', err);
                }
            });
        },

        renderProfileView(container, state) {
            const user = state.currentUser;
            const initial = user.email ? user.email.charAt(0).toUpperCase() : 'U';

            container.innerHTML = `
                <div class="account-profile-card">
                    <div class="account-user-banner">
                        <div class="account-avatar-circle">${initial}</div>
                        <div class="account-user-meta">
                            <div class="account-user-email" title="${user.email}">${user.email}</div>
                            <div class="account-sync-subtext">
                                <span>上次云端同步：</span>
                                <strong>${formatTimeAgo(state.lastSyncTime)}</strong>
                            </div>
                        </div>
                    </div>

                    ${state.errorMessage ? `
                        <div class="account-alert alert-error">
                            <span>⚠️</span>
                            <span>${state.errorMessage}</span>
                        </div>
                    ` : ''}

                    <div class="account-actions-grid" style="grid-template-columns: 1fr;">
                        <button type="button" class="account-btn account-btn-primary" id="btn-sync-push" style="padding: 14px; font-size: 1rem;" ${state.status === 'syncing' ? 'disabled' : ''}>
                            ${state.status === 'syncing' ? '🔄 正在同步云端数据...' : '☁️ 立即同步（上传当前进度）'}
                        </button>
                        <button type="button" class="account-btn account-btn-secondary" id="btn-sync-pull" style="padding: 11px;" ${state.status === 'syncing' ? 'disabled' : ''}>
                            ⬇️ 从云端还原数据
                        </button>
                    </div>

                    <div class="account-toggle-row" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: var(--bg-secondary, #f8fafc); border-radius: 12px; border: 1px solid var(--border-color, #e2e8f0); margin-top: 4px;">
                        <div>
                            <div style="font-weight: 600; font-size: 0.9rem;">自动后台同步</div>
                            <div style="font-size: 0.75rem; color: var(--text-muted, #64748b);">关闭后仅在点击「立即同步」时保存，极大节省调用次数</div>
                        </div>
                        <label class="account-switch" style="position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer;">
                            <input type="checkbox" id="auto-sync-checkbox" ${state.autoSyncEnabled ? 'checked' : ''} style="opacity: 0; width: 0; height: 0;">
                            <span class="account-slider" style="position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: ${state.autoSyncEnabled ? '#2563eb' : '#cbd5e1'}; transition: .3s; border-radius: 24px;"></span>
                        </label>
                    </div>

                    <button type="button" class="account-btn account-btn-danger" id="btn-account-logout" style="margin-top: 8px;">
                        退出当前登录
                    </button>
                </div>
            `;

            container.querySelector('#btn-sync-push').addEventListener('click', async () => {
                try {
                    await window.CloudSyncService.syncNow();
                } catch (e) {}
            });

            container.querySelector('#btn-sync-pull').addEventListener('click', async () => {
                if (confirm('确认从云端同步最新做题与单词记录到本地吗？（将智能合并两端数据）')) {
                    try {
                        await window.CloudSyncService.pullFromCloud();
                    } catch (e) {}
                }
            });

            const autoSyncCheckbox = container.querySelector('#auto-sync-checkbox');
            if (autoSyncCheckbox) {
                autoSyncCheckbox.addEventListener('change', (e) => {
                    window.CloudSyncService.setAutoSyncEnabled(e.target.checked);
                    const slider = container.querySelector('.account-slider');
                    if (slider) {
                        slider.style.backgroundColor = e.target.checked ? '#2563eb' : '#cbd5e1';
                    }
                });
            }

            container.querySelector('#btn-account-logout').addEventListener('click', async () => {
                await window.CloudSyncService.logout();
            });
        },

    };

    window.AccountModal = AccountModal;

    function boot() {
        if (window.CloudSyncService) {
            window.CloudSyncService.init();
        }
        AccountModal.init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
