const TelegramBot = require('node-telegram-bot-api');
const config    = require('./config');
const db        = require('./database');
const dashboard = require('./dashboard');
const {
  getToday, completionLabel, categoryEmoji, buildLogKeyboard,
} = require('./habits');

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// In-memory conversation state: telegramId → { step, data }
const state = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────
function requireUser(chatId, telegramId) {
  const user = db.getUser(telegramId);
  if (!user) { bot.sendMessage(chatId, 'Send /start to begin.'); return null; }
  return user;
}

function habitLine(habit, log) {
  const status = log ? completionLabel(log.completion_value) : '⬜';
  const target = habit.target_value ? ` — ${habit.target_value}` : '';
  return `${categoryEmoji(habit.category)} *${habit.habit_name}*${target} ${status}`;
}

// ── /start ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const { id: telegramId, username, first_name } = msg.from;
  const chatId = msg.chat.id;

  db.getDb();
  const { user, isNew } = db.getOrCreateUser(telegramId, username, first_name);

  if (isNew) {
    db.seedDefaultHabits(user.id);
    db.setDefaultNotifications(user.id);
    await bot.sendMessage(chatId,
      `Hi ${first_name || 'there'}.\n\nDefault habits configured.\nMorning check-in: 7:30 AM\nNight review: 9:30 PM\n\n/log to check in now. /config to customize.`
    );
  } else {
    await bot.sendMessage(chatId, `Welcome back.\n\n/log to check in. /status for today.`);
  }
});

// ── /help ──────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `/log — check in now\n/status — today's progress\n/dashboard — weekly & monthly metrics\n/addhabit — add a habit\n/removehabit — remove a habit\n/config — notification times & timezone\n/start — register / reset`
  );
});

// ── /log ───────────────────────────────────────────────────────────────────
bot.onText(/\/log/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  const date   = getToday(user.timezone);
  const habits = db.getHabits(user.id);
  if (!habits.length) return bot.sendMessage(chatId, 'No habits. Use /addhabit.');

  await bot.sendMessage(chatId, `*${date}*`, { parse_mode: 'Markdown' });

  for (const habit of habits) {
    const log = db.getLog(user.id, habit.id, date);
    await bot.sendMessage(chatId, habitLine(habit, log), {
      parse_mode: 'Markdown',
      reply_markup: buildLogKeyboard(habit.id, date, log ? log.completion_value : -1),
    });
  }
});

// ── /status ────────────────────────────────────────────────────────────────
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  const date   = getToday(user.timezone);
  const habits = db.getHabits(user.id);
  const logs   = db.getTodayLogs(user.id, date);
  const logMap = Object.fromEntries(logs.map(l => [l.habit_id, l]));

  if (!habits.length) return bot.sendMessage(chatId, 'No habits. Use /addhabit.');

  const lines = habits.map(h => habitLine(h, logMap[h.id] || null));
  const done  = logs.filter(l => l.completion_value === 100).length;
  const score = habits.length
    ? Math.round(logs.reduce((s, l) => s + l.completion_value, 0) / (habits.length * 100) * 100)
    : 0;

  await bot.sendMessage(chatId,
    `*${date}*\n\n${lines.join('\n')}\n\n✅ ${done}/${habits.length} — *${score}%*`,
    { parse_mode: 'Markdown' }
  );
});

// ── /dashboard ─────────────────────────────────────────────────────────────
bot.onText(/\/dashboard/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;
  await bot.sendMessage(chatId, dashboard.generateReport(user), { parse_mode: 'Markdown' });
});

// ── /addhabit ──────────────────────────────────────────────────────────────
bot.onText(/\/addhabit/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  state.set(String(msg.from.id), { step: 'add_name', data: {} });
  await bot.sendMessage(chatId, 'Habit name?', { reply_markup: { force_reply: true } });
});

// ── /removehabit ───────────────────────────────────────────────────────────
bot.onText(/\/removehabit/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  const habits = db.getHabits(user.id);
  if (!habits.length) return bot.sendMessage(chatId, 'No habits to remove.');

  await bot.sendMessage(chatId, 'Which habit?', {
    reply_markup: {
      inline_keyboard: habits.map(h => [{
        text: `${categoryEmoji(h.category)} ${h.habit_name}`,
        callback_data: `rm:${h.id}`,
      }]),
    },
  });
});

