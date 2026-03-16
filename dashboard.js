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

// ── Visual helpers ─────────────────────────────────────────────────────────
function bar(pct, len = 12) {
  const filled = Math.round(pct / 100 * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

function scoreEmoji(pct) {
  if (pct >= 80) return '🟢';
  if (pct >= 50) return '🟡';
  return '🔴';
}

function streakFire(n) {
  if (n === 0) return '—';
  if (n >= 30) return `${n} days 🔥🔥🔥`;
  if (n >= 14) return `${n} days 🔥🔥`;
  if (n >= 3)  return `${n} days 🔥`;
  return `${n} day${n > 1 ? 's' : ''}`;
}

// ── Exercise totals ────────────────────────────────────────────────────────
function exerciseTotal(habits, logs, keyword) {
  const matching = habits.filter(h => h.category === 'exercise' && h.habit_name.toLowerCase().includes(keyword));
  return matching.reduce((total, h) => {
    const target    = extractNumber(h.target_value) || 10;
    const habitLogs = logs.filter(l => l.habit_id === h.id);
    return total + habitLogs.reduce((s, l) => s + Math.round(target * l.completion_value / 100), 0);
  }, 0);
}

// ── Per-habit breakdown (week) ─────────────────────────────────────────────
function habitBreakdown(habits, logs, days) {
  return habits.map(h => {
    const hLogs = logs.filter(l => l.habit_id === h.id);
    const pct   = Math.round(hLogs.reduce((s, l) => s + l.completion_value, 0) / (days * 100) * 100);
    const dot   = pct >= 80 ? '🟢' : pct >= 50 ? '🟡' : '🔴';
    const streak = db.getHabitStreak(h.user_id, h.id);
    const streakStr = streak > 0 ? ` 🔥${streak}d` : '';
    return `${dot} ${h.habit_name}: *${pct}%*${streakStr}`;
  });
}

// ── Weekly consistency / completion ───────────────────────────────────────
function weeklyConsistency(habits, logs, dates) {
  if (!habits.length || !dates.length) return 0;
  const daysLogged = dates.filter(date => logs.some(l => l.date === date && l.completion_value > 0)).length;
  return Math.round(daysLogged / dates.length * 100);
}

function weeklyCompletion(habits, logs, dates) {
  if (!habits.length || !dates.length) return 0;
  const done100 = logs.filter(l => l.completion_value === 100).length;
  return Math.round(done100 / (habits.length * dates.length) * 100);
}

function worstHabit(habits, logs, days) {
  if (!habits.length) return null;
  const scored = habits.map(h => {
    const hLogs = logs.filter(l => l.habit_id === h.id);
    const score = hLogs.reduce((s, l) => s + l.completion_value, 0) / (days * 100) * 100;
    return { name: h.habit_name, score };
  }).sort((a, b) => a.score - b.score);
  const worst = scored[0];
  return worst.score < 50 ? worst : null;
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
  return habits.map(h => {
    const hLogs = logs.filter(l => l.habit_id === h.id);
    const score = hLogs.reduce((s, l) => s + l.completion_value, 0) / (days * 100) * 100;
    return { name: h.habit_name, score };
  }).sort((a, b) => b.score - a.score)[0]?.name || '—';
}

// ── Water average ──────────────────────────────────────────────────────────
function waterAverage(habits, logs, days) {
  const waterHabits = habits.filter(h => h.category === 'hydration');
  if (!waterHabits.length) return null;
  const target    = extractNumber(waterHabits.find(h => h.target_value)?.target_value) || 3;
  const waterLogs = logs.filter(l => waterHabits.some(h => h.id === l.habit_id));
  const avg       = waterLogs.reduce((s, l) => s + (target * l.completion_value / 100), 0) / days;
  return Math.round(avg * 10) / 10;
}

// ── Daily scores for the week (sparkline) ─────────────────────────────────
function weekSparkline(habits, logs, dates) {
  return dates.map(date => {
    const dayLogs = logs.filter(l => l.date === date);
    const pct     = habits.length
      ? Math.round(dayLogs.reduce((s, l) => s + l.completion_value, 0) / (habits.length * 100) * 100)
      : 0;
    if (pct >= 80) return '●';
    if (pct >= 50) return '◑';
    if (pct >  0)  return '○';
    return '·';
  }).join(' ');
}

// ── Main report ────────────────────────────────────────────────────────────
function generateReport(user) {
  const habits = db.getHabits(user.id);
  if (!habits.length) return '⚠️ No habits configured.\n\nUse /addhabit to get started.';

  const week  = dateRange(7,  user.timezone);
  const month = dateRange(30, user.timezone);
  const year  = dateRange(365, user.timezone);

  const weekLogs  = db.getRangeLogs(user.id, week.start,  week.end);
  const monthLogs = db.getRangeLogs(user.id, month.start, month.end);
  const yearLogs  = db.getRangeLogs(user.id, year.start,  year.end);

  const weekScore  = consistencyScore(habits, weekLogs,  7);
  const monthScore = consistencyScore(habits, monthLogs, 30);
  const yearScore  = consistencyScore(habits, yearLogs,  365);
  const streak     = currentStreak(habits, monthLogs, user.timezone);
  const best       = bestHabit(habits, monthLogs, 30);
  const worst      = worstHabit(habits, monthLogs, 30);
  const water      = waterAverage(habits, weekLogs, 7);
  const pushups    = exerciseTotal(habits, weekLogs, 'push');
  const squats     = exerciseTotal(habits, weekLogs, 'squat');
  const weekCons   = weeklyConsistency(habits, weekLogs, week.dates);
  const weekComp   = weeklyCompletion(habits, weekLogs, week.dates);

  const morningHabits = habits.filter(h => h.notify_morning);
  const nightHabits   = habits.filter(h => h.notify_night);
  const morningDays   = week.dates.filter(date => {
    const dl = weekLogs.filter(l => l.date === date && morningHabits.some(h => h.id === l.habit_id));
    return dl.length > 0 && dl.every(l => l.completion_value > 0);
  }).length;
  const nightDays     = week.dates.filter(date => {
    const dl = weekLogs.filter(l => l.date === date && nightHabits.some(h => h.id === l.habit_id));
    return dl.length > 0 && dl.every(l => l.completion_value > 0);
  }).length;

  const sparkline  = weekSparkline(habits, weekLogs, week.dates);
  const breakdown  = habitBreakdown(habits, weekLogs, 7);

  const lines = [
    `📊 *DASHBOARD*`,
    ``,
    `📅 *THIS WEEK*`,
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
    `${scoreEmoji(weekCons)} Consistency: *${weekCons}%* (days logged)`,
    `${scoreEmoji(weekComp)} Completion:  *${weekComp}%* (habits 100%)`,
    `\`${bar(weekScore)}\` `,
    ``,
    `_7-day activity:_`,
    `\`${sparkline}\``,
    `_● full  ◑ partial  · none_`,
    ``,
    `🌅 Morning: *${morningDays}/7* days`,
    `🌙 Night:   *${nightDays}/7* days`,
  ];

  if (pushups > 0 || squats > 0) {
    lines.push(``, `💪 *Exercise this week*`);
    if (pushups > 0) lines.push(`   Pushups: *${pushups} reps*`);
    if (squats  > 0) lines.push(`   Squats:  *${squats} reps*`);
  }

  if (water !== null) {
    lines.push(``, `💧 *Hydration avg:* ${water}L / day`);
  }

  lines.push(
    ``,
    `*Habit breakdown:*`,
    ...breakdown,
    ``,
    `📅 *THIS MONTH*`,
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
    `${scoreEmoji(monthScore)} Consistency: *${monthScore}%*`,
    `\`${bar(monthScore)}\` `,
    `🔥 Streak: *${streakFire(streak)}*`,
    `🏆 Best habit: *${best}*`,
  );
  if (worst) lines.push(`⚠️ Focus habit: *${worst.name}* (${Math.round(worst.score)}%)`);

  const personalBests = habits
    .map(h => ({ name: h.habit_name, best: db.getHabitPersonalBest(h.user_id, h.id) }))
    .filter(h => h.best >= 7);
  if (personalBests.length) {
    lines.push('', '🏆 *Personal Bests (7+ days)*');
    personalBests.forEach(h => lines.push(`  ${h.name}: ${h.best} days`));
  }

  lines.push(
    ``,
    `📅 *THIS YEAR*`,
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
    `${scoreEmoji(yearScore)} Overall: *${yearScore}%*`,
    `\`${bar(yearScore)}\` `,
  );

  return lines.join('\n');
}

module.exports = { generateReport };
