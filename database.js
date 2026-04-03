const Database = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
const config    = require('./config');

let db;

function getDb() {
  if (db) return db;
  const isEphemeral = !config.DB_PATH.startsWith('/app/data') && !config.DB_PATH.startsWith('/data');
  if (isEphemeral) console.warn('[DB] ⚠️  Running on ephemeral storage. Data will be lost on redeploy!\n    Fix: Right-click Railway canvas → Add Volume → mount at /app/data → set DB_PATH=/app/data/habits.db');
  const dir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT    UNIQUE NOT NULL,
      username    TEXT,
      first_name  TEXT,
      timezone    TEXT    NOT NULL DEFAULT 'America/Chicago',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS habits (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      habit_name     TEXT    NOT NULL,
      category       TEXT    NOT NULL,
      target_value   TEXT,
      frequency      TEXT    NOT NULL DEFAULT 'daily',
      notify_morning INTEGER NOT NULL DEFAULT 1,
      notify_night   INTEGER NOT NULL DEFAULT 1,
      active         INTEGER NOT NULL DEFAULT 1,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS habit_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL,
      habit_id         INTEGER NOT NULL,
      date             TEXT    NOT NULL,
      completion_value INTEGER NOT NULL DEFAULT 0,
      logged_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, habit_id, date),
      FOREIGN KEY (user_id)  REFERENCES users(id),
      FOREIGN KEY (habit_id) REFERENCES habits(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id           INTEGER NOT NULL,
      notification_time TEXT    NOT NULL,
      notification_type TEXT    NOT NULL,
      active            INTEGER NOT NULL DEFAULT 1,
      last_sent         TEXT    DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);
  try { db.exec('ALTER TABLE habit_logs ADD COLUMN note TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN paused_until TEXT DEFAULT NULL'); } catch(e) {}
  // milestone_log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS milestone_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      habit_id INTEGER,
      milestone INTEGER NOT NULL,
      celebrated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, habit_id, milestone)
    );
  `);
  try { db.exec('ALTER TABLE users ADD COLUMN streak_freezes INTEGER DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN freeze_used_date TEXT DEFAULT NULL'); } catch(e) {}
}

// ── Users ──────────────────────────────────────────────────────────────────
function getOrCreateUser(telegramId, username, firstName) {
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
  if (existing) return { user: existing, isNew: false };
  const r = db.prepare(
    'INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)'
  ).run(String(telegramId), username || null, firstName || null);
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid), isNew: true };
}

function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(telegramId));
}

function updateUserTimezone(telegramId, timezone) {
  db.prepare('UPDATE users SET timezone = ? WHERE telegram_id = ?').run(timezone, String(telegramId));
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all();
}

function getActiveUsers(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  return db.prepare(`
    SELECT DISTINCT u.* FROM users u
    JOIN habit_logs hl ON u.id = hl.user_id
    WHERE hl.logged_at >= ?
  `).all(since.toISOString());
}

// ── Habits ─────────────────────────────────────────────────────────────────
function getHabit(habitId, userId) {
  return db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ? AND active = 1').get(habitId, userId);
}

function getStreak(userId) {
  const rows = db.prepare(
    'SELECT DISTINCT date FROM habit_logs WHERE user_id = ? AND completion_value = 100 ORDER BY date DESC'
  ).all(userId);
  const userRow = db.prepare('SELECT freeze_used_date FROM users WHERE id = ?').get(userId);
  const freezeDate = userRow ? userRow.freeze_used_date : null;
  if (!rows.length && !freezeDate) return 0;
  const loggedDates = new Set(rows.map(r => r.date));
  if (freezeDate) loggedDates.add(freezeDate);
  const allDates = [...loggedDates].sort().reverse();
  let streak = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const date of allDates) {
    const d    = new Date(date + 'T00:00:00');
    const diff = Math.round((today - d) / 86400000);
    if (diff === streak) streak++;
    else if (diff === streak + 1 && streak === 0) { streak++; }
    else break;
  }
  return streak;
}

function getHabits(userId, activeOnly = true) {
  const q = activeOnly
    ? 'SELECT * FROM habits WHERE user_id = ? AND active = 1 ORDER BY sort_order, id'
    : 'SELECT * FROM habits WHERE user_id = ? ORDER BY sort_order, id';
  return db.prepare(q).all(userId);
}

function addHabit(userId, habitName, category, targetValue, notifyMorning, notifyNight) {
  const r = db.prepare(`
    INSERT INTO habits (user_id, habit_name, category, target_value, notify_morning, notify_night)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, habitName, category, targetValue || null, notifyMorning ? 1 : 0, notifyNight ? 1 : 0);
  return r.lastInsertRowid;
}

function removeHabit(habitId, userId) {
  db.prepare('UPDATE habits SET active = 0 WHERE id = ? AND user_id = ?').run(habitId, userId);
}