// ── /config ────────────────────────────────────────────────────────────────
bot.onText(/\/config/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  const notifs  = db.getNotifications(user.id);
  const morning = notifs.find(n => n.notification_type === 'morning')?.notification_time || '07:30';
  const night   = notifs.find(n => n.notification_type === 'night')?.notification_time   || '21:30';

  await bot.sendMessage(chatId,
    `*Config*\n\nTimezone: ${user.timezone}\nMorning: ${morning}\nNight: ${night}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌅 Morning time', callback_data: 'cfg:morning' }],
          [{ text: '🌙 Night time',   callback_data: 'cfg:night'   }],
          [{ text: '🌍 Timezone',     callback_data: 'cfg:tz'      }],
        ],
      },
    }
  );
});

// ── /admin ─────────────────────────────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (String(msg.from.id) !== String(config.ADMIN_ID)) return;

  const total  = db.getAllUsers().length;
  const active = db.getActiveUsers(7).length;

  await bot.sendMessage(chatId, `*Admin*\n\nTotal users: ${total}\nActive (7d): ${active}`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📢 Broadcast',  callback_data: 'adm:broadcast' }],
        [{ text: '👥 List users', callback_data: 'adm:users'     }],
      ],
    },
  });
});

// ── Callback queries ───────────────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  const { id: qId, from, message, data } = q;
  const chatId     = message.chat.id;
  const msgId      = message.message_id;
  const telegramId = from.id;

  await bot.answerCallbackQuery(qId);

  const user = db.getUser(telegramId);
  if (!user) return;

  // log:{habitId}:{value}:{date}
  if (data.startsWith('log:')) {
    const parts   = data.split(':');
    const habitId = parseInt(parts[1]);
    const value   = parseInt(parts[2]);
    const date    = parts[3];
    db.logHabit(user.id, habitId, date, value);
    await bot.editMessageReplyMarkup(buildLogKeyboard(habitId, date, value), {
      chat_id: chatId, message_id: msgId,
    });
    return;
  }

  // rm:{habitId}
  if (data.startsWith('rm:')) {
    const habitId = parseInt(data.split(':')[1]);
    db.removeHabit(habitId, user.id);
    await bot.editMessageText('Removed.', { chat_id: chatId, message_id: msgId });
    return;
  }

  // cfg:morning | cfg:night | cfg:tz
  if (data === 'cfg:morning' || data === 'cfg:night') {
    const type = data.split(':')[1];
    state.set(String(telegramId), { step: `cfg_${type}`, data: {} });
    await bot.sendMessage(chatId, `New ${type} time? (HH:MM, 24h — e.g. 07:30)`, {
      reply_markup: { force_reply: true },
    });
    return;
  }
  if (data === 'cfg:tz') {
    state.set(String(telegramId), { step: 'cfg_tz', data: {} });
    await bot.sendMessage(chatId, 'Timezone? (e.g. America/New_York, Europe/London, Asia/Kolkata)', {
      reply_markup: { force_reply: true },
    });
    return;
  }

  // Category selection during /addhabit
  if (data.startsWith('cat:')) {
    const s = state.get(String(telegramId));
    if (!s || s.step !== 'add_category') return;
    s.data.category = data.split(':')[1];
    s.step = 'add_target';
    state.set(String(telegramId), s);
    await bot.editMessageText(`Category: ${s.data.category}`, { chat_id: chatId, message_id: msgId });
    await bot.sendMessage(chatId, 'Target? (e.g. 150 reps, 3L, or type skip)', {
      reply_markup: { force_reply: true },
    });
    return;
  }

  // Notify slot selection during /addhabit
  if (data.startsWith('slot:')) {
    const s = state.get(String(telegramId));
    if (!s || s.step !== 'add_slot') return;
    const slot = data.split(':')[1]; // morning | night | both
    db.addHabit(
      user.id, s.data.name, s.data.category, s.data.target,
      slot === 'morning' || slot === 'both',
      slot === 'night'   || slot === 'both'
    );
    state.delete(String(telegramId));
    await bot.editMessageText(`✅ Added: *${s.data.name}*`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
    });
    return;
  }

  // Admin actions
  if (data.startsWith('adm:') && String(telegramId) === String(config.ADMIN_ID)) {
    if (data === 'adm:broadcast') {
      state.set(String(telegramId), { step: 'adm_broadcast', data: {} });
      await bot.sendMessage(chatId, 'Broadcast message:', { reply_markup: { force_reply: true } });
    } else if (data === 'adm:users') {
      const users = db.getAllUsers().slice(-20);
      const lines = users.map(u => `• ${u.first_name || u.username || u.telegram_id}`).join('\n');
      await bot.sendMessage(chatId, `*Users:*\n${lines}`, { parse_mode: 'Markdown' });
    }
  }
});

// ── Text message handler (conversation state machine) ─────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const telegramId = msg.from.id;
  const chatId     = msg.chat.id;
  const text       = msg.text.trim();
  const s          = state.get(String(telegramId));
  if (!s) return;

  const user = db.getUser(telegramId);

  switch (s.step) {

    case 'add_name':
      s.data.name = text.slice(0, 80);
      s.step = 'add_category';
      state.set(String(telegramId), s);
      await bot.sendMessage(chatId, 'Category?', {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🥗 Food',       callback_data: 'cat:food'       },
              { text: '💊 Supplement', callback_data: 'cat:supplement' },
            ],
            [
              { text: '💪 Exercise',   callback_data: 'cat:exercise'   },
              { text: '💧 Hydration',  callback_data: 'cat:hydration'  },
            ],
            [{ text: '😴 Recovery', callback_data: 'cat:recovery' }],
          ],
        },
      });
      break;

    case 'add_target':
      s.data.target = text.toLowerCase() === 'skip' ? null : text;
      s.step = 'add_slot';
      state.set(String(telegramId), s);
      await bot.sendMessage(chatId, 'Remind in?', {
        reply_markup: {
          inline_keyboard: [[
            { text: '🌅 Morning', callback_data: 'slot:morning' },
            { text: '🌙 Night',   callback_data: 'slot:night'   },
            { text: 'Both',       callback_data: 'slot:both'    },
          ]],
        },
      });
      break;

    case 'cfg_morning':
    case 'cfg_night': {
      const type = s.step === 'cfg_morning' ? 'morning' : 'night';
      if (/^\d{1,2}:\d{2}$/.test(text)) {
        const [h, m] = text.split(':').map(Number);
        if (h >= 0 && h < 24 && m >= 0 && m < 60) {
          const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          db.updateNotification(user.id, type, formatted);
          state.delete(String(telegramId));
          await bot.sendMessage(chatId, `${type === 'morning' ? 'Morning' : 'Night'} set to ${formatted}.`);
          return;
        }
      }
      await bot.sendMessage(chatId, 'Use HH:MM format (e.g. 07:30).');
      break;
    }

    case 'cfg_tz':
      // Accept IANA timezone names
      try {
        new Intl.DateTimeFormat('en', { timeZone: text }).format();
        db.updateUserTimezone(telegramId, text);
        state.delete(String(telegramId));
        await bot.sendMessage(chatId, `Timezone set to ${text}.`);
      } catch {
        await bot.sendMessage(chatId, 'Invalid timezone. Try America/New_York or Asia/Kolkata.');
      }
      break;

    case 'adm_broadcast': {
      if (String(telegramId) !== String(config.ADMIN_ID)) { state.delete(String(telegramId)); return; }
      const users = db.getAllUsers();
      let sent = 0;
      for (const u of users) {
        try { await bot.sendMessage(u.telegram_id, text); sent++; } catch {}
      }
      state.delete(String(telegramId));
      await bot.sendMessage(chatId, `Sent to ${sent} users.`);
      break;
    }
  }
});

// ── Error handling ─────────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  if (err.code !== 'ETELEGRAM') console.error('[Bot] Polling error:', err.message);
});

// ── Check-in sender (called by scheduler) ─────────────────────────────────
async function sendCheckin(user, type) {
  const date   = getToday(user.timezone);
  const habits = db.getHabits(user.id).filter(h => type === 'morning' ? h.notify_morning : h.notify_night);
  if (!habits.length) return;

  const title = type === 'morning' ? 'Morning check-in.' : 'Daily review.';
  await bot.sendMessage(user.telegram_id, title);

  for (const habit of habits) {
    const log = db.getLog(user.id, habit.id, date);
    await bot.sendMessage(user.telegram_id, habitLine(habit, log), {
      parse_mode: 'Markdown',
      reply_markup: buildLogKeyboard(habit.id, date, log ? log.completion_value : -1),
    });
  }
}

module.exports = { bot, sendCheckin };
