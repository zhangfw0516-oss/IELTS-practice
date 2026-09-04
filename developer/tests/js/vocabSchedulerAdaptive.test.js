#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(path.join(root, 'js/core/vocabScheduler.js'), 'utf8');
const window = {};
vm.runInContext(source, vm.createContext({ window, globalThis: window, Date, Object, Math, Number }), {
    filename: 'js/core/vocabScheduler.js'
});
const scheduler = window.VocabScheduler;
const start = new Date('2026-09-04T00:00:00.000Z');
const minutesAfter = (result) => Math.round((new Date(result.nextReview) - start) / 60000);

const firstGood = scheduler.scheduleAfterResult({ id: 'new-good', word: 'retain' }, 'good', start);
assert.equal(firstGood.memoryState, 'learning');
assert.equal(firstGood.learningStep, 0);
assert.equal(minutesAfter(firstGood), 10);
assert.ok(firstGood.lastReviewed, 'new words must receive a real review timestamp');

const firstEasy = scheduler.scheduleAfterResult({ id: 'new-easy', word: 'known' }, 'easy', start);
assert.equal(firstEasy.learningStep, 1);
assert.equal(minutesAfter(firstEasy), 720);

const secondGood = scheduler.scheduleAfterResult(firstGood, 'good', start);
assert.equal(secondGood.memoryState, 'learning');
assert.equal(secondGood.learningStep, 1);
assert.equal(minutesAfter(secondGood), 720);

const graduated = scheduler.scheduleAfterResult(secondGood, 'good', start);
assert.equal(graduated.memoryState, 'review');
assert.equal(graduated.reviewStep, 0);
assert.equal(graduated.interval, 1);
assert.equal(minutesAfter(graduated), 1440);

const dayThree = scheduler.scheduleAfterResult(graduated, 'good', start);
assert.equal(dayThree.reviewStep, 1);
assert.equal(dayThree.interval, 3);
assert.equal(minutesAfter(dayThree), 3 * 1440);

const skipToDayFourteen = scheduler.scheduleAfterResult(dayThree, 'easy', start);
assert.equal(skipToDayFourteen.reviewStep, 3);
assert.equal(skipToDayFourteen.interval, 14);

const hardReview = scheduler.scheduleAfterResult({ ...dayThree, interval: 7 }, 'hard', start);
assert.equal(hardReview.memoryState, 'review');
assert.equal(hardReview.interval, 4);

let forgotten = scheduler.scheduleAfterResult({ ...dayThree, correctCount: 9 }, 'wrong', start);
assert.equal(forgotten.memoryState, 'relearning');
assert.equal(forgotten.correctCount, 9, 'a lapse must not erase lifetime learning history');
assert.equal(minutesAfter(forgotten), 10);
for (let index = 1; index < scheduler.LEECH_THRESHOLD; index += 1) {
    forgotten = scheduler.scheduleAfterResult(forgotten, 'wrong', start);
}
assert.equal(forgotten.leech, true);
assert.equal(forgotten.lapses, scheduler.LEECH_THRESHOLD);

console.log(JSON.stringify({ status: 'pass', detail: 'adaptive Ebbinghaus scheduler regression passed' }));
