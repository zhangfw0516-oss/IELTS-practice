/**
 * IELTS Atlas - Study Stats Manager (学习记录与时长综合统计管理器)
 * 深度融合真题练习记录（阅读/听力）与背单词时长/词汇数据，统一注入系统原生卡片。
 */
(function(window) {
    'use strict';

    const STORAGE_KEY = 'ielts_study_stats_v1';

    function getTodayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function getRawStats() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.warn('[StudyStats] Failed to parse stored stats:', e);
        }
        return {
            todayDate: getTodayKey(),
            todayVocabDurationSeconds: 0,
            todayVocabWordsCount: 0,
            totalVocabDurationSeconds: 0,
            studyDates: [], // 记录背单词/打卡的日期集合
            totalVocabWordsLearnedSet: []
        };
    }

    function saveRawStats(stats) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
        } catch (e) {
            console.warn('[StudyStats] Failed to save stats:', e);
        }
    }

    const StudyStatsManager = {
        init() {
            this.ensureDayRollover();
            this.render();

            // 监听数据同步/练习完成事件
            window.addEventListener('ielts:data-synced-from-cloud', () => this.render());
            window.addEventListener('focus', () => this.ensureDayRollover());
        },

        ensureDayRollover() {
            const stats = getRawStats();
            const today = getTodayKey();
            if (stats.todayDate !== today) {
                stats.todayDate = today;
                stats.todayVocabDurationSeconds = 0;
                stats.todayVocabWordsCount = 0;
                saveRawStats(stats);
            }
        },

        /**
         * 记录背单词学习时间（秒）
         */
        addVocabStudyDuration(seconds) {
            if (!seconds || seconds <= 0) return;
            this.ensureDayRollover();
            const stats = getRawStats();
            const today = getTodayKey();

            stats.todayVocabDurationSeconds = (stats.todayVocabDurationSeconds || 0) + Math.round(seconds);
            stats.totalVocabDurationSeconds = (stats.totalVocabDurationSeconds || 0) + Math.round(seconds);

            if (!Array.isArray(stats.studyDates)) stats.studyDates = [];
            if (!stats.studyDates.includes(today)) {
                stats.studyDates.push(today);
            }

            saveRawStats(stats);
            this.render();
        },

        /**
         * 记录背诵/复习了一个单词
         */
        recordWordStudied(word) {
            if (!word) return;
            this.ensureDayRollover();
            const stats = getRawStats();
            const today = getTodayKey();

            stats.todayVocabWordsCount = (stats.todayVocabWordsCount || 0) + 1;

            if (!Array.isArray(stats.studyDates)) stats.studyDates = [];
            if (!stats.studyDates.includes(today)) {
                stats.studyDates.push(today);
            }

            if (!Array.isArray(stats.totalVocabWordsLearnedSet)) {
                stats.totalVocabWordsLearnedSet = [];
            }
            const normalized = String(word).trim().toLowerCase();
            if (normalized && !stats.totalVocabWordsLearnedSet.includes(normalized)) {
                stats.totalVocabWordsLearnedSet.push(normalized);
            }

            saveRawStats(stats);
            this.render();
        },

        /**
         * 获取累积的背单词时长（秒）
         */
        getVocabStats() {
            this.ensureDayRollover();
            const stats = getRawStats();

            let totalWords = Array.isArray(stats.totalVocabWordsLearnedSet) ? stats.totalVocabWordsLearnedSet.length : 0;
            try {
                if (window.VocabStore && typeof window.VocabStore.getLearnedCount === 'function') {
                    const storeCount = window.VocabStore.getLearnedCount();
                    if (storeCount > totalWords) totalWords = storeCount;
                }
            } catch (_) {}

            return {
                todayWords: stats.todayVocabWordsCount || 0,
                totalWords: totalWords,
                todayVocabSeconds: stats.todayVocabDurationSeconds || 0,
                totalVocabSeconds: stats.totalVocabDurationSeconds || 0,
                studyDates: Array.isArray(stats.studyDates) ? stats.studyDates : []
            };
        },

        /**
         * 渲染统计卡片到页面原生 HeroUI 卡片网格
         */
        async render() {
            try {
                const vocab = this.getVocabStats();

                // 1. 渲染今日背词与累计掌握词汇
                const todayWordsEl = document.getElementById('today-vocab-words');
                if (todayWordsEl) {
                    todayWordsEl.textContent = vocab.todayWords;
                }

                const totalWordsEl = document.getElementById('total-vocab-words');
                if (totalWordsEl) {
                    totalWordsEl.textContent = vocab.totalWords;
                }

                // 2. 预先更新背单词累计时长（避免等待 AppData 异步延迟）
                const studyTimeEl = document.getElementById('study-time');
                if (studyTimeEl) {
                    studyTimeEl.textContent = Math.round(vocab.totalVocabSeconds / 60);
                }

                // 3. 如果存在 AppData，抓取真实练习记录做题时长并累加背单词时长
                if (window.AppData && window.AppData.practice) {
                    await window.AppData.ready;
                    const summaries = await window.AppData.practice.list();
                    if (Array.isArray(summaries)) {
                        let practiceTotalDuration = 0;
                        summaries.forEach(rec => {
                            practiceTotalDuration += (Number(rec.duration) || 0);
                        });

                        const combinedMinutes = Math.round((practiceTotalDuration + vocab.totalVocabSeconds) / 60);
                        if (studyTimeEl) {
                            studyTimeEl.textContent = combinedMinutes;
                        }
                    }
                }
            } catch (e) {
                console.warn('[StudyStats] Render error:', e);
            }
        }
    };

    window.StudyStatsManager = StudyStatsManager;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            StudyStatsManager.init();
            document.querySelectorAll('.nav-btn').forEach(btn => {
                btn.addEventListener('click', () => setTimeout(() => StudyStatsManager.render(), 80));
            });
        });
    } else {
        StudyStatsManager.init();
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => setTimeout(() => StudyStatsManager.render(), 80));
        });
    }
})(window);
