require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { runMigrations } = require('./db');
const { requireAuth } = require('./auth');
const { warmAmCache } = require('./lib/apparelmagic');

const authRoutes = require('./routes/auth');
const styleRoutes = require('./routes/styles');
const categoryRoutes = require('./routes/categories');
const creativeAssetRoutes = require('./routes/creativeAssets');
const boardRoutes = require('./routes/board');
const dashboardRoutes = require('./routes/dashboard');
const dropRoutes = require('./routes/drops');
const creativeJobRoutes = require('./routes/creativeJobs');
const creativeTargetRuleRoutes = require('./routes/creativeTargetRules');
const debugRoutes = require('./routes/debug');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/styles', requireAuth, styleRoutes);
app.use('/api/categories', requireAuth, categoryRoutes);
app.use('/api/creative-assets', requireAuth, creativeAssetRoutes);
app.use('/api/board', requireAuth, boardRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/drops', requireAuth, dropRoutes);
app.use('/api/creative-jobs', requireAuth, creativeJobRoutes);
app.use('/api/creative-target-rules', requireAuth, creativeTargetRuleRoutes);
app.use('/api/debug', requireAuth, debugRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await runMigrations();
  warmAmCache(); // fire-and-forget -- don't block server startup on a multi-minute AM crawl
  app.listen(PORT, () => {
    console.log(`WNDRR Ad Pipeline listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
