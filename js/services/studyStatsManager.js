/** Vocabulary statistics: per-device daily counters, idempotent cloud merges. */
(function(window) {
    'use strict';
    const STORAGE_KEY = 'ielts_study_stats_v1';
    const DEVICE_KEY = 'ielts_study_stats_device_id';
    let renderRevision = 0;
    let initialized = false;
    const unique = values => Array.from(new Set((Array.isArray(values) ? values : []).filter(v => typeof v === 'string' && v)));
    const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const todayKey = () => {
        const d = new Date();
        return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    };
    function empty() { return { version: 2, legacy: { totalSeconds: 0, words: [], days: [], daily: {} }, devices: {} }; }
    function parse(value) {
        if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return empty(); } }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return empty();
        if (value.version === 2) return value;
        const result = empty();
        result.legacy.totalSeconds = number(value.totalVocabDurationSeconds);
        result.legacy.words = unique(value.totalVocabWordsLearnedSet);
        result.legacy.days = unique(value.studyDates);
        if (/^\d{4}-\d{2}-\d{2}$/.test(value.todayDate || '')) {
            result.legacy.daily[value.todayDate] = { count: number(value.todayVocabWordsCount), seconds: number(value.todayVocabDurationSeconds) };
        }
        return result;
    }
    function merge(left, right) {
        const result = empty();
        for (const data of [parse(left), parse(right)]) {
            const legacy = data.legacy || {};
            result.legacy.totalSeconds = Math.max(result.legacy.totalSeconds, number(legacy.totalSeconds));
            result.legacy.words = unique(result.legacy.words.concat(unique(legacy.words)));
            result.legacy.days = unique(result.legacy.days.concat(unique(legacy.days)));
            for (const [day, value] of Object.entries(legacy.daily || {})) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
                const current = result.legacy.daily[day] || { count: 0, seconds: 0 };
                result.legacy.daily[day] = { count: Math.max(current.count, number(value?.count)), seconds: Math.max(current.seconds, number(value?.seconds)) };
            }
            for (const [device, value] of Object.entries(data.devices || {})) {
                if (!/^[a-zA-Z0-9-]{1,100}$/.test(device) || ['constructor', 'prototype', '__proto__'].includes(device)) continue;
                const target = result.devices[device] || (result.devices[device] = { days: {} });
                for (const [day, counter] of Object.entries(value?.days || {})) {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
                    const current = target.days[day] || { seconds: 0, words: [] };
                    target.days[day] = { seconds: Math.max(current.seconds, number(counter?.seconds)), words: unique(current.words.concat(unique(counter?.words))) };
                }
            }
        }
        return result;
    }
    function read() {
        try { return merge(empty(), localStorage.getItem(STORAGE_KEY)); }
        catch (_) { return empty(); }
    }
    function save(data, notify = true) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        if (notify) window.dispatchEvent(new CustomEvent('ielts:learning-state-changed'));
    }
    function deviceId() {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id) {
            id = window.crypto?.randomUUID?.() || 'device-' + Date.now() + '-' + Math.random().toString(36).slice(2);
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    }
    function mutateToday(callback) {
        const data = read();
        const id = deviceId();
        const device = data.devices[id] || (data.devices[id] = { days: {} });
        const counter = device.days[todayKey()] || (device.days[todayKey()] = { seconds: 0, words: [] });
        callback(counter);
        save(data);
    }
    const StudyStatsManager = {
        init() {
            if (initialized) return;
            initialized = true;
            window.addEventListener('ielts:data-synced-from-cloud', () => this.render());
            window.addEventListener('focus', () => this.render());
            document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => this.render()));
            this.render();
        },
        ensureDayRollover() { /* Separate date buckets need no destructive reset. */ },
        exportData() { return read(); },
        mergeFromCloud(raw) {
            const result = merge(read(), raw);
            save(result, false);
            this.render();
            return result;
        },
        addVocabStudyDuration(seconds) {
            if (!Number.isFinite(seconds) || seconds <= 0) return;
            mutateToday(counter => { counter.seconds += Math.round(seconds); });
            this.render();
        },
        recordWordStudied(word) {
            const key = String(word || '').trim().toLowerCase();
            if (!key) return;
            mutateToday(counter => { counter.words = unique(counter.words.concat(key)); });
            this.render();
        },
        getVocabStats() {
            const data = read();
            const today = todayKey();
            let seconds = data.legacy.totalSeconds;
            let todaySeconds = number(data.legacy.daily[today]?.seconds);
            const words = new Set(data.legacy.words);
            const todayWords = new Set();
            const days = new Set(data.legacy.days);
            for (const device of Object.values(data.devices)) {
                for (const [day, counter] of Object.entries(device.days)) {
                    seconds += counter.seconds;
                    if (counter.seconds || counter.words.length) days.add(day);
                    counter.words.forEach(word => words.add(word));
                    if (day === today) {
                        todaySeconds += counter.seconds;
                        counter.words.forEach(word => todayWords.add(word));
                    }
                }
            }
            return { todayWords: number(data.legacy.daily[today]?.count) + todayWords.size,
                totalWords: words.size, todayVocabSeconds: todaySeconds,
                totalVocabSeconds: seconds, studyDates: Array.from(days).sort() };
        },
        async render() {
            const revision = ++renderRevision;
            try {
                const vocab = this.getVocabStats();
                const today = document.getElementById('today-vocab-words');
                const total = document.getElementById('total-vocab-words');
                if (today) today.textContent = vocab.todayWords;
                if (total) total.textContent = vocab.totalWords;
                let practiceSeconds = 0;
                if (window.AppData?.practice) {
                    await window.AppData.ready;
                    const records = await window.AppData.practice.list();
                    practiceSeconds = (Array.isArray(records) ? records : []).reduce((sum, rec) => sum + number(rec.duration), 0);
                }
                const duration = document.getElementById('study-time');
                if (duration && revision === renderRevision) duration.textContent = Math.round((practiceSeconds + vocab.totalVocabSeconds) / 60);
            } catch (error) { console.warn('[StudyStats] Render failed:', error); }
        }
    };
    window.StudyStatsManager = StudyStatsManager;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => StudyStatsManager.init());
    else StudyStatsManager.init();
})(window);
