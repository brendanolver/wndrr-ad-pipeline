require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { runMigrations } = require('./db');
const { requireAuth } = require('./auth');
const { warmAmCache } = require('./lib/apparelmagic');
const { warmPipelineCache } = require('./lib/reportPipeline');
const { warmMetaAdsCache } = require('./lib/metaAds');

const authRoutes = require('./routes/auth');
const styleRoutes = require('./routes/styles');
const categoryRoutes = require('./routes/categories');
const creativeAssetRoutes = require('./routes/creativeAssets');
const boardRoutes = require('./routes/board');
const dashboardRoutes = require('./routes/dashboard');
const dropRoutes = require('./routes/drops');
const creativeTargetRuleRoutes = require('./routes/creativeTargetRules');
const debugRoutes = require('./routes/debug');
const provenWinnerRoutes = require('./routes/provenWinners');
const { router: dropProductPlanRoutes } = require('./routes/dropProductPlans');
const conceptDevelopmentRoutes = require('./routes/conceptDevelopment');
const planningSettingsRoutes = require('./routes/planningSettings');
const coreProductRoutes = require('./routes/coreProducts');
const shootPlanRoutes = require('./routes/shootPlan');
const contentCreatorRoutes = require('./routes/contentCreators');
const highStockProductRoutes = require('./routes/highStockProducts');
const promotionRoutes = require('./routes/promotions');
const weeklyShootPlanConfirmationRoutes = require('./routes/weeklyShootPlanConfirmation');
const weeklyPlanningProgressRoutes = require('./routes/weeklyPlanningProgress');
const salesCadenceRoutes = require('./routes/salesCadence');
const metaProductMappingRoutes = require('./routes/metaProductMappings');

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
app.use('/api/creative-target-rules', requireAuth, creativeTargetRuleRoutes);
app.use('/api/debug', requireAuth, debugRoutes);
app.use('/api/proven-winners', requireAuth, provenWinnerRoutes);
app.use('/api/drop-product-plans', requireAuth, dropProductPlanRoutes);
app.use('/api/concept-development', requireAuth, conceptDevelopmentRoutes);
app.use('/api/planning-settings', requireAuth, planningSettingsRoutes);
app.use('/api/core-products', requireAuth, coreProductRoutes);
app.use('/api/shoot-plan', requireAuth, shootPlanRoutes);
app.use('/api/content-creators', requireAuth, contentCreatorRoutes);
app.use('/api/high-stock-products', requireAuth, highStockProductRoutes);
app.use('/api/promotions', requireAuth, promotionRoutes);
app.use('/api/weekly-shoot-plan-confirmation', requireAuth, weeklyShootPlanConfirmationRoutes);
app.use('/api/weekly-planning-progress', requireAuth, weeklyPlanningProgressRoutes);
app.use('/api/sales-cadence', requireAuth, salesCadenceRoutes);
app.use('/api/meta-product-mappings', requireAuth, metaProductMappingRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await runMigrations();
  warmAmCache(); // fire-and-forget -- don't block server startup on a multi-minute AM crawl
  warmPipelineCache(); // fire-and-forget -- same reasoning, for the Report Pipeline's tier CSV
  warmMetaAdsCache(); // fire-and-forget -- same reasoning, for Meta's live ad list
  app.listen(PORT, () => {
    console.log(`WNDRR Ad Pipeline listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
