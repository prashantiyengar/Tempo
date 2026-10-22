import expand_sections  # noqa: F401  (opens collapsed dialog sections for older tests)
# Older tests create tasks without a category; turn off the one-time category prompt for them, and the
# "weekly review is ready" toast (tests run in the week of 19 Oct 2026).
NOASK = """(() => { try { const k = 'tempo:settings'; const s = JSON.parse(localStorage.getItem(k) || '{}');
  if (s.askCategory === undefined) s.askCategory = false; if (s.goalNotice === undefined) s.goalNotice = false; localStorage.setItem(k, JSON.stringify(s));
  if (!localStorage.getItem('tempo:lastReviewWeek')) localStorage.setItem('tempo:lastReviewWeek', JSON.stringify('2026-10-19')); } catch {} })();"""
