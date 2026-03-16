const cron = require('node-cron');
const db   = require('./database');
const { getUserTime, getToday } = require('./habits');
const errors = require('./errors');

// In-memory Set for missed-day nudge tracking (cleared at midnight)
const nudgedToday = new Set();

// Weekly report tracking: userId → YYYY-MM-DD (Sunday's date)
const weeklyReportSent = new Map();

// ── Coach message generator ────────────────────────────────────────────────
function coachMessage(user, weekScore, lastWeekScore, bestEverScore) {
  const diff = weekScore - lastWeekScore;
  const name = user.first_name || 'there';

  if (weekScore >= 90)
    return `🎉 *Incredible week, ${name}!* ${weekScore}% — you're absolutely crushing it. Keep this momentum going!`;
  if (weekScore > bestEverScore - 5 && weekScore >= 70)
    return `🏆 *One of your best weeks ever, ${name}!* ${weekScore}%. You're building something real here.`;
  if (diff >= 15)
    return `📈 *Big improvement, ${name}!* Up ${diff}% from last week. Whatever you changed — keep doing it.`;
  if (diff <= -15)
    return `💪 *Bounce-back time, ${name}.* Last week was ${lastWeekScore}%, this week ${weekScore}%. Pick one habit to focus on this week.`;
  if (weekScore >= 70)
    return `✅ *Solid week, ${name}.* ${weekScore}% — consistent and steady. Consistency beats perfection.`;
  if (weekScore >= 50)
    return `🔄 *Making progress, ${name}.* ${weekScore}% this week. Small steps still count.`;
  return `👋 *Hey ${name},* ${weekScore}% this week. Every streak starts with day 1 — /log to begin yours.`;
}

// Runs every minute — checks each user's notification schedule
cron.schedule('* * * * *', async () => {
  try {
    const { sendCheckin } = require('./telegram'); // lazy import to avoid circular dep at load time
    const users = db.getAllUsers();

    for (const user of users) {
      try {
        if (db.isUserPaused(user)) continue;
        const userTime = getUserTime(user.timezone);
        const userDate = getToday(user.timezone);
        const notifs   = db.getNotifications(user.id);

        for (const notif of notifs) {
          if (notif.notification_time === userTime && notif.last_sent !== userDate) {
            db.markNotificationSent(notif.id, userDate); // mark first to prevent race
            await sendCheckin(user, notif.notification_type);
          }
        }
      } catch (err) {
        errors.logError('scheduler:checkin', err, user.telegram_id);
      }
    }
  } catch (err) {
    errors.logError('scheduler:checkin:outer', err);
  }
});

// Weekly report — Sundays at 8:00 AM
cron.schedule('* * * * *', async () => {
  try {
    const { sendWeeklyReport } = require('./telegram');
    const users = db.getAllUsers();
    for (const user of users) {
      try {
        if (db.isUserPaused(user)) continue;
        const userTime = getUserTime(user.timezone);
        const userDate = getToday(user.timezone);
        const dayOfWeek = new Date(userDate + 'T12:00:00').getDay(); // 0=Sunday
        if (dayOfWeek === 0 && userTime === '08:00' && weeklyReportSent.get(user.id) !== userDate) {
          weeklyReportSent.set(user.id, userDate);
          // Compute scores for coach message
          const { getRangeLogs, getHabits } = require('./database');
          const habits = getHabits(user.id);
          const weekStart = new Date(userDate + 'T12:00:00'); weekStart.setDate(weekStart.getDate() - 6);
          const prevStart = new Date(weekStart); prevStart.setDate(prevStart.getDate() - 7);
          const weekStartStr = weekStart.toISOString().slice(0, 10);
          const prevStartStr = prevStart.toISOString().slice(0, 10);
          const prevEnd = new Date(weekStart); prevEnd.setDate(prevEnd.getDate() - 1);
          const prevEndStr = prevEnd.toISOString().slice(0, 10);
          const allLogs  = getRangeLogs(user.id, '2020-01-01', userDate);
          const weekLogs = getRangeLogs(user.id, weekStartStr, userDate);
          const prevLogs = getRangeLogs(user.id, prevStartStr, prevEndStr);
          function calcScore(logs, days) {
            if (!habits.length) return 0;
            return Math.min(100, Math.round(logs.reduce((s, l) => s + l.completion_value, 0) / (days * habits.length * 100) * 100));
          }
          const weekScore     = calcScore(weekLogs, 7);
          const lastWeekScore = calcScore(prevLogs, 7);
          // Best ever: scan all weeks
          let bestEver = 0;
          if (allLogs.length) {
            const dates = [...new Set(allLogs.map(l => l.date))].sort();
            for (let i = 0; i < dates.length; i += 7) {
              const chunk = allLogs.filter(l => l.date >= dates[i] && l.date <= (dates[Math.min(i+6, dates.length-1)] || dates[i]));
              const s = calcScore(chunk, 7);
              if (s > bestEver) bestEver = s;
            }
          }
          const coach = coachMessage(user, weekScore, lastWeekScore, bestEver);
          await sendWeeklyReport(user, coach);
          // Award freeze for 7+ day streak
          const { currentStreak: calcStreak } = require('./dashboard');
          const userStreak = db.getStreak(user.id);
          if (userStreak >= 7) {
            db.addStreakFreeze(user.id);
            console.log(`[Scheduler] Awarded freeze to user ${user.id}`);
          }
        }
      } catch (err) {
        errors.logError('scheduler:weekly', err, user.telegram_id);
      }
    }
  } catch (err) {
    errors.logError('scheduler:weekly:outer', err);
  }
});

