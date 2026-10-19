# Older tests create tasks without a category; turn off the one-time category prompt for them.
NOASK = """(() => { try { const k = 'tempo:settings'; const s = JSON.parse(localStorage.getItem(k) || '{}');
  if (s.askCategory === undefined) { s.askCategory = false; localStorage.setItem(k, JSON.stringify(s)); } } catch {} })();"""
