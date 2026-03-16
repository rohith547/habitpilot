const TelegramBot = require('node-telegram-bot-api');
const config    = require('./config');
const db        = require('./database');
const dashboard = require('./dashboard');
const {
  getToday, completionLabel, categoryEmoji, buildLogKeyboard,
  buildAllDoneKeyboard, buildHeatmap,
} = require('./habits');
const {
  getHabitStreak, getHabitPersonalBest, getHabitStats, getHabitCalendar,
  updateLogNote, updateHabitOrder,
} = require('./database');

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// In-memory conversation state: telegramId → { step, data }
const state = new Map();

// ── Date range helper ──────────────────────────────────────────────────────
function getRangeDates(days, timezone) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(d));
  }
  return dates;
}

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

// ── Config helpers ─────────────────────────────────────────────────────────
const REMINDER_EMOJI = { morning: '🌅', afternoon: '☀️', evening: '🌆', night: '🌙', lunch: '🍽️', default: '🔔' };

function reminderEmoji(type) {
  return REMINDER_EMOJI[type] || REMINDER_EMOJI.default;
}

async function sendConfigMenu(chatId, userId) {
  const notifs = db.getNotifications(userId);
  const user   = db.getAllUsers().find(u => u.id === userId);
  const rows   = notifs.map(n => [{
    text: `${reminderEmoji(n.notification_type)} ${n.notification_time} — ${n.notification_type}`,
    callback_data: `nef:${n.id}`,
  }, {
    text: '🗑 Remove',
    callback_data: `nrm:${n.id}`,
  }]);
  rows.push([{ text: '➕ Add reminder', callback_data: 'nadd' }]);
  rows.push([{ text: '🌍 Timezone',     callback_data: 'cfg:tz' }]);
  await bot.sendMessage(chatId,
    `*Config*\n\nTimezone: ${user?.timezone || 'America/Chicago'}\n\n*Reminders (tap to edit time):*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}


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
    `/log — check in now\n/status — today's progress\n/dashboard — weekly & monthly metrics\n/addhabit — add a habit\n/edithabit — edit name, target, or check-in slot\n/removehabit — remove a habit\n/config — notification times & timezone\n/start — register / reset`
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

  // "Mark all done" button at top
  await bot.sendMessage(chatId, `*${date}*`, {
    parse_mode: 'Markdown',
    reply_markup: buildAllDoneKeyboard(date),
  });

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

  // Per-habit lines with streak
  const lines = habits.map(h => {
    const log = logMap[h.id] || null;
    const status = log ? completionLabel(log.completion_value) : '⬜';
    const target = h.target_value ? ` — ${h.target_value}` : '';
    const streak = db.getHabitStreak(user.id, h.id);
    const streakStr = streak > 0 ? ` 🔥${streak}d` : '';
    return `${categoryEmoji(h.category)} *${h.habit_name}*${target} ${status}${streakStr}`;
  });

  const done  = logs.filter(l => l.completion_value === 100).length;
  const score = habits.length
    ? Math.round(logs.reduce((s, l) => s + l.completion_value, 0) / (habits.length * 100) * 100)
    : 0;

  // Trend: compare today's score to 7-day average
  const weekDates = getRangeDates(7, user.timezone);
  const weekLogs  = db.getRangeLogs(user.id, weekDates[0], weekDates[weekDates.length - 1]);
  const sevenDayAvg = habits.length && weekLogs.length
    ? Math.round(weekLogs.reduce((s, l) => s + l.completion_value, 0) / (7 * habits.length * 100) * 100)
    : 0;

  let trend = '➡️ on track';
  if (score > sevenDayAvg + 10) trend = `📈 +${score - sevenDayAvg}% vs avg`;
  else if (score < sevenDayAvg - 10) trend = `📉 -${sevenDayAvg - score}% vs avg`;

  await bot.sendMessage(chatId,
    `*${date}*\n\n${lines.join('\n')}\n\n✅ ${done}/${habits.length} — *${score}%* ${trend}`,
    { parse_mode: 'Markdown', reply_markup: buildAllDoneKeyboard(date) }
  );
});

// ── /dashboard ─────────────────────────────────────────────────────────────
bot.onText(/\/dashboard/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;
  await bot.sendMessage(chatId, dashboard.generateReport(user), { parse_mode: 'Markdown' });
});

