#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../../js/core/cloudSyncService.js', import.meta.url), 'utf8');
const resetSource = fs.readFileSync(new URL('../../../js/core/siteDataReset.js', import.meta.url), 'utf8');
const CHECKPOINT_KEY = 'ielts_vocab_session_checkpoint';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const user = { uid: 'student-a', email: 'student@ielts.atlas', emailVerified: false };
const remote = (records = ['cloud'], extra = {}) => ({
    version: 2, updatedAt: 100, revision: 'original', snapshot: { records }, ...extra
});

async function harness(options = {}) {
    let cloud = clone(options.cloud ?? null);
    let local = clone(options.local ?? { records: ['local'] });
    let authCallback;
    let pendingPlan;
    let transactionCount = 0;
    const log = [];
    const subscribers = new Set();
    const timers = new Map();
    const windowListeners = new Map();
    const documentListeners = new Map();
    const values = new Map(Object.entries(options.storage || {}));
    const localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
        clear: () => values.clear(),
        key: index => [...values.keys()][index],
        get length() { return values.size; }
    };
    const snap = () => ({ exists: cloud !== null, data: () => clone(cloud) });
    const makeRef = path => ({
        path,
        collection: name => makeRef(`${path}/${name}`),
        doc: name => makeRef(`${path}/${name}`),
        async get() { log.push('read'); if (options.failRead) throw new Error('offline'); return snap(); },
        async set(data) { log.push('unsafe-direct-write'); cloud = clone(data); }
    });
    const db = {
        collection: name => makeRef(name),
        async runTransaction(callback) {
            transactionCount++;
            log.push('transaction');
            if (options.race && transactionCount === 1) {
                cloud = remote(['competitor'], { revision: 'other-device', updatedAt: 300 });
            }
            const writes = [];
            const result = await callback({
                async get() { log.push('transaction-read'); return snap(); },
                set(ref, value) { writes.push({ ref, value: clone(value) }); }
            });
            for (const { ref, value } of writes) {
                if (ref.path.endsWith('/sync/latest')) {
                    log.push('write');
                    cloud = value;
                }
            }
            return result;
        }
    };
    const auth = {
        onAuthStateChanged(callback) { authCallback = callback; return () => {}; },
        async signInWithEmailAndPassword(email, password) {
            log.push(['login', email, password]);
            const loginUser = { ...user, email };
            await authCallback(loginUser);
            return { user: loginUser };
        },
        async createUserWithEmailAndPassword(email, password) {
            log.push(['register', email, password]);
            const created = { ...user, email };
            await authCallback(created);
            return { user: created };
        },
        async signOut() { await authCallback(null); },
        async sendPasswordResetEmail(email) { log.push(['reset', email]); }
    };
    const firebase = {
        apps: [],
        initializeApp: config => ({ options: config }),
        auth: () => auth,
        firestore: () => db
    };
    const backups = {
        async export() { log.push('export'); return clone(local); },
        async create() { log.push('backup'); if (options.failBackup) throw new Error('backup failed'); return { id: 'safe-backup' }; },
        async previewImport(payload, importOptions) {
            log.push(['preview', clone(payload), clone(importOptions)]);
            if (options.failPreview) throw new Error('invalid snapshot');
            pendingPlan = clone(payload);
            return { id: 'plan-1' };
        },
        async commitImport(id) {
            assert.equal(id, 'plan-1', 'must use previewImport.id with commitImport');
            log.push('commit');
            if (options.failCommit) throw new Error('disk full');
            local = { records: [...new Set([...local.records, ...(pendingPlan.records || [])])] };
            subscribers.forEach(listener => listener({ type: 'import-commit' }));
            if (options.switchDuringCommit) await authCallback({ ...user, uid: 'student-b' });
            return { committed: true };
        }
    };
    const document = {
        visibilityState: 'visible',
        addEventListener(name, callback) { documentListeners.set(name, callback); }
    };
    const window = {
        firebase, localStorage, document,
        FirebaseConfigManager: { getConfig: () => ({ projectId: 'test-project', apiKey: 'test-only' }) },
        AppData: { ready: Promise.resolve(), backups, subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); } },
        StudyStatsManager: {
            exportData: () => ({ version: 2, devices: {} }),
            mergeFromCloud(raw) { log.push(['stats-merge', clone(raw)]); }, render() {}
        },
        showToast: (message, level) => log.push(['toast', message, level]),
        addEventListener(name, callback) { windowListeners.set(name, callback); },
        dispatchEvent(event) { log.push(['event', event.type]); },
        crypto: { randomUUID: () => `test-revision-${transactionCount + 1}` }
    };
    const schedule = callback => { const id = timers.size + 1; timers.set(id, callback); return id; };
    vm.runInNewContext(source, {
        window, document, localStorage, firebase, navigator: { userAgent: 'VM regression tests' },
        console: { info() {}, warn() {}, error() {}, log() {} }, TextEncoder, Blob,
        crypto: window.crypto,
        setTimeout: schedule, clearTimeout: id => timers.delete(id),
        setInterval: schedule, clearInterval: id => timers.delete(id),
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
    });
    const service = window.CloudSyncService;
    await service.init();
    await authCallback(user);
    await Promise.resolve();
    return {
        service, log, values, timers, subscribers, window,
        get cloud() { return clone(cloud); }, get local() { return clone(local); },
        authEvent: authCallback,
        visibility: () => documentListeners.get('visibilitychange')?.(),
        decodeSnapshot: () => cloud?.snapshotJson ? JSON.parse(cloud.snapshotJson) : clone(cloud?.snapshot)
    };
}

