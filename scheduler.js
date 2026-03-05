const cron = require('node-cron');
const db   = require('./database');
const { getUserTime, getToday } = require('./habits');

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

console.log('[Scheduler] Running — checks every minute.');
