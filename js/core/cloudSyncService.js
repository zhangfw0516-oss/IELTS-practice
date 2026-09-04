/** Firebase sync: serialized merge-before-upload with optimistic remote concurrency control. */
(function(window) {
    'use strict';
    const AUTO_KEY = 'ielts_atlas_auto_sync_enabled';
    const OWNER_KEY = 'ielts_atlas_local_data_owner';
    const CHECKPOINT_KEY = 'ielts_vocab_session_checkpoint';
    const LAST_SYNC_KEY = 'ielts_atlas_last_sync_timestamp';
    const MAX_DOCUMENT_BYTES = 900000;
    const state = {
        initialized: false, isConfigured: false, currentUser: null, auth: null, db: null,
        projectId: '', status: 'idle', errorMessage: null, lastSyncTime: null,
        autoSyncEnabled: localStorage.getItem(AUTO_KEY) === 'true',
        listeners: new Set(), timer: null, tail: Promise.resolve(), merging: false,
        busy: false, dirty: false, unsubscribeAuth: null, unsubscribeData: null
    };
    function errorText(error) {
        const messages = {
            'auth/invalid-email': '用户名格式无效，请使用中文、字母、数字、下划线或真实邮箱',
            'auth/email-already-in-use': '该用户名已经注册',
            'auth/invalid-credential': '用户名或密码错误',
            'auth/wrong-password': '用户名或密码错误',
            'auth/user-not-found': '用户名或密码错误',
            'auth/weak-password': '新密码至少需要 8 位',
            'auth/network-request-failed': '网络连接失败，请稍后重试',
            'auth/too-many-requests': '尝试次数过多，请稍后再试',
            'permission-denied': '云端权限受限，未完成同步；请联系维护者检查 Firebase 规则'
        };
        return messages[error?.code] || error?.message || String(error || '同步失败');
    }
    function internalEmail(value) {
        const text = String(value || '').trim().toLowerCase();
        return text.includes('@') ? text : encodeURIComponent(text).replace(/%/g, '_') + '@ielts.atlas';
    }
    function legacyPassword(value) {
        const text = String(value || '');
        return text.length < 6 ? 'ielts_atlas_p_' + text + '_padded' : text;
    }
    function displayName(email) {
        if (!email) return '用户';
        if (!email.endsWith('@ielts.atlas')) return email.split('@')[0];
        const text = email.slice(0, -12);
        try { return decodeURIComponent(text.replace(/_/g, '%')); } catch (_) { return text; }
    }
    function revision(data) { return data ? String(data.revision || data.updatedAt || 0) : 'missing'; }
    function checkpoint(raw) {
        if (!raw) return null;
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || typeof value !== 'object' || !Number.isFinite(Number(value.timestamp))) throw new Error('云端断点格式无效');
        return value;
    }
    function emit() {
        const snapshot = service.getState();
        state.listeners.forEach(fn => { try { fn(snapshot); } catch (e) { console.warn('[CloudSync] Listener:', e); } });
    }
    function assertUser(uid) {
        if (!state.currentUser || state.currentUser.uid !== uid) throw new Error('账号已改变，本次同步已停止');
        const owner = state.projectId + ':' + uid;
        const existing = localStorage.getItem(OWNER_KEY);
        if (existing && existing !== owner) throw new Error('此浏览器保留了另一账号的学习数据。为避免混入新账号，请先导出并在设置中清除本地数据，或使用独立浏览器配置。');
        if (!existing) localStorage.setItem(OWNER_KEY, owner);
    }
    function readRef(uid) { return state.db.collection('users').doc(uid).collection('sync').doc('latest'); }
    async function readCloud(ref) {
        const doc = await ref.get();
        return doc.exists ? doc.data() : null;
    }
    async function mergeCloud(data, uid) {
        if (!data) return;
        const snapshot = data.snapshotJson ? JSON.parse(data.snapshotJson) : data.snapshot;
        if (!snapshot) throw new Error('云端备份缺少学习数据，未执行恢复');
        // Validate extra data before committing anything.
        const remoteCheckpoint = checkpoint(data.vocabCheckpoint);
        if (data.studyStats) JSON.parse(typeof data.studyStats === 'string' ? data.studyStats : JSON.stringify(data.studyStats));
        assertUser(uid);
        state.merging = true;
        try {
            const backups = window.AppData.backups;
            if (typeof backups.create === 'function') await backups.create({ type: 'pre-cloud-merge' });
            for (let attempt = 0; attempt < 3; attempt++) {
                const plan = await backups.previewImport(snapshot, { practiceMode: 'merge', preferNewest: true });
                if (!plan?.id || typeof backups.commitImport !== 'function') throw new Error('本地导入接口不兼容，未恢复云端数据');
                assertUser(uid);
                try { await backups.commitImport(plan.id); break; }
                catch (error) {
                    if (error.code !== 'CONFLICT' || attempt === 2) throw error;
                }
            }
            assertUser(uid);
            if (data.studyStats) {
                if (!window.StudyStatsManager?.mergeFromCloud) throw new Error('学习统计模块尚未准备就绪，请重试');
                window.StudyStatsManager.mergeFromCloud(data.studyStats);
            }
            let localCheckpoint = null;
            try { localCheckpoint = checkpoint(localStorage.getItem(CHECKPOINT_KEY)); } catch (_) {}
            if (remoteCheckpoint && (!localCheckpoint || Number(remoteCheckpoint.timestamp) > Number(localCheckpoint.timestamp))) {
                localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(remoteCheckpoint));
                window.dispatchEvent(new CustomEvent('ielts:vocab-checkpoint-updated'));
            }
            window.dispatchEvent(new CustomEvent('ielts:data-synced-from-cloud', { detail: data }));
        } finally { state.merging = false; }
    }
    async function runTask(task, options) {
        if (!state.currentUser || !state.db) throw new Error('请先登录账号');
        if (!window.AppData?.backups) throw new Error('本地数据引擎尚未准备好');
        const uid = state.currentUser.uid;
        assertUser(uid);
        await window.AppData.ready;
        state.busy = true;
        state.dirty = false;
        state.status = 'syncing';
        state.errorMessage = null;
        emit();
        try {
            const result = await task(uid);
            assertUser(uid);
            state.status = result === false ? 'idle' : 'synced';
            emit();
            if (!options.silent && typeof window.showToast === 'function') {
                window.showToast(result === false ? '云端尚无备份，请先使用「立即同步」上传本地数据' : '学习数据已合并同步；本地数据已保留', result === false ? 'info' : 'success');
            }
            return result;
        } catch (error) {
            state.status = 'error';
            state.errorMessage = errorText(error);
            emit();
            throw new Error(state.errorMessage);
        } finally {
            state.busy = false;
            if (state.dirty && state.autoSyncEnabled) service.scheduleAutoSync();
        }
    }
    function enqueue(task, options = {}) {
        const uid = state.currentUser?.uid;
        const result = state.tail.then(() => {
            if (!uid || state.currentUser?.uid !== uid) throw new Error('账号已改变，请重新同步');
            return runTask(task, options);
        }).catch(error => {
            state.status = 'error';
            state.errorMessage = errorText(error);
            emit();
            throw error;
        });
        state.tail = result.catch(() => {});
        return result;
    }
    function rememberSync(uid, timestamp) {
        state.lastSyncTime = Number(timestamp) || Date.now();
        localStorage.setItem(LAST_SYNC_KEY + ':' + state.projectId + ':' + uid, String(state.lastSyncTime));
    }
    function changed() {
        if (state.merging) return;
        if (state.busy) { state.dirty = true; return; }
        service.scheduleAutoSync();
    }
    const service = {
        async init() {
            if (state.initialized) return;
            const config = window.FirebaseConfigManager?.getConfig();
            if (!config || !window.firebase) { state.isConfigured = false; emit(); return; }
            try {
                const app = window.firebase.apps?.length ? window.firebase.apps[0] : window.firebase.initializeApp(config);
                if (app.options?.projectId && app.options.projectId !== config.projectId) throw new Error('Firebase 配置已改变，请刷新页面后再登录');
                state.projectId = config.projectId;
                state.auth = window.firebase.auth();
                state.db = window.firebase.firestore();
                state.initialized = true;
                state.isConfigured = true;
                state.unsubscribeAuth = state.auth.onAuthStateChanged(user => {
                    if (state.timer) clearTimeout(state.timer);
                    state.currentUser = user ? { uid: user.uid, email: user.email,
                        username: displayName(user.email), displayName: displayName(user.email), emailVerified: user.emailVerified } : null;
                    state.status = 'idle';
                    state.lastSyncTime = user ? Number(localStorage.getItem(LAST_SYNC_KEY + ':' + state.projectId + ':' + user.uid)) || null : null;
                    emit();
                    if (user && state.autoSyncEnabled) this.pullFromCloud({ silent: true }).catch(error => {
                        state.status = 'error'; state.errorMessage = errorText(error); emit();
                    });
                });
                if (window.AppData?.subscribe) state.unsubscribeData = window.AppData.subscribe(changed);
                window.addEventListener('ielts:learning-state-changed', changed);
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible' && state.currentUser && state.autoSyncEnabled) {
                        this.syncNow({ silent: true }).catch(() => {});
                    }
                });
                window.addEventListener('ielts:firebase-config-updated', () => {
                    state.status = 'error'; state.errorMessage = 'Firebase 配置已改变，请刷新页面后再使用账号同步'; emit();
                });
                emit();
            } catch (error) { state.status = 'error'; state.errorMessage = errorText(error); emit(); }
        },
        scheduleAutoSync() {
            if (!state.autoSyncEnabled || !state.currentUser || state.merging) return;
            if (state.timer) clearTimeout(state.timer);
            state.timer = setTimeout(() => {
                state.timer = null;
                this.pushToCloud({ silent: true }).catch(() => {});
            }, 10000);
        },
        async register(username, password) {
            if (!state.auth) throw new Error('云服务尚未初始化');
            const name = String(username || '').trim();
            const pwd = String(password || '');
            if (!name || name.length > 64 || (!name.includes('@') && !/^[\p{L}\p{N}_-]+$/u.test(name))) throw new Error('用户名请使用中文、字母、数字、下划线或真实邮箱，最多 64 字符');
            if (pwd.length < 8) throw new Error('新账号密码至少需要 8 位');
            // Percent-escape aliases collide with encoded legacy names; reserve them.
            if (!name.includes('@') && /_[0-9a-f]{2}/i.test(name)) throw new Error('用户名请避免下划线后紧接两位十六进制字符，以免与旧账号重名');
            state.errorMessage = null;
            try {
                const credential = await state.auth.createUserWithEmailAndPassword(internalEmail(name), pwd);
                await this.pushToCloud({ silent: true });
                return credential.user;
            } catch (error) { state.status = 'error'; state.errorMessage = errorText(error); emit(); throw new Error(state.errorMessage); }
        },
        async login(username, password) {
            if (!state.auth) throw new Error('云服务尚未初始化');
            if (!String(username || '').trim() || !String(password || '')) throw new Error('请输入用户名和密码');
            state.errorMessage = null;
            try {
                const credential = await state.auth.signInWithEmailAndPassword(internalEmail(username), legacyPassword(password));
                await this.pullFromCloud({ silent: true });
                return credential.user;
            } catch (error) { state.status = 'error'; state.errorMessage = errorText(error); emit(); throw new Error(state.errorMessage); }
        },
        async sendPasswordReset(email) {
            if (!state.auth) throw new Error('云服务尚未初始化');
            const value = String(email || '').trim();
            if (!value.includes('@') || value.toLowerCase().endsWith('@ielts.atlas')) throw new Error('昵称账号没有可收信邮箱；只有使用真实邮箱注册的账号可以邮件找回密码');
            await state.auth.sendPasswordResetEmail(value);
            return true;
        },
        async logout() {
            if (state.timer) clearTimeout(state.timer);
            state.timer = null;
            await state.tail;
            if (state.auth) await state.auth.signOut();
            state.currentUser = null;
            state.status = 'idle';
            state.errorMessage = null;
            emit();
        },
        pushToCloud(options = {}) {
            return enqueue(async uid => {
                const ref = readRef(uid);
                for (let attempt = 0; attempt < 3; attempt++) {
                    const remote = await readCloud(ref);
                    await mergeCloud(remote, uid);
                    window.dispatchEvent(new CustomEvent('ielts:before-cloud-sync'));
                    const snapshot = await window.AppData.backups.export();
                    assertUser(uid);
                    const now = Date.now();
                    const doc = {
                        version: 3, revision: now + '-' + Math.random().toString(36).slice(2),
                        updatedAt: now, updatedAtIso: new Date(now).toISOString(),
                        clientDevice: navigator.userAgent.slice(0, 100),
                        snapshotJson: JSON.stringify(snapshot),
                        studyStats: JSON.stringify(window.StudyStatsManager?.exportData?.() || null),
                        vocabCheckpoint: localStorage.getItem(CHECKPOINT_KEY)
                    };
                    const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
                    if (bytes > MAX_DOCUMENT_BYTES) throw new Error('云备份超过安全容量（900 KB），本地记录和上一份云备份均未删除。请先在设置中导出完整备份；分片云备份需要维护者配置。');
                    if (typeof state.db.runTransaction !== 'function') throw new Error('云端事务接口不可用，已停止上传以避免覆盖其他设备');
                    try {
                        await state.db.runTransaction(async transaction => {
                            const current = await transaction.get(ref);
                            assertUser(uid);
                            if (revision(current.exists ? current.data() : null) !== revision(remote)) {
                                const error = new Error('另一台设备刚刚更新了数据，请重试');
                                error.code = 'sync/conflict';
                                throw error;
                            }
                            transaction.set(ref, doc);
                        });
                        rememberSync(uid, now);
                        return true;
                    } catch (error) {
                        if (error.code !== 'sync/conflict' || attempt === 2) throw error;
                    }
                }
            }, options);
        },
        pullFromCloud(options = {}) {
            return enqueue(async uid => {
                const remote = await readCloud(readRef(uid));
                if (!remote) return false;
                await mergeCloud(remote, uid);
                rememberSync(uid, remote.updatedAt);
                return true;
            }, options);
        },
        syncNow(options = {}) { return this.pushToCloud(options); },
        setAutoSyncEnabled(value) {
            state.autoSyncEnabled = !!value;
            localStorage.setItem(AUTO_KEY, String(state.autoSyncEnabled));
            if (state.timer) clearTimeout(state.timer);
            state.timer = null;
            emit();
            if (state.autoSyncEnabled) this.scheduleAutoSync();
        },
        isAutoSyncEnabled() { return state.autoSyncEnabled; },
        getState() {
            return { isConfigured: state.isConfigured, autoSyncEnabled: state.autoSyncEnabled,
                currentUser: state.currentUser, status: state.status, lastSyncTime: state.lastSyncTime, errorMessage: state.errorMessage };
        },
        subscribe(listener) {
            if (typeof listener === 'function') { state.listeners.add(listener); listener(this.getState()); }
            return () => state.listeners.delete(listener);
        }
    };
    window.CloudSyncService = service;
})(window);
