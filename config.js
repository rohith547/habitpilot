require('dotenv').config();

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID   = process.env.ADMIN_TELEGRAM_ID;
const DB_PATH    = process.env.DB_PATH || './data/habits.db';
const PORT       = parseInt(process.env.PORT || '3000');

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

module.exports = { BOT_TOKEN, ADMIN_ID, DB_PATH, PORT };
