// ── Date helpers ───────────────────────────────────────────────────────────

function getToday(timezone = 'America/Chicago') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

function getUserTime(timezone = 'America/Chicago') {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).slice(0, 5); // "HH:MM"
}

// ── Completion helpers ─────────────────────────────────────────────────────

function completionLabel(val) {
  if (val === 100) return '✅';
  if (val === 50)  return '🔶';
  if (val === 25)  return '🔸';
  return '⬜';
}

function categoryEmoji(cat) {
  return { food: '🥗', supplement: '💊', exercise: '💪', hydration: '💧', recovery: '😴' }[cat] || '📌';
}

function extractNumber(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+(\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// ── Keyboard builder ───────────────────────────────────────────────────────

function buildLogKeyboard(habitId, date, currentVal = -1) {
  const mark = (v) => currentVal === v ? '·' : '';
  return {
    inline_keyboard: [[
      { text: `${mark(0)}✗`,    callback_data: `log:${habitId}:0:${date}` },
      { text: `${mark(25)}25%`, callback_data: `log:${habitId}:25:${date}` },
      { text: `${mark(50)}50%`, callback_data: `log:${habitId}:50:${date}` },
      { text: `${mark(100)}✓`,  callback_data: `log:${habitId}:100:${date}` },
    ]],
  };
}

// ── Default habits ─────────────────────────────────────────────────────────
// Imported by database.js — re-exported here for use in telegram.js
const { seedDefaultHabits } = require('./database');

module.exports = {
  getToday, getUserTime,
  completionLabel, categoryEmoji, extractNumber,
  buildLogKeyboard,
  seedDefaultHabits,
};
