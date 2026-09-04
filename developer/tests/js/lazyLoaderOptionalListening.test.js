#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const source = fs.readFileSync(path.join(repoRoot, 'js/runtime/lazyLoader.js'), 'utf8');

const requestedScripts = [];
const head = {
    appendChild(script) {
        script.parentNode = head;
        requestedScripts.push(String(script.src || ''));
        queueMicrotask(() => script.onerror?.({ message: '404' }));
        return script;
    },
    removeChild(script) {
        script.parentNode = null;
        return script;
    }
};
const documentStub = {
    baseURI: 'https://example.test/app/index.html',
    head,
    querySelectorAll() { return []; },
    createElement(tagName) {
        assert.strictEqual(tagName, 'script');
        return { src: '', async: false, onload: null, onerror: null, parentNode: null };
    }
};
const quietConsole = {
    log() {},
    warn() {},
    error() {}
};
const windowStub = {
    document: documentStub,
    console: quietConsole,
    location: {
        origin: 'https://example.test',
        search: '',
        href: 'https://example.test/app/index.html'
    }
};
const sandbox = {
    window: windowStub,
    document: documentStub,
    console: quietConsole,
    URL,
    URLSearchParams,
    Promise,
    Set,
    queueMicrotask
};
sandbox.globalThis = windowStub;
vm.runInContext(source, vm.createContext(sandbox), { filename: 'js/runtime/lazyLoader.js' });

windowStub.AppLazyLoader.markProvided(['assets/generated/reading-exams/manifest.js']);
await windowStub.AppLazyLoader.ensureGroup('exam-data');
await windowStub.AppLazyLoader.ensureGroup('exam-data');
await Promise.all([
    windowStub.AppLazyLoader.ensureGroup('exam-data'),
    windowStub.AppLazyLoader.ensureGroup('exam-data')
]);

const manifestRequests = requestedScripts.filter((url) => url.includes('assets/generated/listening-exams/manifest.js'));
assert.strictEqual(manifestRequests.length, 1, '缺失的可选听力 manifest 在同一页面生命周期内只应探测一次');
assert.strictEqual(
    windowStub.__defaultListeningLibraryAvailabilityReason,
    'manifest-missing',
    '缺失 manifest 应稳定记录为不可用，而不是反复回到 pending'
);

async function checkAssetVersion({ search = '', entryVersion = '', file = 'js/bundles/more.bundle.js' }, expectedVersion) {
    const requests = [];
    const doc = {
        ...documentStub,
        currentScript: entryVersion ? { src: `https://example.test/app/js/bundles/runtime-entry.bundle.js?v=${entryVersion}` } : null,
        head: {
            appendChild(script) {
                requests.push(script.src);
                queueMicrotask(() => script.onload?.());
                return script;
            }
        }
    };
    const win = {
        document: doc, console: quietConsole,
        location: { origin: 'https://example.test', search, href: `https://example.test/app/index.html${search}` }
    };
    vm.runInContext(source, vm.createContext({ ...sandbox, window: win, globalThis: win, document: doc }));
    win.AppLazyLoader.registerGroup('version-test', [file]);
    await win.AppLazyLoader.ensureGroup('version-test');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(new URL(requests[0], doc.baseURI).searchParams.get('v'), expectedVersion);
}

await checkAssetVersion({ entryVersion: 'release-20260903' }, 'release-20260903');
await checkAssetVersion({ search: '?v=explicit-preview', entryVersion: 'release-20260903' }, 'explicit-preview');
await checkAssetVersion({ search: '?v=explicit-preview' }, 'explicit-preview');
await checkAssetVersion({}, null);
await checkAssetVersion({ entryVersion: 'release-20260903', file: 'https://cdn.example.test/external.js?v=vendor-version' }, 'vendor-version');

console.log(JSON.stringify({
    status: 'pass',
    detail: 'optional listening failure is cached; 5 asset version fallback/precedence checks pass',
    manifestRequests: manifestRequests.length
}, null, 2));
