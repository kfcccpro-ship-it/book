'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../simple/course-management-rules.js');

const groups = [
  { key: 'book_a', name: '여신 기본' },
  { key: 'book_b', name: '수신기본' }
];

assert.equal(rules.representativeNameConflict(groups, 'book_a', ' 수신 기본 ')?.key, 'book_b');
assert.equal(rules.representativeNameConflict(groups, 'book_a', '여신기본'), null);

const courses = [
  { id: 'run_1', course_name: '여신 기본 1차', course_run_label: '1차' },
  { id: 'run_2', course_name: '여신 기본 7차(1주차)', course_run_label: '7차(1주차)' },
  { id: 'ledger', course_name: '[재고원장] 여신 기본', inventory_ledger_only: true }
];

assert.equal(rules.runLabelConflict(courses, 'run_2', '제 1차', '여신 기본')?.id, 'run_1');
assert.equal(rules.runLabelConflict(courses, 'run_2', '7차 ( 1주차 )', '여신 기본'), null);

const subBooks = [
  { id: 'canonical', course_group_key: 'book_a', course_group_name: '과거 이름' },
  { id: 'legacy-name', course_group_name: '여신 기본' },
  { id: 'legacy-key-as-name', course_group_key: '여신기본' },
  { id: 'other', course_group_key: 'book_b', course_group_name: '수신기본' }
];

assert.deepEqual(
  rules.linkedSubBooksForRename(subBooks, 'book_a', '여신 기본').map(book => book.id),
  ['canonical', 'legacy-name', 'legacy-key-as-name']
);

assert.equal(rules.inferRunLabel({ course_name: '여신 기본 3차' }, '여신 기본'), '3차');

const root = path.resolve(__dirname, '..');
const loader = fs.readFileSync(path.join(root, 'simple/simple-inventory-service.js'), 'utf8');
const management = fs.readFileSync(path.join(root, 'simple/course-management.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'simple/index.html'), 'utf8');
const rulesLoad = loader.indexOf("loadScript('./course-management-rules.js?v=1'");
const workflowLoad = loader.indexOf("loadScript('./course-workflow-simple-v3.js?v=4'");
const managementLoad = loader.indexOf("loadScript('./course-management.js?v=2'");

assert.ok(rulesLoad >= 0 && rulesLoad < workflowLoad && workflowLoad < managementLoad);
assert.match(index, /simple-inventory-service\.js\?v=7/);
assert.match(management, /course_group_key:\s*group\.key/);

const renameBody = management.slice(
  management.indexOf('async function renameRepresentative'),
  management.indexOf('async function updateRun')
);
assert.doesNotMatch(renameBody, /stock_quantity\s*:/);
assert.doesNotMatch(renameBody, /released_quantity\s*:/);
assert.doesNotMatch(renameBody, /inventory_adjustment\s*:/);

console.log('course-management-rules: PASS');
