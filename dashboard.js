const db      = require('./database');
const { extractNumber, categoryEmoji } = require('./habits');

// ── Date range helpers ─────────────────────────────────────────────────────
function dateRange(days, timezone = 'America/Chicago') {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(d));
  }
  return { start: dates[0], end: dates[dates.length - 1], dates };
}

// ── Exercise totals ────────────────────────────────────────────────────────
function exerciseTotal(habits, logs, keyword) {
  const matching = habits.filter(h => h.category === 'exercise' && h.habit_name.toLowerCase().includes(keyword));
  return matching.reduce((total, h) => {
    const target = extractNumber(h.target_value) || 10;
    const habitLogs = logs.filter(l => l.habit_id === h.id);
    return total + habitLogs.reduce((s, l) => s + Math.round(target * l.completion_value / 100), 0);
  }, 0);
}

// ── Consistency score (0–100) ──────────────────────────────────────────────
function consistencyScore(habits, logs, days) {
  if (!habits.length) return 0;
  const total = logs.reduce((s, l) => s + l.completion_value, 0);
  return Math.min(100, Math.round(total / (days * habits.length * 100) * 100));
}

// ── Current streak (days with score ≥ 50%) ────────────────────────────────
function currentStreak(habits, logs, timezone) {
  if (!habits.length) return 0;
  const { dates } = dateRange(60, timezone);
  let streak = 0;
  for (const date of [...dates].reverse()) {
    const dayLogs = logs.filter(l => l.date === date);
    const score   = dayLogs.reduce((s, l) => s + l.completion_value, 0) / (habits.length * 100) * 100;
    if (score >= 50) streak++;
    else break;
  }
  return streak;
}

// ── Most consistent habit ──────────────────────────────────────────────────
function bestHabit(habits, logs, days) {
  if (!habits.length) return '—';
  const scored = habits.map(h => {
    const hLogs = logs.filter(l => l.habit_id === h.id);
    const score = hLogs.reduce((s, l) => s + l.completion_value, 0) / (days * 100) * 100;
    return { name: h.habit_name, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.name || '—';
}

// ── Water completion ───────────────────────────────────────────────────────
function waterAverage(habits, logs, days) {
  const waterHabits = habits.filter(h => h.category === 'hydration');
  if (!waterHabits.length) return null;
  const target = extractNumber(waterHabits.find(h => h.target_value)?.target_value) || 3;
  const waterLogs = logs.filter(l => waterHabits.some(h => h.id === l.habit_id));
  const avg = waterLogs.reduce((s, l) => s + (target * l.completion_value / 100), 0) / days;
  return Math.round(avg * 10) / 10;
}

// ── Main report ────────────────────────────────────────────────────────────
function generateReport(user) {
  const habits  = db.getHabits(user.id);
  if (!habits.length) return 'No habits configured. Use /addhabit.';

  const week  = dateRange(7,  user.timezone);
  const month = dateRange(30, user.timezone);

  const weekLogs  = db.getRangeLogs(user.id, week.start,  week.end);
  const monthLogs = db.getRangeLogs(user.id, month.start, month.end);

  const weekScore  = consistencyScore(habits, weekLogs,  7);
  const monthScore = consistencyScore(habits, monthLogs, 30);
  const streak     = currentStreak(habits, monthLogs, user.timezone);
  const best       = bestHabit(habits, monthLogs, 30);
  const water      = waterAverage(habits, weekLogs, 7);

  const pushups    = exerciseTotal(habits, weekLogs, 'push');
  const squats     = exerciseTotal(habits, weekLogs, 'squat');

  // Morning routine completion
  const morningHabits = habits.filter(h => h.notify_morning);
  const morningDays   = week.dates.filter(date => {
    const dayLogs = weekLogs.filter(l => l.date === date && morningHabits.some(h => h.id === l.habit_id));
    return dayLogs.length > 0 && dayLogs.every(l => l.completion_value > 0);
  }).length;

  const exerciseLines = [
    pushups > 0 ? `Pushups: ${pushups}` : null,
    squats  > 0 ? `Squats: ${squats}`   : null,
  ].filter(Boolean).join('\n');

  return [
    `*WEEK*`,
    `Morning routine: ${morningDays} / 7`,
    exerciseLines,
    water !== null ? `Water avg: ${water}L` : null,
    `Consistency: *${weekScore}%*`,
    ``,
    `*MONTH*`,
    `Consistency: *${monthScore}%*`,
    `Streak: ${streak} days`,
    `Best habit: ${best}`,
  ].filter(l => l !== null).join('\n');
}

module.exports = { generateReport };