// ── /habit <name> ──────────────────────────────────────────────────────────
bot.onText(/\/habit\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  const query = match[1].trim().toLowerCase();
  const habits = db.getHabits(user.id);
  const habit  = habits.find(h => h.habit_name.toLowerCase().includes(query));
  if (!habit) return bot.sendMessage(chatId, `❌ No habit found matching "${match[1].trim()}"`);

  const streak  = db.getHabitStreak(user.id, habit.id);
  const best    = db.getHabitPersonalBest(user.id, habit.id);
  const stats   = db.getHabitStats(user.id, habit.id, 30);
  const calLogs = db.getHabitCalendar(user.id, habit.id, 28);
  const heatmap = buildHeatmap(calLogs, 28);

  const emoji   = categoryEmoji(habit.category);
  const target  = habit.target_value ? ` — ${habit.target_value}` : '';
  const donePct = Math.round(stats.done100 / 30 * 100);

  const lines = [
    `${emoji} *${habit.habit_name}*${target}`,
    `🔥 Streak: ${streak} days | 🏆 Best: ${best} days`,
    `📊 30 days: ${donePct}% done | ${stats.consistency}% consistency`,
    ``,
    `*Last 28 days:*`,
    heatmap,
  ];

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
});

// ── /addhabit ──────────────────────────────────────────────────────────────
bot.onText(/\/addhabit/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  state.set(String(msg.from.id), { step: 'add_name', data: {} });
  await bot.sendMessage(chatId, 'Habit name?', { reply_markup: { force_reply: true } });
});

