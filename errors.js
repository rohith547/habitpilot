const MAX = 50;
const buffer = [];

function logError(context, err, telegramId = null) {
  buffer.push({
    ts: new Date().toISOString(),
    context,
    message: err.message || String(err),
    stack: err.stack?.split('\n')[1]?.trim() || '',
    telegramId,
  });
  if (buffer.length > MAX) buffer.shift();
  console.error(`[${context}]`, err.message);
}

function getRecent(n = 10) {
  return buffer.slice(-n).reverse();
}

module.exports = { logError, getRecent };
