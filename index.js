require('./server');
require('./database').getDb();
require('./telegram');
require('./scheduler');

console.log('[HabitPilot] ✅ Running.');
