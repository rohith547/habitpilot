const db      = require('./database');
const { extractNumber, categoryEmoji } = require('./habits');

// ── Date helpers ──────────────────────────────────────────────────────────
function dateRange(days, timezone = 'America/Chicago') {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(d));
  }
  return { start: dates[0], end: dates[dates.length - 1], dates };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

function weekLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Visual helpers ─────────────────────────────────────────────────────────
function bar(pct, len = 10) {
  const filled = Math.round(pct / 100 * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

function sparkBlock(pct) {
  if (pct === 0)   return '·';
  if (pct <= 20)   return '▂';
  if (pct <= 40)   return '▃';
  if (pct <= 60)   return '▅';
  if (pct <= 80)   return '▆';
  if (pct < 100)   return '▇';
  return '█';
}

function trendArrow(curr, prev) {
  const diff = curr - prev;
  if (diff > 10)  return `📈 +${diff}%`;
  if (diff < -10) return `📉 ${diff}%`;
  return `➡️ on track`;
}

function scoreEmoji(pct) {
  if (pct >= 80) return '🟢';
  if (pct >= 50) return '🟡';
  return '🔴';
}

function streakFire(n) {
  if (n === 0)  return '—';
  if (n >= 30)  return `${n} days 🔥🔥🔥`;
  if (n >= 14)  return `${n} days 🔥🔥`;
  if (n >= 3)   return `${n} days 🔥`;
  return `${n} day${n > 1 ? 's' : ''}`;
}

// ── Score calculators ──────────────────────────────────────────────────────
function dayScore(habits, logs, date) {
  if (!habits.length) return 0;
  const dayLogs = logs.filter(l => l.date === date);
  return Math.round(dayLogs.reduce((s, l) => s + l.completion_value, 0) / (habits.length * 100) * 100);
}

function periodScore(habits, logs, dates) {
  if (!habits.length || !dates.length) return 0;
  const activeDates = dates.filter(d => logs.some(l => l.date === d));
  if (!activeDates.length) return 0;
  const total = activeDates.reduce((s, d) => s + dayScore(habits, logs, d), 0);
  return Math.round(total / activeDates.length);
}

function categoryScore(habits, logs, dates, category) {
  const catHabits = habits.filter(h => h.category === category);
  if (!catHabits.length) return null;
  const activeDates = dates.filter(d => logs.some(l => l.date === d));
  if (!activeDates.length) return 0;
  const total = activeDates.reduce((s, date) => {
    const dayLogs = logs.filter(l => l.date === date && catHabits.some(h => h.id === l.habit_id));
    return s + (dayLogs.reduce((a, l) => a + l.completion_value, 0) / (catHabits.length * 100) * 100);
  }, 0);
  return Math.round(total / activeDates.length);
}

// ── Streaks ────────────────────────────────────────────────────────────────
function currentStreak(habits, allLogs, timezone) {
  if (!habits.length) return 0;
  const { dates } = dateRange(90, timezone);
  let streak = 0;
  for (const date of [...dates].reverse()) {
    const score = dayScore(habits, allLogs, date);
    if (score >= 50) streak++;
    else break;
  }
  return streak;
}

function longestStreak(habits, logs) {
  if (!habits.length || !logs.length) return 0;
  const allDates = [...new Set(logs.map(l => l.date))].sort();
  let best = 0, cur = 0;
  for (let i = 0; i < allDates.length; i++) {
    const score = dayScore(habits, logs, allDates[i]);
    if (score >= 50) {
      cur++;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}

// ── Day-of-week analysis ───────────────────────────────────────────────────
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dowAnalysis(habits, logs) {
  const scores = Array(7).fill(0);
  const counts = Array(7).fill(0);
  for (const date of [...new Set(logs.map(l => l.date))]) {
    const dow = new Date(date + 'T12:00:00').getDay();
    const score = dayScore(habits, logs, date);
    scores[dow] += score;
    counts[dow]++;
  }
  const avgs = scores.map((s, i) => counts[i] > 0 ? Math.round(s / counts[i]) : null);
  const valid = avgs.map((v, i) => ({ day: DOW[i], avg: v })).filter(d => d.avg !== null);
  if (valid.length < 3) return null;
  const best  = valid.reduce((a, b) => b.avg > a.avg ? b : a);
  const worst = valid.reduce((a, b) => b.avg < a.avg ? b : a);
  return { best, worst };
}

// ── Best week ever ─────────────────────────────────────────────────────────
function bestWeekEver(habits, logs) {
  if (!logs.length) return null;
  const allDates = [...new Set(logs.map(l => l.date))].sort();
  const first = allDates[0];
  const last  = allDates[allDates.length - 1];
  let bestScore = 0, bestWeekStart = null;
  let cursor = first;
  while (cursor <= last) {
    const weekDates = Array.from({ length: 7 }, (_, i) => addDays(cursor, i));
    const weekLogs  = logs.filter(l => weekDates.includes(l.date));
    const activeDates = weekDates.filter(d => weekLogs.some(l => l.date === d));
    if (activeDates.length >= 3) {
      const score = periodScore(habits, weekLogs, activeDates);
      if (score > bestScore) { bestScore = score; bestWeekStart = cursor; }
    }
    cursor = addDays(cursor, 7);
  }
  return bestWeekStart ? { score: bestScore, weekStart: bestWeekStart } : null;
}

// ── Per-habit sparkline (7 days) ───────────────────────────────────────────
function habitSparkline(habit, logs, dates) {
  return dates.map(date => {
    const log = logs.find(l => l.habit_id === habit.id && l.date === date);
    return sparkBlock(log ? log.completion_value : 0);
  }).join('');
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

// ── Consistency score (kept for backward compat) ───────────────────────────
function consistencyScore(habits, logs, days) {
  if (!habits.length) return 0;
  const total = logs.reduce((s, l) => s + l.completion_value, 0);
  return Math.min(100, Math.round(total / (days * habits.length * 100) * 100));
}

// ── Main report ────────────────────────────────────────────────────────────
function generateReport(user) {
  const habits = db.getHabits(user.id);
  if (!habits.length) return '⚠️ No habits configured.\n\nUse /addhabit to get started.';

  const tz   = user.timezone;
  const week = dateRange(7,  tz);
  const prev = dateRange(14, tz); // last 14 days = this week + last week
  const long = dateRange(90, tz); // 90 days for streaks / analysis

  const weekLogs  = db.getRangeLogs(user.id, week.start, week.end);
  const prevLogs  = db.getRangeLogs(user.id, prev.start, addDays(week.start, -1));
  const longLogs  = db.getRangeLogs(user.id, long.start, long.end);

  // First day ever logged
  const allLogs     = db.getRangeLogs(user.id, '2020-01-01', week.end);
  const firstLogDate = allLogs.length ? allLogs[0].date : week.start;
  const daysSinceStart = Math.max(1, daysBetween(firstLogDate, week.end) + 1);
  const daysActive    = [...new Set(allLogs.map(l => l.date))].length;

  // Scores
  const thisWeekScore = periodScore(habits, weekLogs, week.dates);
  const lastWeekScore = periodScore(habits, prevLogs, prev.dates.slice(0, 7));
  const trend         = trendArrow(thisWeekScore, lastWeekScore);

  // Streaks
  const curStreak  = currentStreak(habits, longLogs, tz);
  const longStreak = longestStreak(habits, allLogs);
  const perfectDays = week.dates.filter(d => dayScore(habits, weekLogs, d) === 100).length;

  // Weekly sparkline (daily blocks with day labels)
  const dayLabels  = week.dates.map(d => DOW[(new Date(d + 'T12:00:00')).getDay()].slice(0, 1));
  const dayBlocks  = week.dates.map(d => sparkBlock(dayScore(habits, weekLogs, d)));

  // Category scores this week vs last
  const categories = [...new Set(habits.map(h => h.category))];
  const catRows = categories.map(cat => {
    const thisScore = categoryScore(habits, weekLogs, week.dates, cat);
    const prevScore = categoryScore(habits, prevLogs, prev.dates.slice(0, 7), cat);
    if (thisScore === null) return null;
    const arrow = prevScore !== null ? trendArrow(thisScore, prevScore) : '';
    const emoji = categoryEmoji(cat);
    return `${emoji} ${cat.charAt(0).toUpperCase() + cat.slice(1)}: *${thisScore}%*  ${arrow}`;
  }).filter(Boolean);

  // Per-habit breakdown with sparkline
  const breakdown = habits.map(h => {
    const hLogs   = weekLogs.filter(l => l.habit_id === h.id);
    const pct     = periodScore([h], hLogs, week.dates);
    const spark   = habitSparkline(h, weekLogs, week.dates);
    const streak  = db.getHabitStreak(user.id, h.id);
    const dot     = pct >= 80 ? '🟢' : pct >= 50 ? '🟡' : '🔴';
    const streakStr = streak > 0 ? `  🔥${streak}d` : '';
    return `${dot} ${h.habit_name}\n   \`${spark}\`  *${pct}%*${streakStr}`;
  });

  // Day-of-week insight
  const dow = dowAnalysis(habits, allLogs);

  // Best week ever
  const bw = bestWeekEver(habits, allLogs);

  // Exercise totals
  const pushups = exerciseTotal(habits, weekLogs, 'push');
  const squats  = exerciseTotal(habits, weekLogs, 'squat');

  // Worst habit (needs attention)
  const worstH = habits.map(h => {
    const hLogs = weekLogs.filter(l => l.habit_id === h.id);
    return { name: h.habit_name, score: periodScore([h], hLogs, week.dates) };
  }).sort((a, b) => a.score - b.score)[0];

  // ── Build output ───────────────────────────────────────────────────────
  const lines = [
    `📊 *DASHBOARD*`,
    ``,
    `🗓 *THIS WEEK*  (${weekLabel(week.start)}–${weekLabel(week.end)})`,
    `━━━━━━━━━━━━━━━━`,
    `${scoreEmoji(thisWeekScore)} *${thisWeekScore}%*  ${trend}`,
    `\`${bar(thisWeekScore)}\``,
    ``,
    `\`${dayLabels.join('  ')}\``,
    `\`${dayBlocks.join('  ')}\``,
    `_▂=low  ▅=partial  █=full_`,
  ];

  if (perfectDays > 0) lines.push(`⭐ *${perfectDays}* perfect day${perfectDays > 1 ? 's' : ''} this week`);

  // Highlights
  lines.push(
    ``,
    `🏅 *HIGHLIGHTS*`,
    `━━━━━━━━━━━━━━━━`,
    `🔥 Current streak:  *${streakFire(curStreak)}*`,
    `🏆 Longest streak:  *${streakFire(longStreak)}*`,
  );

  if (pushups > 0) lines.push(`💪 Pushups this week: *${pushups} reps*`);
  if (squats  > 0) lines.push(`💪 Squats this week:  *${squats} reps*`);

  // Per-habit breakdown
  lines.push(
    ``,
    `📋 *HABITS THIS WEEK*`,
    `━━━━━━━━━━━━━━━━`,
    ...breakdown,
  );

  // Category breakdown (week vs last week)
  if (catRows.length > 1) {
    lines.push(
      ``,
      `📈 *CATEGORIES  (vs last week)*`,
      `━━━━━━━━━━━━━━━━`,
      ...catRows,
    );
  }

  // Worst habit alert
  if (worstH && worstH.score < 50) {
    lines.push(``, `⚠️ *Needs attention:* ${worstH.name} (${worstH.score}% this week)`);
  }

  // Day of week insight
  if (dow) {
    lines.push(
      ``,
      `💡 *INSIGHT*`,
      `━━━━━━━━━━━━━━━━`,
      `Best day:   ${dow.best.day} (avg ${dow.best.avg}%)`,
      `Watch out:  ${dow.worst.day} (avg ${dow.worst.avg}%)`,
    );
  }

  // Since you started — only meaningful data, no empty year stats
  const sinceScore = periodScore(habits, allLogs, [...new Set(allLogs.map(l => l.date))]);
  const logRate    = Math.round(daysActive / daysSinceStart * 100);

  lines.push(
    ``,
    `📅 *SINCE DAY 1*  (${daysSinceStart} days)`,
    `━━━━━━━━━━━━━━━━`,
    `${scoreEmoji(sinceScore)} Avg score:  *${sinceScore}%*`,
    `📆 Logged:      *${daysActive}/${daysSinceStart}* days  (${logRate}%)`,
  );

  if (bw) {
    lines.push(`🏆 Best week:   *${bw.score}%*  (${weekLabel(bw.weekStart)})`);
  }

  return lines.join('\n');
}

module.exports = { generateReport, consistencyScore };
