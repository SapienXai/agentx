const { parseStepProgress } = require('./progress.js');

test('parseStepProgress extracts step numbers', () => {
  expect(parseStepProgress('--- Step 3 / 10 ---')).toEqual({ current: 3, total: 10 });
});

test('parseStepProgress returns null for other text', () => {
  expect(parseStepProgress('nothing here')).toBeNull();
});
