function parseStepProgress(line) {
  const match = /--- Step (\d+) \/ (\d+) ---/.exec(line);
  return match ? { current: parseInt(match[1]), total: parseInt(match[2]) } : null;
}

if (typeof module !== 'undefined') {
  module.exports = { parseStepProgress };
} else {
  window.parseStepProgress = parseStepProgress;
}