// ── /edithabit ─────────────────────────────────────────────────────────────
bot.onText(/\/edithabit/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = requireUser(chatId, msg.from.id);
  if (!user) return;

  const habits = db.getHabits(user.id);
  if (!habits.length) return bot.sendMessage(chatId, 'No habits. Use /addhabit.');

  await bot.sendMessage(chatId, 'Which habit to edit?', {
    reply_markup: {
      inline_keyboard: habits.map(h => [{
        text: `${categoryEmoji(h.category)} ${h.habit_name}${h.target_value ? ` (${h.target_value})` : ''}`,
        callback_data: `ep:${h.id}`,
      }]),
    },
  });
});


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
  await sendConfigMenu(chatId, user.id);
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

    // Block past-date logging
    const today = getToday(user.timezone);
    if (date < today) {
      await bot.answerCallbackQuery(qId, { text: "⛔ Can't log past dates.", show_alert: true });
      return;
    }

    const oldBest = db.getHabitPersonalBest(user.id, habitId);

    db.logHabit(user.id, habitId, date, value);

    // Update BOTH the text line (green ✅ / emoji) AND the keyboard
    const habit = db.getHabit(habitId, user.id);
    if (habit) {
      await bot.editMessageText(habitLine(habit, { completion_value: value }), {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: buildLogKeyboard(habitId, date, value),
      });
    } else {
      await bot.editMessageReplyMarkup(buildLogKeyboard(habitId, date, value), {
        chat_id: chatId, message_id: msgId,
      });
    }

    const newStreak = db.getHabitStreak(user.id, habitId);
    if (value > 0 && newStreak > 0 && newStreak > oldBest) {
      await bot.sendMessage(chatId,
        `🏆 New personal best! *${habit.habit_name}* streak: ${newStreak} days (beat your old record of ${oldBest}!)`,
        { parse_mode: 'Markdown' }
      );
    }

    // Progress feedback — show when all habits have been logged for today
    const allHabits = db.getHabits(user.id);
    const allLogs   = db.getTodayLogs(user.id, date);
    if (allLogs.length >= allHabits.length) {
      const done100  = allLogs.filter(l => l.completion_value === 100).length;
      const score    = Math.round(
        allLogs.reduce((s, l) => s + l.completion_value, 0) / (allHabits.length * 100) * 100
      );
      const streak   = db.getStreak(user.id);
      const streakTxt = streak > 1 ? `\n🔥 ${streak}-day streak!` : '';

      if (done100 === allHabits.length) {
        await bot.sendMessage(chatId,
          `🎉 *Perfect day!* All ${done100}/${allHabits.length} habits done — *100%*${streakTxt}`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId,
          `✅ All logged — *${score}%* today (${done100}/${allHabits.length} fully done)${streakTxt}`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Note capture prompt
    state.set(String(telegramId), { step: 'note_capture', data: { habitId, date } });
    const noteMsg = await bot.sendMessage(chatId, '📝 Add a note? (type it or tap Skip)', {
      reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: `skip_note:${habitId}:${date}` }]] },
    });
    const noteMsgId = noteMsg.message_id;
    setTimeout(() => {
      const curr = state.get(String(telegramId));
      if (curr && curr.step === 'note_capture') state.delete(String(telegramId));
      bot.deleteMessage(chatId, noteMsgId).catch(() => {});
    }, 120000);

    return;
  }

  // rm:{habitId}
  if (data.startsWith('rm:')) {
    const habitId = parseInt(data.split(':')[1]);
    db.removeHabit(habitId, user.id);
    await bot.editMessageText('Removed.', { chat_id: chatId, message_id: msgId });
    return;
  }

  // alldone:{date}
  if (data.startsWith('alldone:')) {
    const date = data.split(':').slice(1).join(':');
    const today = getToday(user.timezone);
    if (date < today) {
      await bot.answerCallbackQuery(qId, { text: "⛔ Can't mark past dates as done.", show_alert: true });
      return;
    }
    const habits = db.getHabits(user.id);
    for (const habit of habits) db.logHabit(user.id, habit.id, date, 100);
    await bot.editMessageText('✅ All habits marked done!', { chat_id: chatId, message_id: msgId });
    await bot.sendMessage(chatId,
      `🎉 *Perfect day!* All ${habits.length}/${habits.length} habits marked done!`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // skip_note:{habitId}:{date}
  if (data.startsWith('skip_note:')) {
    state.delete(String(telegramId));
    await bot.editMessageText('✅ Skipped.', { chat_id: chatId, message_id: msgId });
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

  // ── Flexible reminders ──────────────────────────────────────────────────
  // nadd — start add-reminder flow
  if (data === 'nadd') {
    state.set(String(telegramId), { step: 'notif_label', data: {} });
    await bot.sendMessage(chatId,
      'Label for this reminder?\n(e.g. Morning, Afternoon, Lunch, Evening)',
      { reply_markup: { force_reply: true } }
    );
    return;
  }

  // nef:{id} — edit reminder time
  if (data.startsWith('nef:')) {
    const notifId = parseInt(data.split(':')[1]);
    state.set(String(telegramId), { step: 'notif_edit_time', data: { notifId } });
    await bot.sendMessage(chatId, 'New time for this reminder? (HH:MM, 24h — e.g. 13:00)', {
      reply_markup: { force_reply: true },
    });
    return;
  }

  // nrm:{id} — remove reminder
  if (data.startsWith('nrm:')) {
    const notifId = parseInt(data.split(':')[1]);
    db.removeNotification(notifId, user.id);
    await bot.editMessageText('🗑 Reminder removed.', { chat_id: chatId, message_id: msgId });
    await sendConfigMenu(chatId, user.id);
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

  // ep:{habitId} — edit: pick field
  if (data.startsWith('ep:')) {
    const habitId = data.split(':')[1];
    await bot.editMessageText('Edit which field?', {
      chat_id: chatId, message_id: msgId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Name',      callback_data: `ef:${habitId}:name`   }],
          [{ text: '🎯 Target',    callback_data: `ef:${habitId}:target` }],
          [{ text: '🔔 Check-in',  callback_data: `ef:${habitId}:slot`   }],
          [{ text: '⬆️ Move up',   callback_data: `eu:${habitId}`        }],
        ],
      },
    });
    return;
  }

  // eu:{habitId} — move habit up
  if (data.startsWith('eu:')) {
    const habitId = parseInt(data.split(':')[1]);
    const habits  = db.getHabits(user.id);
    const idx     = habits.findIndex(h => h.id === habitId);
    if (idx > 0) {
      db.updateHabitOrder(habits[idx].id, user.id, idx - 1);
      db.updateHabitOrder(habits[idx - 1].id, user.id, idx);
      await bot.editMessageText('⬆️ Moved up!', { chat_id: chatId, message_id: msgId });
    } else {
      await bot.editMessageText('Already at top.', { chat_id: chatId, message_id: msgId });
    }
    return;
  }

  // ef:{habitId}:{field} — edit: choose field
  if (data.startsWith('ef:')) {
    const [, habitId, field] = data.split(':');
    if (field === 'slot') {
      await bot.editMessageText('Remind in?', {
        chat_id: chatId, message_id: msgId,
        reply_markup: {
          inline_keyboard: [[
            { text: '🌅 Morning', callback_data: `es:${habitId}:morning` },
            { text: '🌙 Night',   callback_data: `es:${habitId}:night`   },
            { text: 'Both',       callback_data: `es:${habitId}:both`    },
          ]],
        },
      });
    } else {
      const prompt = field === 'name' ? 'New name?' : 'New target? (e.g. 3L, 150 reps, or type skip)';
      state.set(String(telegramId), { step: `edit_${field}`, data: { habitId: parseInt(habitId) } });
      await bot.sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
    }
    return;
  }

  // es:{habitId}:{slot} — edit: update check-in slot
  if (data.startsWith('es:')) {
    const [, habitId, slot] = data.split(':');
    db.updateHabit(parseInt(habitId), user.id, {
      notify_morning: (slot === 'morning' || slot === 'both') ? 1 : 0,
      notify_night:   (slot === 'night'   || slot === 'both') ? 1 : 0,
    });
    await bot.editMessageText(`✅ Check-in updated to: ${slot}`, { chat_id: chatId, message_id: msgId });
    return;
  }


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

    case 'edit_name': {
      const name = text.slice(0, 80);
      db.updateHabit(s.data.habitId, user.id, { habit_name: name });
      state.delete(String(telegramId));
      await bot.sendMessage(chatId, `✅ Renamed to: *${name}*`, { parse_mode: 'Markdown' });
      break;
    }

    case 'edit_target': {
      const target = text.toLowerCase() === 'skip' ? null : text;
      db.updateHabit(s.data.habitId, user.id, { target_value: target });
      state.delete(String(telegramId));
      await bot.sendMessage(chatId, target ? `✅ Target set to: *${target}*` : '✅ Target cleared.', { parse_mode: 'Markdown' });
      break;
    }


    case 'notif_label': {
      s.data.label = text.slice(0, 30);
      s.step = 'notif_time';
      state.set(String(telegramId), s);
      await bot.sendMessage(chatId,
        `Time for *${s.data.label}* reminder? (HH:MM, 24h — e.g. 13:00)`,
        { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
      );
      break;
    }

    case 'notif_time': {
      if (/^\d{1,2}:\d{2}$/.test(text)) {
        const [h, m] = text.split(':').map(Number);
        if (h >= 0 && h < 24 && m >= 0 && m < 60) {
          const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          db.addNotification(user.id, s.data.label, formatted);
          state.delete(String(telegramId));
          await bot.sendMessage(chatId,
            `✅ *${s.data.label}* reminder added at ${formatted}.`,
            { parse_mode: 'Markdown' }
          );
          await sendConfigMenu(chatId, user.id);
          return;
        }
      }
      await bot.sendMessage(chatId, 'Use HH:MM format (e.g. 13:00).');
      break;
    }

    case 'notif_edit_time': {
      if (/^\d{1,2}:\d{2}$/.test(text)) {
        const [h, m] = text.split(':').map(Number);
        if (h >= 0 && h < 24 && m >= 0 && m < 60) {
          const formatted = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          db.updateNotificationById(s.data.notifId, user.id, formatted);
          state.delete(String(telegramId));
          await bot.sendMessage(chatId, `✅ Reminder updated to ${formatted}.`);
          await sendConfigMenu(chatId, user.id);
          return;
        }
      }
      await bot.sendMessage(chatId, 'Use HH:MM format (e.g. 13:00).');
      break;
    }

    case 'cfg_morning':
    case 'cfg_night': {
      // Legacy: kept for backward compat if state was set before upgrade
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

    case 'note_capture': {
      db.updateLogNote(user.id, s.data.habitId, s.data.date, text);
      state.delete(String(telegramId));
      await bot.sendMessage(chatId, '📝 Note saved!');
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
  const habits = db.getHabits(user.id); // all active habits for any reminder type
  if (!habits.length) return;

  const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
  await bot.sendMessage(user.telegram_id, `${reminderEmoji(type)} *${typeLabel} check-in*`, { parse_mode: 'Markdown' });

  for (const habit of habits) {
    const log = db.getLog(user.id, habit.id, date);
    await bot.sendMessage(user.telegram_id, habitLine(habit, log), {
      parse_mode: 'Markdown',
      reply_markup: buildLogKeyboard(habit.id, date, log ? log.completion_value : -1),
    });
  }
}

// ── Weekly report sender (called by scheduler) ────────────────────────────
async function sendWeeklyReport(user) {
  await bot.sendMessage(user.telegram_id, dashboard.generateReport(user), { parse_mode: 'Markdown' });
}

module.exports = { bot, sendCheckin, sendWeeklyReport };
