require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { runMigrations } = require('./db');
const { requireAuth } = require('./auth');
const { requireModuleAccess } = require('./lib/permissions');
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
const conceptTypeRoutes = require('./routes/conceptTypes');
const planningSettingsRoutes = require('./routes/planningSettings');
const { router: coreProductRoutes } = require('./routes/coreProducts');
const shootPlanRoutes = require('./routes/shootPlan');
const contentCreatorRoutes = require('./routes/contentCreators');
const { router: highStockProductRoutes } = require('./routes/highStockProducts');
const promotionRoutes = require('./routes/promotions');
const weeklyShootPlanConfirmationRoutes = require('./routes/weeklyShootPlanConfirmation');
const weeklyPlanningProgressRoutes = require('./routes/weeklyPlanningProgress');
const salesCadenceRoutes = require('./routes/salesCadence');
const metaProductMappingRoutes = require('./routes/metaProductMappings');
const creativeResourceRoutes = require('./routes/creativeResources');
const creativeToolkitRoutes = require('./routes/creativeToolkit');
const customerAvatarRoutes = require('./routes/customerAvatars');
const shootingRoutes = require('./routes/shooting');
const referenceLibraryRoutes = require('./routes/referenceLibrary');
const userRoutes = require('./routes/users');
const editingRoutes = require('./routes/editing');
const finalApprovalRoutes = require('./routes/finalApproval');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

// Round 11 module-route protection: applied only where a route mount is
// unambiguously and exclusively one sidebar module's own backing API (see
// the Round 11 brief, item 12 and permissions.js's requireModuleAccess
// comment). Several mounts below are deliberately left ungated because
// they're shared across multiple modules with different access (e.g.
// creative-assets is read by Board/Concept Dev/Shooting/Editing alike;
// concept-development backs BOTH Concept Dev and Tuesday Review, which can
// have different access) -- gating those by a single module key would risk
// breaking a page a user IS allowed into. That gap is reported explicitly
// rather than silently presented as covered -- see the Round 11 report's
// "route/API protection" section.
app.use('/api/auth', authRoutes);
app.use('/api/styles', requireAuth, requireModuleAccess('admin'), styleRoutes);
app.use('/api/categories', requireAuth, requireModuleAccess('admin'), categoryRoutes);
app.use('/api/creative-assets', requireAuth, creativeAssetRoutes);
app.use('/api/board', requireAuth, requireModuleAccess('board'), boardRoutes);
app.use('/api/dashboard', requireAuth, requireModuleAccess('dashboard'), dashboardRoutes);
app.use('/api/drops', requireAuth, requireModuleAccess('drops'), dropRoutes);
app.use('/api/creative-target-rules', requireAuth, requireModuleAccess('planning'), creativeTargetRuleRoutes);
app.use('/api/debug', requireAuth, requireModuleAccess('planning'), debugRoutes);
app.use('/api/proven-winners', requireAuth, provenWinnerRoutes);
app.use('/api/drop-product-plans', requireAuth, dropProductPlanRoutes);
app.use('/api/concept-development', requireAuth, conceptDevelopmentRoutes);
app.use('/api/concept-types', requireAuth, conceptTypeRoutes);
app.use('/api/shooting', requireAuth, requireModuleAccess('shooting'), shootingRoutes);
app.use('/api/planning-settings', requireAuth, requireModuleAccess('planning'), planningSettingsRoutes);
app.use('/api/core-products', requireAuth, requireModuleAccess('planning'), coreProductRoutes);
app.use('/api/shoot-plan', requireAuth, requireModuleAccess('planning'), shootPlanRoutes);
app.use('/api/content-creators', requireAuth, contentCreatorRoutes);
app.use('/api/high-stock-products', requireAuth, requireModuleAccess('planning'), highStockProductRoutes);
app.use('/api/promotions', requireAuth, requireModuleAccess('promotions'), promotionRoutes);
app.use('/api/weekly-shoot-plan-confirmation', requireAuth, requireModuleAccess('planning'), weeklyShootPlanConfirmationRoutes);
app.use('/api/weekly-planning-progress', requireAuth, requireModuleAccess('planning'), weeklyPlanningProgressRoutes);
app.use('/api/sales-cadence', requireAuth, requireModuleAccess('planning'), salesCadenceRoutes);
app.use('/api/meta-product-mappings', requireAuth, metaProductMappingRoutes);
app.use('/api/creative-resources', requireAuth, creativeResourceRoutes);
app.use('/api/creative-toolkit', requireAuth, creativeToolkitRoutes);
app.use('/api/customer-avatars', requireAuth, customerAvatarRoutes);
app.use('/api/reference-library', requireAuth, requireModuleAccess('reference-library'), referenceLibraryRoutes);
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/editing', requireAuth, requireModuleAccess('editing'), editingRoutes);
app.use('/api/final-approval', requireAuth, requireModuleAccess('final-approval'), finalApprovalRoutes);

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
