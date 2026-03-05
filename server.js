const express = require('express');
const { PORT } = require('./config');

const app = express();
app.get('/health', (_, res) => res.send('ok'));
app.listen(PORT, () => console.log(`[Server] Health check on :${PORT}`));
