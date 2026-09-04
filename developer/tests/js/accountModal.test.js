#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../../js/components/accountModal.js', import.meta.url), 'utf8');
const node = () => ({ innerHTML: '', addEventListener() {}, querySelector() { return node(); } });
const document = { readyState: 'loading', addEventListener() {} };
const window = {};
vm.runInNewContext(source, { window, document, console, Date, setTimeout, confirm: () => false });
const payload = '<img src=x onerror="alert(1)">';
const username = '" onmouseover="alert(2)">' + payload;
const state = { currentUser: { username }, status: 'error', errorMessage: payload, lastSyncTime: null };
const profile = node();
window.AccountModal.renderProfileView(profile, state);
assert.ok(!profile.innerHTML.includes(payload), '用户名或错误消息不能形成真实 HTML 标签');
assert.ok(!profile.innerHTML.includes('title="' + username + '"'), '用户名不能退出 title 属性');
assert.ok(profile.innerHTML.includes('&lt;img'), '用户名或错误消息应以转义文本显示');
const form = node();
window.AccountModal.renderAuthForm(form, { errorMessage: payload });
assert.ok(!form.innerHTML.includes(payload), '登录错误消息不能形成真实 HTML 标签');
assert.ok(form.innerHTML.includes('&lt;img'), '登录错误消息应安全转义');
console.log(JSON.stringify({ status: 'pass', detail: '账号昵称与错误信息 HTML 注入回归通过' }));