function updateHabit(habitId, userId, fields) {
  const allowed = ['habit_name', 'target_value', 'notify_morning', 'notify_night'];
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!updates.length) return;
  const set  = updates.map(([k]) => `${k} = ?`).join(', ');
  const vals = updates.map(([, v]) => v);
  db.prepare(`UPDATE habits SET ${set} WHERE id = ? AND user_id = ?`).run(...vals, habitId, userId);
}

function seedDefaultHabits(userId) {
  const defaults = [
    // Morning
    { name: 'Seeds mix',             cat: 'food',       target: null,   am: 1, pm: 0 },
    { name: 'Eggs / protein',        cat: 'food',       target: null,   am: 1, pm: 0 },
    { name: 'Vitamins & supplements',cat: 'supplement', target: null,   am: 1, pm: 0 },
    { name: 'Morning water',         cat: 'hydration',  target: '1L',   am: 1, pm: 0 },
    // Night
    { name: 'Pushups',               cat: 'exercise',   target: '150',  am: 0, pm: 1 },
    { name: 'Squats',                cat: 'exercise',   target: '150',  am: 0, pm: 1 },
    { name: 'Greens',                cat: 'food',       target: null,   am: 0, pm: 1 },
    { name: 'Magnesium',             cat: 'supplement', target: null,   am: 0, pm: 1 },
    { name: 'Total water intake',    cat: 'hydration',  target: '3L',   am: 0, pm: 1 },
  ];
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO habits (user_id, habit_name, category, target_value, notify_morning, notify_night)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const h of defaults) stmt.run(userId, h.name, h.cat, h.target, h.am, h.pm);
}

// ── Notifications ──────────────────────────────────────────────────────────
function getNotifications(userId) {
  return db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? AND active = 1 ORDER BY notification_time'
  ).all(userId);
}

function setDefaultNotifications(userId) {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO notifications (user_id, notification_time, notification_type) VALUES (?, ?, ?)').run(userId, '07:30', 'morning');
  db.prepare('INSERT INTO notifications (user_id, notification_time, notification_type) VALUES (?, ?, ?)').run(userId, '21:30', 'night');
}

function addNotification(userId, label, time) {
  db.prepare(
    'INSERT INTO notifications (user_id, notification_time, notification_type) VALUES (?, ?, ?)'
  ).run(userId, time, label.toLowerCase().slice(0, 30));
}

function removeNotification(notifId, userId) {
  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(notifId, userId);
}

function updateNotification(userId, type, time) {
  db.prepare(
    'UPDATE notifications SET notification_time = ? WHERE user_id = ? AND notification_type = ?'
  ).run(time, userId, type);
}

function updateNotificationById(notifId, userId, time) {
  db.prepare('UPDATE notifications SET notification_time = ? WHERE id = ? AND user_id = ?').run(time, notifId, userId);
}

function markNotificationSent(notifId, date) {
  db.prepare('UPDATE notifications SET last_sent = ? WHERE id = ?').run(date, notifId);
}

// ── Habit logs ─────────────────────────────────────────────────────────────
function logHabit(userId, habitId, date, value) {
  db.prepare(`
    INSERT INTO habit_logs (user_id, habit_id, date, completion_value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, habit_id, date) DO UPDATE
    SET completion_value = excluded.completion_value, logged_at = CURRENT_TIMESTAMP
  `).run(userId, habitId, date, value);
}

function getLog(userId, habitId, date) {
  return db.prepare(
    'SELECT * FROM habit_logs WHERE user_id = ? AND habit_id = ? AND date = ?'
  ).get(userId, habitId, date);
}

function getTodayLogs(userId, date) {
  return db.prepare(`
    SELECT hl.*, h.habit_name, h.category, h.target_value, h.notify_morning, h.notify_night
    FROM habit_logs hl
    JOIN habits h ON hl.habit_id = h.id
    WHERE hl.user_id = ? AND hl.date = ?
  `).all(userId, date);
}

function getRangeLogs(userId, startDate, endDate) {
  return db.prepare(`
    SELECT hl.*, h.habit_name, h.category, h.target_value, h.notify_morning, h.notify_night
    FROM habit_logs hl
    JOIN habits h ON hl.habit_id = h.id
    WHERE hl.user_id = ? AND hl.date >= ? AND hl.date <= ?
    ORDER BY hl.date
  `).all(userId, startDate, endDate);
}

// ── Habit-specific streak ──────────────────────────────────────────────────
function getHabitStreak(userId, habitId) {
  const rows = db.prepare(
    'SELECT date FROM habit_logs WHERE user_id = ? AND habit_id = ? AND completion_value > 0 ORDER BY date DESC'
  ).all(userId, habitId);
  if (!rows.length) return 0;
  let streak = 0;
  // Use UTC date string (same format as stored dates) to avoid local-timezone mismatch
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');
  for (const row of rows) {
    const d = new Date(row.date + 'T00:00:00');
    const diff = Math.round((today - d) / 86400000);
    if (diff === streak) streak++;
    else if (diff === streak + 1 && streak === 0) { streak++; }
    else break;
  }
  return streak;
}

