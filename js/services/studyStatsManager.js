/**
 * IELTS Atlas - Study Stats Manager (学习记录与时长综合统计管理器)
 * 融合真题练习时长与背单词时长，统计今日与累计学习词数及学习总时长。
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
            totalVocabWordsLearnedSet: [] // 记录所有背过的唯一词汇
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
            stats.todayVocabDurationSeconds = (stats.todayVocabDurationSeconds || 0) + Math.round(seconds);
            stats.totalVocabDurationSeconds = (stats.totalVocabDurationSeconds || 0) + Math.round(seconds);
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
            stats.todayVocabWordsCount = (stats.todayVocabWordsCount || 0) + 1;

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
         * 计算综合数据（练习做题 + 背单词）
         */
        async calculateCombinedStats() {
            this.ensureDayRollover();
            const stats = getRawStats();
            const today = getTodayKey();

            let practiceTodaySeconds = 0;
            let practiceTotalSeconds = 0;
            let practiceStreak = 0;

            // 1. 读取真题练习记录
            try {
                if (window.AppData && window.AppData.practice) {
                    await window.AppData.ready;
                    const summaries = await window.AppData.practice.list();
                    if (Array.isArray(summaries)) {
                        summaries.forEach(rec => {
                            const duration = Number(rec.duration) || 0;
                            practiceTotalSeconds += duration;

                            // 检查是否为今日做题
                            const recDate = rec.timestamp || rec.date || rec.createdAt;
                            if (recDate) {
                                const d = new Date(recDate);
                                const dKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                                if (dKey === today) {
                                    practiceTodaySeconds += duration;
                                }
                            }
                        });
                    }
                }
            } catch (e) {
                console.warn('[StudyStats] Error reading practice summaries:', e);
            }

            // 2. 读取词库掌握词数
            let totalWordsLearned = Array.isArray(stats.totalVocabWordsLearnedSet) ? stats.totalVocabWordsLearnedSet.length : 0;
            try {
                if (window.VocabStore && typeof window.VocabStore.getLearnedCount === 'function') {
                    const storeCount = window.VocabStore.getLearnedCount();
                    if (storeCount > totalWordsLearned) totalWordsLearned = storeCount;
                }
            } catch (_) {}

            const todayTotalMinutes = Math.round(((stats.todayVocabDurationSeconds || 0) + practiceTodaySeconds) / 60);
            const allTimeTotalMinutes = Math.round(((stats.totalVocabDurationSeconds || 0) + practiceTotalSeconds) / 60);

            return {
                todayWords: stats.todayVocabWordsCount || 0,
                totalWords: totalWordsLearned,
                todayDurationMinutes: todayTotalMinutes,
                totalDurationMinutes: allTimeTotalMinutes
            };
        },

        /**
         * 渲染统计卡片到页面
         */
        async render() {
            try {
                const combined = await this.calculateCombinedStats();

                const todayWordsEl = document.getElementById('study-overview-today-words');
                if (todayWordsEl) todayWordsEl.textContent = combined.todayWords;

                const totalWordsEl = document.getElementById('study-overview-total-words');
                if (totalWordsEl) totalWordsEl.textContent = combined.totalWords;

                const todayDurationEl = document.getElementById('study-overview-today-duration');
                if (todayDurationEl) todayDurationEl.textContent = combined.todayDurationMinutes;

                const totalDurationEl = document.getElementById('study-overview-total-duration');
                if (totalDurationEl) totalDurationEl.textContent = combined.totalDurationMinutes;

                // 同时更新传统卡片里的学习时长 (包含背单词时长)
                const studyTimeEl = document.getElementById('study-time');
                if (studyTimeEl) {
                    studyTimeEl.textContent = combined.totalDurationMinutes;
                }
            } catch (e) {
                console.warn('[StudyStats] Render error:', e);
            }
        }
    };

    window.StudyStatsManager = StudyStatsManager;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => StudyStatsManager.init());
    } else {
        StudyStatsManager.init();
    }
})(window);
