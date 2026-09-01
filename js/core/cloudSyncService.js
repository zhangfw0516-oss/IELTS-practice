/**
 * IELTS Atlas - Cloud Sync Service (Powered by Firebase)
 * 实现跨设备（PC/手机/平板）的用户账号鉴权与学习进度（背词、做题、设置）自动双向云同步。
 */
(function(window) {
    'use strict';

    const SYNC_DEBOUNCE_MS = 5000;
    const LAST_SYNC_KEY = 'ielts_atlas_last_sync_timestamp';

    const state = {
        initialized: false,
        isConfigured: false,
        firebaseApp: null,
        auth: null,
        db: null,
        currentUser: null,
        status: 'idle', // 'idle' | 'syncing' | 'synced' | 'error'
        lastSyncTime: null,
        errorMessage: null,
        listeners: new Set(),
        debounceTimer: null,
        unsubscribeAuth: null
    };

    // 错误信息友好化中文化
    function friendlyErrorMessage(error) {
        if (!error) return '未知错误';
        const code = error.code || '';
        const msg = error.message || String(error);
        if (code === 'auth/invalid-email') return '请输入有效的邮箱地址';
        if (code === 'auth/user-disabled') return '该账号已被禁用';
        if (code === 'auth/user-not-found') return '该邮箱未注册，请先注册';
        if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return '密码错误，请重试';
        if (code === 'auth/email-already-in-use') return '该邮箱已被注册，请直接登录';
        if (code === 'auth/weak-password') return '密码强度太低，建议至少 6 位字符';
        if (code === 'auth/network-request-failed') return '网络连接失败，请检查网络后重试';
        if (code === 'auth/too-many-requests') return '尝试次数过多，请稍后再试或重置密码';
        if (code === 'permission-denied') return '云端数据库读写权限受限，请检查 Firebase 规则';
        return msg;
    }

    const CloudSyncService = {
        /**
         * 初始化 Firebase 实例与监听器
         */
        async init() {
            if (state.initialized) return;

            // 读取已保存的上次同步时间
            const savedLastSync = localStorage.getItem(LAST_SYNC_KEY);
            if (savedLastSync) {
                state.lastSyncTime = parseInt(savedLastSync, 10);
            }

            const config = window.FirebaseConfigManager ? window.FirebaseConfigManager.getConfig() : null;
            if (!config || !window.firebase) {
                state.isConfigured = false;
                this._emitChange();
                this._bindConfigEvents();
                return;
            }

            this._setupFirebase(config);
            this._bindConfigEvents();
            this._bindAppDataAutoSync();
        },

        _setupFirebase(config) {
            try {
                if (!window.firebase) {
                    console.warn('[CloudSync] Firebase SDK not loaded');
                    return;
                }

                // 避免重复初始化 App
                let app;
                if (window.firebase.apps && window.firebase.apps.length > 0) {
                    app = window.firebase.apps[0];
                } else {
                    app = window.firebase.initializeApp(config);
                }

                state.firebaseApp = app;
                state.auth = window.firebase.auth();
                state.db = window.firebase.firestore();
                state.isConfigured = true;
                state.initialized = true;

                // 监听登录状态改变
                if (state.unsubscribeAuth) state.unsubscribeAuth();
                state.unsubscribeAuth = state.auth.onAuthStateChanged(async (user) => {
                    state.currentUser = user ? {
                        uid: user.uid,
                        email: user.email,
                        displayName: user.displayName || user.email.split('@')[0],
                        emailVerified: user.emailVerified
                    } : null;

                    if (user) {
                        console.info('[CloudSync] Logged in as:', user.email);
                        // 登录后自动执行一次智能拉取合并
                        await this.pullFromCloud({ silent: true }).catch(err => {
                            console.warn('[CloudSync] Initial pull failed:', err);
                        });
                    } else {
                        state.status = 'idle';
                    }
                    this._emitChange();
                });

                this._emitChange();
            } catch (e) {
                console.error('[CloudSync] Setup error:', e);
                state.status = 'error';
                state.errorMessage = friendlyErrorMessage(e);
                this._emitChange();
            }
        },

        _bindConfigEvents() {
            window.addEventListener('ielts:firebase-config-updated', (e) => {
                this._setupFirebase(e.detail);
            });
            window.addEventListener('ielts:firebase-config-cleared', () => {
                if (state.auth && state.currentUser) {
                    state.auth.signOut().catch(() => {});
                }
                state.isConfigured = false;
                state.currentUser = null;
                state.status = 'idle';
                this._emitChange();
            });

            // 当从后台切换回前台时，检测云端是否有更新
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && state.currentUser) {
                    this.pullFromCloud({ silent: true, ifNewer: true }).catch(() => {});
                }
            });
        },

        /**
         * 监听本地 AppData 数据变动并自动调度上传
         */
        _bindAppDataAutoSync() {
            const tryAttach = () => {
                if (window.AppData && typeof window.AppData.subscribe === 'function') {
                    window.AppData.subscribe(() => {
                        this.scheduleAutoSync();
                    });
                    return true;
                }
                return false;
            };

            if (!tryAttach()) {
                const interval = setInterval(() => {
                    if (tryAttach()) clearInterval(interval);
                }, 1000);
            }
        },

        /**
         * 安排防抖自动云端上传
         */
        scheduleAutoSync() {
            if (!state.currentUser || !state.db) return;
            if (state.debounceTimer) clearTimeout(state.debounceTimer);

            state.debounceTimer = setTimeout(() => {
                this.pushToCloud({ silent: true }).catch(err => {
                    console.warn('[CloudSync] Auto-push failed:', err);
                });
            }, SYNC_DEBOUNCE_MS);
        },

        /**
         * 用户注册 (Email + Password)
         */
        async register(email, password) {
            if (!state.auth) throw new Error('云服务未初始化或未配置 Firebase');
            state.status = 'syncing';
            state.errorMessage = null;
            this._emitChange();

            try {
                const cred = await state.auth.createUserWithEmailAndPassword(email.trim(), password);
                state.status = 'synced';
                this._emitChange();
                // 注册成功后将当前本地数据作为首份云端备份上传
                await this.pushToCloud({ silent: true });
                return cred.user;
            } catch (err) {
                state.status = 'error';
                state.errorMessage = friendlyErrorMessage(err);
                this._emitChange();
                throw new Error(state.errorMessage);
            }
        },

        /**
         * 用户登录 (Email + Password)
         */
        async login(email, password) {
            if (!state.auth) throw new Error('云服务未初始化或未配置 Firebase');
            state.status = 'syncing';
            state.errorMessage = null;
            this._emitChange();

            try {
                const cred = await state.auth.signInWithEmailAndPassword(email.trim(), password);
                state.status = 'idle';
                this._emitChange();
                return cred.user;
            } catch (err) {
                state.status = 'error';
                state.errorMessage = friendlyErrorMessage(err);
                this._emitChange();
                throw new Error(state.errorMessage);
            }
        },

        /**
         * 发送重置密码邮件
         */
        async sendPasswordReset(email) {
            if (!state.auth) throw new Error('云服务未初始化或未配置 Firebase');
            try {
                await state.auth.sendPasswordResetEmail(email.trim());
                return true;
            } catch (err) {
                throw new Error(friendlyErrorMessage(err));
            }
        },

        /**
         * 退出登录
         */
        async logout() {
            if (!state.auth) return;
            try {
                await state.auth.signOut();
                state.currentUser = null;
                state.status = 'idle';
                state.errorMessage = null;
                this._emitChange();
            } catch (err) {
                console.error('[CloudSync] Logout error:', err);
            }
        },

        /**
         * 将本地数据上传到云端 Firestore
         */
        async pushToCloud(options = {}) {
            if (!state.currentUser || !state.db) {
                if (!options.silent) throw new Error('请先登录账号后再同步数据');
                return;
            }
            if (!window.AppData || !window.AppData.backups) {
                if (!options.silent) throw new Error('本地数据引擎未准备就绪');
                return;
            }

            state.status = 'syncing';
            state.errorMessage = null;
            this._emitChange();

            try {
                // 导出完整的轻量化本地快照（练习记录、背单词进度、偏好等）
                const snapshot = await window.AppData.backups.export();
                const now = Date.now();

                const syncDoc = {
                    updatedAt: now,
                    updatedAtIso: new Date(now).toISOString(),
                    clientDevice: navigator.userAgent.slice(0, 100),
                    version: 2,
                    snapshot: snapshot
                };

                const userRef = state.db.collection('users').doc(state.currentUser.uid);
                const backupRef = userRef.collection('sync').doc('latest');

                await backupRef.set(syncDoc);
                await userRef.set({
                    lastSyncAt: now,
                    lastSyncDevice: navigator.userAgent.slice(0, 100),
                    email: state.currentUser.email
                }, { merge: true });

                state.lastSyncTime = now;
                state.status = 'synced';
                localStorage.setItem(LAST_SYNC_KEY, String(now));
                this._emitChange();

                if (!options.silent && typeof window.showToast === 'function') {
                    window.showToast('✅ 学习数据已成功同步至云端！', 'success');
                }
                return true;
            } catch (err) {
                console.error('[CloudSync] Push error:', err);
                state.status = 'error';
                state.errorMessage = friendlyErrorMessage(err);
                this._emitChange();
                if (!options.silent) throw new Error(state.errorMessage);
            }
        },

        /**
         * 从云端拉取数据并智能合并/恢复至本地
         */
        async pullFromCloud(options = {}) {
            if (!state.currentUser || !state.db) {
                if (!options.silent) throw new Error('请先登录账号');
                return;
            }
            if (!window.AppData || !window.AppData.backups) {
                if (!options.silent) throw new Error('本地数据引擎未准备就绪');
                return;
            }

            try {
                const backupRef = state.db.collection('users').doc(state.currentUser.uid).collection('sync').doc('latest');
                const docSnap = await backupRef.get();

                if (!docSnap.exists) {
                    console.info('[CloudSync] No cloud data found for this user, pushing local data.');
                    await this.pushToCloud({ silent: true });
                    return;
                }

                const cloudData = docSnap.data();
                const cloudTimestamp = cloudData.updatedAt || 0;

                // 如果指定了 ifNewer，且本地上次同步时间比云端更新，则无需拉取
                if (options.ifNewer && state.lastSyncTime && state.lastSyncTime >= cloudTimestamp) {
                    return;
                }

                state.status = 'syncing';
                this._emitChange();

                const cloudSnapshot = cloudData.snapshot;
                if (cloudSnapshot) {
                    // 创建导入计划并进行安全合并
                    const plan = await window.AppData.backups.previewImport(cloudSnapshot, { mode: 'merge' });
                    if (plan && plan.planId) {
                        await window.AppData.backups.applyImport(plan.planId);
                    }
                }

                state.lastSyncTime = cloudTimestamp || Date.now();
                state.status = 'synced';
                localStorage.setItem(LAST_SYNC_KEY, String(state.lastSyncTime));
                this._emitChange();

                window.dispatchEvent(new CustomEvent('ielts:data-synced-from-cloud', { detail: cloudData }));

                if (!options.silent && typeof window.showToast === 'function') {
                    window.showToast('✅ 已从云端同步最新做题与单词进度！', 'success');
                }
                return true;
            } catch (err) {
                console.error('[CloudSync] Pull error:', err);
                state.status = 'error';
                state.errorMessage = friendlyErrorMessage(err);
                this._emitChange();
                if (!options.silent) throw new Error(state.errorMessage);
            }
        },

        /**
         * 获取当前服务状态
         */
        getState() {
            return {
                isConfigured: state.isConfigured,
                currentUser: state.currentUser,
                status: state.status,
                lastSyncTime: state.lastSyncTime,
                errorMessage: state.errorMessage
            };
        },

        /**
         * 订阅状态变更
         */
        subscribe(listener) {
            if (typeof listener === 'function') {
                state.listeners.add(listener);
                listener(this.getState());
            }
            return () => state.listeners.delete(listener);
        },

        _emitChange() {
            const currentState = this.getState();
            state.listeners.forEach(listener => {
                try {
                    listener(currentState);
                } catch (e) {
                    console.error('[CloudSync] Listener error:', e);
                }
            });
        }
    };

    window.CloudSyncService = CloudSyncService;
})(window);