// Missed-day nudge — 21:00 in user's timezone if no logs today
cron.schedule('* * * * *', async () => {
  try {
    const users = db.getAllUsers();
    for (const user of users) {
      try {
        if (db.isUserPaused(user)) continue;
        const userTime = getUserTime(user.timezone);
        const userDate = getToday(user.timezone);
        const nudgeKey = `${user.id}:${userDate}`;
        if (userTime === '21:00' && !nudgedToday.has(nudgeKey)) {
          const noLogs = db.getUsersWithNoLogsToday(userDate);
          if (noLogs.some(u => u.id === user.id)) {
            nudgedToday.add(nudgeKey);
            const { bot } = require('./telegram');
            await bot.sendMessage(user.telegram_id,
              "⏰ Hey! You haven't logged today yet. Still 3 hours left — tap /log to check in 💪"
            );
          }
        }
      } catch (err) {
        errors.logError('scheduler:nudge', err, user.telegram_id);
      }
    }
  } catch (err) {
    errors.logError('scheduler:nudge:outer', err);
  }
});

// Clear nudgedToday at midnight UTC
cron.schedule('0 0 * * *', () => { nudgedToday.clear(); });

// Streak freeze nudge — 23:30 in user's timezone
const freezeNudged = new Set();
cron.schedule('* * * * *', async () => {
  try {
    const users = db.getAllUsers();
    for (const user of users) {
      try {
        if (db.isUserPaused(user)) continue;
        const userTime = getUserTime(user.timezone);
        const userDate = getToday(user.timezone);
        const nudgeKey = `freeze:${user.id}:${userDate}`;
        if (userTime === '23:30' && !freezeNudged.has(nudgeKey)) {
          const noLogs = db.getUsersWithNoLogsToday(userDate);
          if (noLogs.some(u => u.id === user.id)) {
            const freezeData = db.getStreakFreezes(user.id);
            const streak = db.getStreak(user.id);
            if (streak >= 3 && freezeData && freezeData.streak_freezes > 0) {
              freezeNudged.add(nudgeKey);
              const { bot } = require('./telegram');
              await bot.sendMessage(user.telegram_id,
                `🧊 *Streak freeze available!* You haven't logged today and your ${streak}-day streak is at risk.\n\nUse a freeze to protect it?`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: `🧊 Use freeze (${freezeData.streak_freezes} left)`, callback_data: 'freeze_use' },
                      { text: 'Let it go', callback_data: 'freeze_skip' },
                    ]],
                  },
                }
              );
            }
          }
        }
      } catch (err) {
        errors.logError('scheduler:freeze', err, user.telegram_id);
      }
    }
  } catch (err) {
    errors.logError('scheduler:freeze:outer', err);
  }
});

console.log('[Scheduler] Running — checks every minute.');
