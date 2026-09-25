import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_TASKS } from '../modules/reply/reply-tasks.js';
import { assertStructuredResult } from '../shared.js';

const complete = {
  draft: 'I agree with your point.', backtranslation: '我同意你的观点。',
  meaningRisk: '无明显风险。', suggestions: [], followUp: [], note: ''
};

test('reply tasks reject an empty mandatory answer after schema validation', () => {
  for (const name of ['GENERATE_REPLY', 'CHECK_REPLY']) {
    const task = REPLY_TASKS[name];
    const checked = assertStructuredResult({ ...complete }, task.schema, name);
    assert.equal(task.validate(checked).draft, complete.draft);
    for (const key of ['draft', 'backtranslation', 'meaningRisk']) {
      assert.throws(() => task.validate({ ...checked, [key]: ' ' }), /为空/);
    }
  }
});
