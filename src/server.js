require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { runMigrations } = require('./db');
const { requireAuth } = require('./auth');
const { requireModuleAccess, requireAnyModuleAccess } = require('./lib/permissions');
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
const adSetupRoutes = require('./routes/adSetup');
const moveBackRoutes = require('./routes/moveBack');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

// Round 11 module-route protection: applied only where a route mount is
// unambiguously and exclusively one sidebar module's own backing API (see
// the Round 11 brief, item 12 and permissions.js's requireModuleAccess
// comment). concept-development is still deliberately left ungated -- it
// backs BOTH Concept Dev and Tuesday Review, which today always carry the
// SAME access (nobody is restricted from exactly one of the two), but a
// single module key would be wrong the moment that stops being true. That
// gap is reported explicitly rather than silently presented as covered --
// see the Round 11 report's "route/API protection" section.
//
// Production-readiness audit fix: creative-assets, proven-winners and
// drop-product-plans were the same kind of gap and are now closed.
// - proven-winners is single-module in practice (Settings' Proven Winners
//   admin screen is its only real caller -- see loadProductPlan/
//   generateOrTopUpPlan, which read the table directly server-side, never
//   through this route), so a plain requireModuleAccess('planning') fits.
// - drop-product-plans is exclusively Upcoming Drops' own Required
//   Concepts feature (product detail page) -- gating it by 'planning'
//   would have been wrong (it would have blocked Mark/Tllestio/Ronit from
//   a page they ARE allowed into); 'drops' is the module that actually
//   owns it.
// - creative-assets is genuinely different: confirmed by tracing every
//   frontend call site that it's shared, in real, active use, by Board's
//   legacy asset modal AND Concept Dev's delete action AND Editing's
//   editing_owner reassignment AND Drops' Existing Concepts/Required
//   Concepts flows AND Promotion Concept Dev's assignee action -- there is
//   no clean per-action split into "Board-only" vs "shared" without a
//   deeper route refactor that risks breaking one of those real workflows.
//   requireAnyModuleAccess blocks a user who legitimately has NONE of
//   these modules (nobody today, but a real future restriction combination
//   could) while never blocking anyone who has a genuine reason to be
//   here, which is every restricted user this app currently has.
app.use('/api/auth', authRoutes);
app.use('/api/styles', requireAuth, requireModuleAccess('admin'), styleRoutes);
app.use('/api/categories', requireAuth, requireModuleAccess('admin'), categoryRoutes);
app.use(
  '/api/creative-assets',
  requireAuth,
  requireAnyModuleAccess('board', 'concept-dev', 'tuesday-review', 'shooting', 'editing', 'final-approval', 'drops', 'promotions'),
  creativeAssetRoutes
);
app.use('/api/board', requireAuth, requireModuleAccess('board'), boardRoutes);
app.use('/api/dashboard', requireAuth, requireModuleAccess('dashboard'), dashboardRoutes);
app.use('/api/drops', requireAuth, requireModuleAccess('drops'), dropRoutes);
app.use('/api/creative-target-rules', requireAuth, requireModuleAccess('planning'), creativeTargetRuleRoutes);
app.use('/api/debug', requireAuth, requireModuleAccess('planning'), debugRoutes);
app.use('/api/proven-winners', requireAuth, requireModuleAccess('planning'), provenWinnerRoutes);
app.use('/api/drop-product-plans', requireAuth, requireModuleAccess('drops'), dropProductPlanRoutes);
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
// Ad Setup/Approved (see Part C brief) stay inside Final Approval's own
// existing module key for this first version -- no new permission key,
// per the brief's explicit preference, since nothing about who's allowed
// to see Ad Setup differs from who's allowed to see Final Approval today.
app.use('/api/ad-setup', requireAuth, requireModuleAccess('final-approval'), adSetupRoutes);
// Move Back (QA/testing + workflow correction) touches a concept across
// every stage it can be sent back through, so -- like creative-assets --
// it's gated by requireAnyModuleAccess rather than a single module; the
// route file itself additionally requires requireAdmin on every action,
// since sending real in-flight work backward is a much higher-consequence
// action than viewing/editing within a module a user already has.
app.use(
  '/api/move-back',
  requireAuth,
  requireAnyModuleAccess('concept-dev', 'tuesday-review', 'shooting', 'editing', 'final-approval'),
  moveBackRoutes
);

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