const cases = [
    ['手动模式默认不开启后台拉取或上传', async () => {
        const h = await harness({ cloud: remote() });
        assert.equal(h.service.isAutoSyncEnabled(), false);
        h.visibility();
        await Promise.resolve();
        assert.ok(!h.log.includes('read') && !h.log.includes('write'));
    }],
    ['云端还原通过真实导入接口合并且先备份', async () => {
        const h = await harness({ cloud: remote() });
        await h.service.pullFromCloud();
        assert.deepEqual(h.local.records.sort(), ['cloud', 'local']);
        assert.equal(h.log.find(entry => Array.isArray(entry) && entry[0] === 'preview')[2].practiceMode, 'merge');
        assert.ok(h.log.indexOf('backup') >= 0 && h.log.indexOf('backup') < h.log.indexOf('commit'));
        assert.equal(h.service.getState().status, 'synced');
    }],
    ['导入失败不可先覆盖统计、不可显示同步成功', async () => {
        const h = await harness({ cloud: remote(['cloud'], { studyStats: '{"remote":true}' }), failCommit: true });
        await assert.rejects(h.service.pullFromCloud());
        assert.equal(h.service.getState().status, 'error');
        assert.ok(!h.log.some(item => Array.isArray(item) && item[0] === 'stats-merge'));
        assert.ok(!h.log.some(item => Array.isArray(item) && item[0] === 'toast' && item[2] === 'success'));
        assert.deepEqual(h.local.records, ['local']);
    }],
    ['本地备份失败必须停止导入', async () => {
        const h = await harness({ cloud: remote(), failBackup: true });
        await assert.rejects(h.service.pullFromCloud());
        assert.ok(!h.log.includes('commit'));
        assert.deepEqual(h.local.records, ['local']);
    }],
    ['云端无备份时还原不自动上传也不虚报还原成功', async () => {
        const h = await harness();
        const result = await h.service.pullFromCloud();
        assert.equal(result, false);
        assert.ok(!h.log.includes('write') && !h.log.includes('unsafe-direct-write'));
        assert.ok(!h.log.some(item => Array.isArray(item) && item[0] === 'toast' && item[2] === 'success'));
        assert.equal(h.service.getState().lastSyncTime, null);
    }],
    ['上传先合并远端再以事务写入，保留两端数据', async () => {
        const h = await harness({ cloud: remote() });
        await h.service.syncNow();
        assert.deepEqual(h.decodeSnapshot().records.sort(), ['cloud', 'local']);
        assert.ok(h.log.indexOf('read') < h.log.indexOf('write'));
        assert.ok(h.log.includes('transaction'));
        assert.ok(!h.log.includes('unsafe-direct-write'));
    }],
    ['远端在读取之后发生变化时不能覆盖另一设备的新数据', async () => {
        const h = await harness({ cloud: remote(), race: true });
        await h.service.syncNow().catch(() => {});
        assert.ok(h.decodeSnapshot().records.includes('competitor'), '事务竞争必须拒绝覆盖或重新合并竞争者数据');
    }],
    ['连续点击同步应串行执行而非重叠导入', async () => {
        const h = await harness({ cloud: remote() });
        await Promise.all([h.service.syncNow(), h.service.syncNow()]);
        const reads = h.log.flatMap((entry, index) => entry === 'read' ? [index] : []);
        assert.ok(reads.length >= 2);
        assert.ok(h.log.indexOf('write') < reads[1], '第二次同步必须等待第一次同步写入结束');
        assert.deepEqual(h.decodeSnapshot().records.sort(), ['cloud', 'local']);
    }],
    ['网络读取失败时不能盲目上传本地副本', async () => {
        const h = await harness({ cloud: remote(), failRead: true });
        await assert.rejects(h.service.syncNow());
        assert.ok(!h.log.includes('write'));
        assert.deepEqual(h.decodeSnapshot().records, ['cloud']);
    }],
    ['较旧云端批次不能覆盖较新本地批次', async () => {
        const checkpoint = JSON.stringify({ timestamp: 500, queue: ['new'] });
        const h = await harness({
            storage: { [CHECKPOINT_KEY]: checkpoint },
            cloud: remote(['cloud'], { vocabCheckpoint: JSON.stringify({ timestamp: 100, queue: ['old'] }) })
        });
        await h.service.pullFromCloud();
        assert.deepEqual(JSON.parse(h.values.get(CHECKPOINT_KEY)).queue, ['new']);
    }],
    ['本地清除标记不会被旧云批次复活', async () => {
        const h = await harness({
            storage: { [CHECKPOINT_KEY]: JSON.stringify({ timestamp: 500, cleared: true }) },
            cloud: remote(['cloud'], { vocabCheckpoint: JSON.stringify({ timestamp: 100, queue: ['old'] }) })
        });
        await h.service.pullFromCloud();
        assert.equal(JSON.parse(h.values.get(CHECKPOINT_KEY)).cleared, true);
    }],
    ['旧版云端缺少批次不能删除本地有效进度', async () => {
        const checkpoint = JSON.stringify({ timestamp: 500, queue: ['local'] });
        const h = await harness({ storage: { [CHECKPOINT_KEY]: checkpoint }, cloud: remote(['cloud'], { vocabCheckpoint: null }) });
        await h.service.pullFromCloud();
        assert.deepEqual(JSON.parse(h.values.get(CHECKPOINT_KEY)).queue, ['local']);
    }],
    ['超过单文档安全大小时停止写入并保留之前云备份', async () => {
        const h = await harness({ cloud: remote(), local: { records: ['字'.repeat(400000)] } });
        await assert.rejects(h.service.syncNow());
        assert.ok(!h.log.includes('write'));
        assert.deepEqual(h.decodeSnapshot().records, ['cloud']);
    }],
    ['旧短密码可登录，新账号不得注册弱密码或标签用户名', async () => {
        const h = await harness();
        await h.service.login('student', 'a');
        assert.ok(h.log.some(item => Array.isArray(item) && item[0] === 'login' && item[2] === 'ielts_atlas_p_a_padded'));
        await assert.rejects(h.service.register('new-student', '1234567'));
        await assert.rejects(h.service.register('<img src=x>', 'strong-password'));
        assert.ok(!h.log.some(item => Array.isArray(item) && item[0] === 'register'));
    }],
    ['自动同步导入自身触发的数据变更不能再次安排上传', async () => {
        const h = await harness({ cloud: remote() });
        h.service.setAutoSyncEnabled(true);
        h.timers.clear();
        await h.service.pullFromCloud();
        assert.equal(h.timers.size, 0);
    }],
    ['账号切换不能上传前一个用户的本地记录', async () => {
        const h = await harness({ cloud: remote(), storage: { ielts_atlas_local_data_owner: 'test-project:student-a' } });
        await h.authEvent({ ...user, uid: 'student-b' });
        await h.service.syncNow().catch(() => {});
        assert.ok(!h.log.includes('write') && !h.log.includes('unsafe-direct-write'), '换号必须先隔离或显式处理本地数据');
        assert.equal(h.service.getState().status, 'error', '阻止同步时必须向账号面板显示原因');
        assert.ok(h.service.getState().errorMessage);
    }],
    ['同步等待期间换号必须取消旧操作的云写入', async () => {
        const h = await harness({ cloud: remote(), switchDuringCommit: true });
        await h.service.syncNow().catch(() => {});
        assert.ok(!h.log.includes('write') && !h.log.includes('unsafe-direct-write'), '异步同步中换号不能把旧账号进度写给新账号');
    }],
    ['全量重置数据库删除失败时不能解锁旧账号残留数据', async () => {
        const h = await harness({ cloud: remote(), storage: { ielts_atlas_local_data_owner: 'test-project:student-a' } });
        h.window.sessionStorage = { clear() {} };
        h.window.indexedDB = { deleteDatabase() {
            const request = { error: new Error('database locked') };
            queueMicrotask(() => request.onerror());
            return request;
        } };
        h.window.ExternalBackupService = {
            withFullResetLock: callback => callback(),
            prepareForFullReset: async () => ({ success: true }),
            commitFullResetPreparation: async () => ({ success: true }),
            rollbackFullResetPreparation: async () => ({ success: true })
        };
        vm.runInNewContext(resetSource, { window: h.window, console });
        const result = await h.window.SiteDataReset.perform({ reload: false });
        assert.equal(result.success, false);
        await h.authEvent({ ...user, uid: 'student-b' });
        await h.service.syncNow().catch(() => {});
        assert.ok(!h.log.includes('write'), '失败的重置仍有旧数据库，不能让新账号上传旧数据');
    }],
    ['全量重置成功后确实删除账号归属键', async () => {
        const h = await harness({ storage: { ielts_atlas_local_data_owner: 'test-project:student-a' } });
        h.window.sessionStorage = { clear() {} };
        h.window.indexedDB = { deleteDatabase() {
            const request = {};
            queueMicrotask(() => request.onsuccess());
            return request;
        } };
        h.window.ExternalBackupService = {
            withFullResetLock: callback => callback(),
            prepareForFullReset: async () => ({ success: true }),
            commitFullResetPreparation: async () => ({ success: true }),
            rollbackFullResetPreparation: async () => ({ success: true })
        };
        vm.runInNewContext(resetSource, { window: h.window, console });
        const result = await h.window.SiteDataReset.perform({ reload: false });
        assert.equal(result.success, true);
        assert.equal(h.values.has('ielts_atlas_local_data_owner'), false);
    }]
];

let passed = 0;
const results = [];
for (const [name, run] of cases) {
    try { await run(); passed++; results.push({ name, status: 'pass' }); }
    catch (error) { results.push({ name, status: 'fail', error: error.message }); }
}
console.log(JSON.stringify({ status: passed === cases.length ? 'pass' : 'fail', passed, total: cases.length, results }, null, 2));
if (passed !== cases.length) process.exitCode = 1;
