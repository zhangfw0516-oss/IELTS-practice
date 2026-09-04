#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../../js/services/studyStatsManager.js', import.meta.url), 'utf8');
const STORAGE_KEY = 'ielts_study_stats_v1';
let deviceSequence = 0;

function harness(seed) {
    const values = new Map(seed ? [[STORAGE_KEY, JSON.stringify(seed)]] : []);
    let now = new Date(2026, 8, 3, 12).getTime();
    const deviceId = `stats-test-device-${++deviceSequence}`;
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const listeners = new Map();
    const window = {
        addEventListener(name, callback) { listeners.set(name, callback); },
        dispatchEvent() {},
        crypto: { randomUUID: () => deviceId },
        AppData: { ready: Promise.resolve(), practice: { list: async () => [] } }
    };
    const localStorage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
    const document = {
        readyState: 'loading', addEventListener() {},
        getElementById: () => null, querySelectorAll: () => []
    };
    Object.assign(window, { localStorage, document });
    vm.runInNewContext(source, {
        window, document, localStorage, Date: Clock,
        crypto: window.crypto, console, setTimeout: () => 1, clearTimeout() {},
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
    });
    return { manager: window.StudyStatsManager, values, nextDay: () => { now += 86400000; } };
}

const cases = [
    ['同一天同词只计一次，忽略大小写和首尾空格', () => {
        const { manager } = harness();
        manager.recordWordStudied(' Apple ');
        manager.recordWordStudied('apple');
        manager.recordWordStudied('APPLE');
        manager.recordWordStudied('banana');
        manager.recordWordStudied('   ');
        assert.equal(manager.getVocabStats().todayWords, 2);
        assert.equal(manager.getVocabStats().totalWords, 2);
    }],
    ['只累计实际有效时长，不因背词次数虚增', () => {
        const { manager } = harness();
        manager.addVocabStudyDuration(20);
        manager.addVocabStudyDuration(35);
        manager.addVocabStudyDuration(-10);
        manager.addVocabStudyDuration(Infinity);
        manager.addVocabStudyDuration(NaN);
        manager.recordWordStudied('apple');
        assert.equal(manager.getVocabStats().todayVocabSeconds, 55);
        assert.equal(manager.getVocabStats().totalVocabSeconds, 55);
    }],
    ['跨天重新计今日词数且保留累计数据', () => {
        const { manager, nextDay } = harness();
        manager.recordWordStudied('apple');
        manager.addVocabStudyDuration(60);
        nextDay();
        assert.equal(manager.getVocabStats().todayWords, 0);
        assert.equal(manager.getVocabStats().todayVocabSeconds, 0);
        manager.recordWordStudied('apple');
        assert.equal(manager.getVocabStats().todayWords, 1);
        assert.equal(manager.getVocabStats().totalWords, 1);
        assert.equal(manager.getVocabStats().totalVocabSeconds, 60);
    }],
    ['两台设备累加各自时长、合并同日词集合，反复同步不翻倍', () => {
        const a = harness().manager;
        const b = harness().manager;
        a.recordWordStudied('apple'); a.addVocabStudyDuration(20);
        b.recordWordStudied('apple'); b.recordWordStudied('banana'); b.addVocabStudyDuration(30);
        a.mergeFromCloud(b.exportData());
        b.mergeFromCloud(a.exportData());
        a.mergeFromCloud(b.exportData());
        a.mergeFromCloud(b.exportData());
        for (const manager of [a, b]) {
            assert.equal(manager.getVocabStats().todayWords, 2);
            assert.equal(manager.getVocabStats().totalWords, 2);
            assert.equal(manager.getVocabStats().totalVocabSeconds, 50);
        }
        a.addVocabStudyDuration(5);
        b.addVocabStudyDuration(7);
        a.mergeFromCloud(b.exportData());
        b.mergeFromCloud(a.exportData());
        assert.equal(a.getVocabStats().totalVocabSeconds, 62);
        assert.equal(b.getVocabStats().totalVocabSeconds, 62);
    }],
    ['旧统计作为共同基线保留且迁移与重复导入幂等', () => {
        const legacy = {
            todayDate: '2026-09-03', todayVocabDurationSeconds: 100,
            todayVocabWordsCount: 3, totalVocabDurationSeconds: 600,
            studyDates: ['2026-09-02', '2026-09-03'],
            totalVocabWordsLearnedSet: ['apple', 'banana', 'pear']
        };
        const a = harness(legacy).manager;
        const b = harness(legacy).manager;
        assert.equal(a.getVocabStats().totalVocabSeconds, 600);
        assert.equal(a.getVocabStats().todayWords, 3);
        a.addVocabStudyDuration(20);
        b.addVocabStudyDuration(30);
        a.mergeFromCloud(b.exportData());
        a.mergeFromCloud(legacy);
        a.mergeFromCloud(JSON.stringify(legacy));
        assert.equal(a.getVocabStats().totalVocabSeconds, 650);
        assert.equal(a.getVocabStats().todayVocabSeconds, 150);
        const reloaded = harness(a.exportData()).manager;
        assert.equal(reloaded.getVocabStats().totalVocabSeconds, 650);
        reloaded.mergeFromCloud(a.exportData());
        assert.equal(reloaded.getVocabStats().totalVocabSeconds, 650);
    }],
    ['新旧云副本逆序到达不能减少已经累计的数据', () => {
        const a = harness().manager;
        const b = harness().manager;
        b.recordWordStudied('apple'); b.addVocabStudyDuration(20);
        const old = b.exportData();
        b.recordWordStudied('banana'); b.addVocabStudyDuration(30);
        a.mergeFromCloud(b.exportData());
        a.mergeFromCloud(old);
        assert.equal(a.getVocabStats().totalVocabSeconds, 50);
        assert.equal(a.getVocabStats().todayWords, 2);
    }],
    ['损坏云计数与特殊设备键不能破坏已有统计', () => {
        const manager = harness().manager;
        manager.addVocabStudyDuration(25);
        manager.recordWordStudied('apple');
        manager.mergeFromCloud({ version: 2,
            legacy: { totalSeconds: 'Infinity' },
            devices: { constructor: { days: { '2026-09-03': { seconds: 0, words: [] } } } }
        });
        assert.equal(manager.getVocabStats().totalVocabSeconds, 25);
        assert.equal(manager.getVocabStats().todayWords, 1);
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
