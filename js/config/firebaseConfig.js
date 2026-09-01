/**
 * IELTS Atlas - Firebase Configuration Manager
 * 管理 Firebase 项目配置，支持本地持久化存储与动态配置接入。
 */
(function(window) {
    'use strict';

    const STORAGE_KEY = 'ielts_atlas_firebase_config';

    // 默认内置配置（如未填入，则优先从 localStorage 读取或引导用户填入）
    const DEFAULT_CONFIG = {
        apiKey: "",
        authDomain: "",
        projectId: "",
        storageBucket: "",
        messagingSenderId: "",
        appId: ""
    };

    const FirebaseConfigManager = {
        /**
         * 获取当前生效的 Firebase 配置
         * @returns {Object|null}
         */
        getConfig() {
            try {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    if (this.isValidConfig(parsed)) {
                        return parsed;
                    }
                }
            } catch (e) {
                console.warn('[FirebaseConfig] Failed to parse stored config:', e);
            }

            if (this.isValidConfig(DEFAULT_CONFIG)) {
                return { ...DEFAULT_CONFIG };
            }
            return null;
        },

        /**
         * 校验配置是否有效（必须包含 apiKey 和 projectId）
         * @param {Object} config 
         * @returns {boolean}
         */
        isValidConfig(config) {
            return !!(config && typeof config === 'object' && config.apiKey && config.projectId);
        },

        /**
         * 保存自定义 Firebase 配置
         * @param {Object|string} config 
         * @returns {boolean}
         */
        saveConfig(config) {
            try {
                let parsedConfig = config;
                if (typeof config === 'string') {
                    // 支持直接粘贴 const firebaseConfig = { ... } 或 JSON 格式
                    const jsonMatch = config.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const sanitized = jsonMatch[0]
                            .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":')
                            .replace(/'/g, '"')
                            .replace(/,\s*}/g, '}');
                        parsedConfig = JSON.parse(sanitized);
                    } else {
                        parsedConfig = JSON.parse(config);
                    }
                }

                if (!this.isValidConfig(parsedConfig)) {
                    throw new Error('配置缺少必要的 apiKey 或 projectId 字段');
                }

                localStorage.setItem(STORAGE_KEY, JSON.stringify(parsedConfig));
                window.dispatchEvent(new CustomEvent('ielts:firebase-config-updated', { detail: parsedConfig }));
                return true;
            } catch (e) {
                console.error('[FirebaseConfig] Save error:', e);
                throw e;
            }
        },

        /**
         * 清除已保存的配置
         */
        clearConfig() {
            localStorage.removeItem(STORAGE_KEY);
            window.dispatchEvent(new CustomEvent('ielts:firebase-config-cleared'));
        },

        /**
         * 检查当前是否已配置好 Firebase
         * @returns {boolean}
         */
        isConfigured() {
            return this.getConfig() !== null;
        }
    };

    window.FirebaseConfigManager = FirebaseConfigManager;
})(window);
