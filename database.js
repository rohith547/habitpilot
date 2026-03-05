const Database = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
const config    = require('./config');

let db;

function getDb() {
  if (db) return db;
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

function updateNotification(userId, type, time) {
  db.prepare(
    'UPDATE notifications SET notification_time = ? WHERE user_id = ? AND notification_type = ?'
  ).run(time, userId, type);
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

module.exports = {
  getDb,
  getOrCreateUser, getUser, updateUserTimezone, getAllUsers, getActiveUsers,
  getHabits, addHabit, removeHabit, seedDefaultHabits,
  getNotifications, setDefaultNotifications, updateNotification, markNotificationSent,
  logHabit, getLog, getTodayLogs, getRangeLogs,
};
