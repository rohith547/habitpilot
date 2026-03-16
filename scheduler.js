const cron = require('node-cron');
const db   = require('./database');
const { getUserTime, getToday } = require('./habits');

// In-memory Set for missed-day nudge tracking (cleared at midnight)
const nudgedToday = new Set();

// Weekly report tracking: userId → YYYY-MM-DD (Sunday's date)
const weeklyReportSent = new Map();

// Runs every minute — checks each user's notification schedule
cron.schedule('* * * * *', async () => {
  try {
    const { sendCheckin } = require('./telegram'); // lazy import to avoid circular dep at load time
    const users = db.getAllUsers();

    for (const user of users) {
      try {
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
        console.error(`[Scheduler] User ${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler]', err.message);
  }
});

// Weekly report — Sundays at 8:00 AM
cron.schedule('* * * * *', async () => {
  try {
    const { sendWeeklyReport } = require('./telegram');
    const users = db.getAllUsers();
    for (const user of users) {
      try {
        const userTime = getUserTime(user.timezone);
        const userDate = getToday(user.timezone);
        const dayOfWeek = new Date(userDate + 'T12:00:00').getDay(); // 0=Sunday
        if (dayOfWeek === 0 && userTime === '08:00' && weeklyReportSent.get(user.id) !== userDate) {
          weeklyReportSent.set(user.id, userDate);
          await sendWeeklyReport(user);
        }
      } catch (err) {
        console.error(`[Scheduler] Weekly report user ${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Weekly report:', err.message);
  }
});

// Missed-day nudge — 21:00 in user's timezone if no logs today
cron.schedule('* * * * *', async () => {
  try {
    const users = db.getAllUsers();
    for (const user of users) {
      try {
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
        console.error(`[Scheduler] Nudge user ${user.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Nudge:', err.message);
  }
});

// Clear nudgedToday at midnight UTC
cron.schedule('0 0 * * *', () => { nudgedToday.clear(); });

console.log('[Scheduler] Running — checks every minute.');