// ── All-time personal best streak for a specific habit ─────────────────────
function getHabitPersonalBest(userId, habitId) {
  const rows = db.prepare(
    'SELECT date FROM habit_logs WHERE user_id = ? AND habit_id = ? AND completion_value > 0 ORDER BY date ASC'
  ).all(userId, habitId);
  if (!rows.length) return 0;
  let best = 1, current = 1;
  for (let i = 1; i < rows.length; i++) {
    const prev = new Date(rows[i-1].date + 'T00:00:00');
    const curr = new Date(rows[i].date + 'T00:00:00');
    const diff = Math.round((curr - prev) / 86400000);
    if (diff === 1) { current++; best = Math.max(best, current); }
    else { current = 1; }
  }
  return best;
}

// ── Last N days of logs for a specific habit (for heatmap) ─────────────────
function getHabitCalendar(userId, habitId, days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const endStr = end.toISOString().slice(0, 10);
  const startStr = start.toISOString().slice(0, 10);
  return db.prepare(
    'SELECT date, completion_value FROM habit_logs WHERE user_id = ? AND habit_id = ? AND date >= ? AND date <= ? ORDER BY date'
  ).all(userId, habitId, startStr, endStr);
}

// ── Add/update a text note on an existing log ──────────────────────────────
function updateLogNote(userId, habitId, date, note) {
  db.prepare('UPDATE habit_logs SET note = ? WHERE user_id = ? AND habit_id = ? AND date = ?').run(note, userId, habitId, date);
}

// ── Update sort_order for reordering ──────────────────────────────────────
function updateHabitOrder(habitId, userId, sortOrder) {
  db.prepare('UPDATE habits SET sort_order = ? WHERE id = ? AND user_id = ?').run(sortOrder, habitId, userId);
}

// ── Stats for a specific habit over N days ─────────────────────────────────
function getHabitStats(userId, habitId, days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  const endStr = end.toISOString().slice(0, 10);
  const startStr = start.toISOString().slice(0, 10);
  const logs = db.prepare(
    'SELECT date, completion_value FROM habit_logs WHERE user_id = ? AND habit_id = ? AND date >= ? AND date <= ?'
  ).all(userId, habitId, startStr, endStr);
  const logged = logs.length;
  const done100 = logs.filter(l => l.completion_value === 100).length;
  const total = logs.reduce((s, l) => s + l.completion_value, 0);
  const avgCompletion = logged ? Math.round(total / logged) : 0;
  const consistency = Math.round(logged / days * 100);
  return { logged, done100, avgCompletion, consistency, total };
}

// ── Users who have ZERO logs today ────────────────────────────────────────
function getUsersWithNoLogsToday(dateStr) {
  return db.prepare(
    'SELECT DISTINCT users.* FROM users WHERE id NOT IN (SELECT DISTINCT user_id FROM habit_logs WHERE date = ?)'
  ).all(dateStr);
}

// ── Pause / vacation mode ──────────────────────────────────────────────────
function pauseUser(telegramId, until) {
  db.prepare('UPDATE users SET paused_until = ? WHERE telegram_id = ?').run(until, String(telegramId));
}

function isUserPaused(user) {
  if (!user.paused_until) return false;
  const today = new Date().toISOString().split('T')[0];
  if (user.paused_until < today) {
    db.prepare('UPDATE users SET paused_until = NULL WHERE id = ?').run(user.id);
    return false;
  }
  return true;
}

// ── Habit packs ────────────────────────────────────────────────────────────
const HABIT_PACKS = {
  fitness: [
    { name: 'Morning walk',  cat: 'exercise',   target: '30 min' },
    { name: 'Pushups',       cat: 'exercise',   target: '100'    },
    { name: 'Squats',        cat: 'exercise',   target: '100'    },
    { name: 'Stretch',       cat: 'recovery',   target: null     },
  ],
  nutrition: [
    { name: 'Healthy breakfast', cat: 'food',       target: null  },
    { name: 'Greens',            cat: 'food',       target: null  },
    { name: 'No junk food',      cat: 'food',       target: null  },
    { name: 'Daily vitamins',    cat: 'supplement', target: null  },
  ],
  wellness: [
    { name: 'Water intake',  cat: 'hydration',  target: '3L'     },
    { name: 'Vitamins',      cat: 'supplement', target: null     },
    { name: 'Meditation',    cat: 'recovery',   target: '10 min' },
    { name: 'Sleep by 11pm', cat: 'recovery',   target: null     },
  ],
  recovery: [
    { name: 'Stretch',          cat: 'recovery',  target: '15 min' },
    { name: 'Cold shower',      cat: 'recovery',  target: null     },
    { name: 'Meditation',       cat: 'recovery',  target: '10 min' },
    { name: 'Screen-free hour', cat: 'recovery',  target: null     },
  ],
};

