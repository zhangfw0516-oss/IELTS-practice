/**
 * IELTS Atlas - Account & Cloud Sync Modal Component
 * 纯粹极简的用户名 + 密码登录与多端数据同步面板。
 */
(function(window) {
    'use strict';

    let currentMode = 'login'; // 'login' | 'register'
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
                <span class="account-badge-text">☁️ 登录 / 同步</span>
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

            if (!state.currentUser) {
                text.textContent = '☁️ 登录 / 同步';
                return;
            }

            // 已登录状态：优先显示纯用户名
            const username = state.currentUser.username || state.currentUser.displayName || '已登录';
            if (state.status === 'syncing') {
                dot.classList.add('status-syncing');
                text.textContent = `🔄 同步中... · ${username}`;
            } else if (state.status === 'error') {
                dot.classList.add('status-error');
                text.textContent = `⚠️ 同步异常 · ${username}`;
            } else {
                dot.classList.add('status-synced');
                text.textContent = `🟢 ${username}`;
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
                            <span>🔑</span> <span id="account-modal-header-text">多端同步账号</span>
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
            const serviceState = window.CloudSyncService ? window.CloudSyncService.getState() : { currentUser: null };
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
            const headerText = document.getElementById('account-modal-header-text');
            if (!body) return;

            if (state.currentUser) {
                if (headerText) headerText.textContent = '我的云端账号';
                this.renderProfileView(body, state);
                return;
            }

            if (headerText) headerText.textContent = currentMode === 'register' ? '免费注册账号' : '用户登录';
            this.renderAuthForm(body, state);
        },

        renderAuthForm(container, state) {
            const isRegister = currentMode === 'register';

            container.innerHTML = `
                ${state.errorMessage ? `
                    <div class="account-alert alert-error">
                        <span>⚠️</span>
                        <span>${state.errorMessage}</span>
                    </div>
                ` : ''}

                <form id="account-auth-form">
                    <div class="account-form-group">
                        <label class="account-form-label" for="auth-username">
                            ${isRegister ? '设置用户名' : '用户名'}
                        </label>
                        <input class="account-form-input" type="text" id="auth-username" placeholder="${isRegister ? '输入好记的用户名或昵称' : '请输入你的用户名'}" required autocomplete="username" />
                    </div>
                    <div class="account-form-group">
                        <label class="account-form-label" for="auth-password">
                            ${isRegister ? '设置密码' : '密码'}
                        </label>
                        <input class="account-form-input" type="password" id="auth-password" placeholder="${isRegister ? '设置密码' : '请输入密码'}" required autocomplete="${isRegister ? 'new-password' : 'current-password'}" />
                    </div>
                    <button type="submit" class="account-btn account-btn-primary" style="padding: 12px; font-size: 1rem; margin-top: 4px;" ${state.status === 'syncing' ? 'disabled' : ''}>
                        ${state.status === 'syncing' ? '🔄 正在处理中...' : (isRegister ? '注 册 并 开 启 同 步' : '登 录')}
                    </button>
                </form>

                <div style="text-align: center; margin-top: 16px;">
                    ${isRegister ? `
                        <button type="button" class="account-link-btn" id="btn-toggle-auth-mode" style="background: none; border: none; color: #2563eb; cursor: pointer; font-size: 0.88rem; text-decoration: underline;">
                            已有账号？点击直接登录
                        </button>
                    ` : `
                        <button type="button" class="account-link-btn" id="btn-toggle-auth-mode" style="background: none; border: none; color: #2563eb; cursor: pointer; font-size: 0.88rem; text-decoration: underline;">
                            还没有账号？点击免费注册
                        </button>
                    `}
                </div>

                <div class="account-help-note" style="margin-top: 16px;">
                    💡 登录后，背单词掌握度、错题本与做题记录将在电脑与手机端自动互通漫游。
                </div>
            `;

            const form = container.querySelector('#account-auth-form');
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const username = form.querySelector('#auth-username').value;
                const pwd = form.querySelector('#auth-password').value;

                try {
                    if (isRegister) {
                        await window.CloudSyncService.register(username, pwd);
                    } else {
                        await window.CloudSyncService.login(username, pwd);
                    }
                } catch (err) {
                    console.warn('[AccountModal] Auth failed:', err);
                }
            });

            const toggleBtn = container.querySelector('#btn-toggle-auth-mode');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    currentMode = isRegister ? 'login' : 'register';
                    this.renderModalBody(state);
                });
            }
        },

        renderProfileView(container, state) {
            const user = state.currentUser;
            const username = user.username || user.displayName || '用户';
            const initial = username.charAt(0).toUpperCase();

            container.innerHTML = `
                <div class="account-profile-card">
                    <div class="account-user-banner">
                        <div class="account-avatar-circle">${initial}</div>
                        <div class="account-user-meta">
                            <div class="account-user-email" title="${username}">${username}</div>
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
        }
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
