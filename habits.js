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
  const btn = (label, v) => ({
    text: currentVal === v ? `· ${label}` : label,
    callback_data: `log:${habitId}:${v}:${date}`,
  });
  return {
    inline_keyboard: [[
      btn('✗ Skip', 0),
      btn('25%',    25),
      btn('50%',    50),
      btn('✓ Done', 100),
    ]],
  };
}

// ── Default habits ─────────────────────────────────────────────────────────
// Imported by database.js — re-exported here for use in telegram.js
const { seedDefaultHabits } = require('./database');

// ── Heatmap builder ────────────────────────────────────────────────────────
function buildHeatmap(calendarLogs, days = 28) {
  const logMap = {};
  for (const l of calendarLogs) logMap[l.date] = l.completion_value;
  const cells = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const val = logMap[dateStr];
    if (val === undefined) cells.push('⬜');
    else if (val === 100) cells.push('🟩');
    else if (val >= 50) cells.push('🟨');
    else if (val > 0) cells.push('🟧');
    else cells.push('🟥');
  }
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7).join(''));
  return rows.join('\n');
}

// ── All-done keyboard ──────────────────────────────────────────────────────
function buildAllDoneKeyboard(date) {
  return { inline_keyboard: [[{ text: '✅ Mark all done today', callback_data: `alldone:${date}` }]] };
}

module.exports = {
  getToday, getUserTime,
  completionLabel, categoryEmoji, extractNumber,
  buildLogKeyboard,
  buildHeatmap,
  buildAllDoneKeyboard,
  seedDefaultHabits,
};