function seedHabitPack(userId, packName) {
  const habits = packName === 'all'
    ? Object.values(HABIT_PACKS).flat()
    : HABIT_PACKS[packName] || [];
  const checkStmt  = db.prepare('SELECT id FROM habits WHERE user_id = ? AND habit_name = ? AND active = 1');
  const insertStmt = db.prepare(`INSERT INTO habits (user_id, habit_name, category, target_value, notify_morning, notify_night) VALUES (?, ?, ?, ?, 1, 1)`);
  for (const h of habits) {
    if (!checkStmt.get(userId, h.name)) {
      insertStmt.run(userId, h.name, h.cat, h.target || null);
    }
  }
}

// ── Milestone celebrations ──────────────────────────────────────────────────
function checkAndCelebrateMilestone(userId, habitId, streak) {
  const thresholds = [3, 7, 14, 21, 30, 50, 66, 100];
  const milestone = thresholds.filter(t => t <= streak).pop();
  if (!milestone) return null;
  const existing = db.prepare(
    'SELECT id FROM milestone_log WHERE user_id = ? AND habit_id = ? AND milestone = ?'
  ).get(userId, habitId, milestone);
  if (existing) return null;
  try {
    db.prepare(
      'INSERT INTO milestone_log (user_id, habit_id, milestone) VALUES (?, ?, ?)'
    ).run(userId, habitId, milestone);
    return milestone;
  } catch(e) {
    return null;
  }
}

// ── Streak freezes ──────────────────────────────────────────────────────────
function getStreakFreezes(userId) {
  return db.prepare('SELECT streak_freezes, freeze_used_date FROM users WHERE id = ?').get(userId);
}

function addStreakFreeze(userId, count = 1) {
  db.prepare('UPDATE users SET streak_freezes = MIN(streak_freezes + ?, 3) WHERE id = ?').run(count, userId);
}

function useStreakFreeze(telegramId, date) {
  db.prepare('UPDATE users SET streak_freezes = streak_freezes - 1, freeze_used_date = ? WHERE telegram_id = ? AND streak_freezes > 0').run(date, String(telegramId));
}

// ── Habit correlation engine ────────────────────────────────────────────────
function getCorrelations(userId) {
  const habits = getHabits(userId);
  if (habits.length < 2) return [];
  const startDate = new Date(Date.now() - 60*86400000).toISOString().split('T')[0];
  const endDate = new Date().toISOString().split('T')[0];
  const logs = getRangeLogs(userId, startDate, endDate);
  const allDates = [...new Set(logs.map(l => l.date))];
  if (allDates.length < 10) return [];
  const results = [];
  for (const habitA of habits) {
    const daysA = allDates.filter(d => logs.find(l => l.habit_id === habitA.id && l.date === d && l.completion_value > 0));
    if (daysA.length < 5) continue;
    for (const habitB of habits) {
      if (habitA.id === habitB.id) continue;
      const daysB = allDates.filter(d => logs.find(l => l.habit_id === habitB.id && l.date === d && l.completion_value > 0));
      const baseline = Math.round(daysB.length / allDates.length * 100);
      const coOccur = daysA.filter(d => logs.find(l => l.habit_id === habitB.id && l.date === d && l.completion_value > 0));
      if (coOccur.length < 3) continue;
      const correlation = Math.round(coOccur.length / daysA.length * 100);
      const lift = correlation - baseline;
      if (lift >= 15) {
        results.push({ habitA: habitA.habit_name, habitB: habitB.habit_name, correlation, baseline, lift });
      }
    }
  }
  return results.sort((a, b) => b.lift - a.lift).slice(0, 5);
}

module.exports = {
  getDb,
  getOrCreateUser, getUser, updateUserTimezone, getAllUsers, getActiveUsers,
  getHabit, getHabits, addHabit, removeHabit, updateHabit, seedDefaultHabits,
  getNotifications, setDefaultNotifications, updateNotification, updateNotificationById,
  addNotification, removeNotification, markNotificationSent,
  logHabit, getLog, getTodayLogs, getRangeLogs,
  getStreak,
  getHabitStreak, getHabitPersonalBest, getHabitCalendar,
  updateLogNote, updateHabitOrder, getHabitStats, getUsersWithNoLogsToday,
  pauseUser, isUserPaused,
  HABIT_PACKS, seedHabitPack,
  checkAndCelebrateMilestone,
  getStreakFreezes, addStreakFreeze, useStreakFreeze,
  getCorrelations,
};
