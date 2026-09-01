// Single source of truth for the Kanban column order and the handoff
// owner field each status maps to.

const STATUSES = [
  'not_started',
  'awaiting_proven_concept',
  'awaiting_concept_development',
  'concept_script',
  'filming',
  'editing',
  'qc',
  'uploaded_live',
];

const STATUS_LABELS = {
  not_started: 'Not Started',
  awaiting_proven_concept: 'Awaiting Proven Concept',
  awaiting_concept_development: 'Awaiting Concept Development',
  concept_script: 'Concept/Script',
  filming: 'Filming',
  editing: 'Editing',
  qc: 'QC',
  uploaded_live: 'Uploaded/Live',
};

// Which owner field represents "who's holding this right now" for a given
// status. Statuses before filming sit with strategy; QC covers the
// QC/upload handoff.
const STATUS_OWNER_FIELD = {
  not_started: 'strategy_owner',
  awaiting_proven_concept: 'strategy_owner',
  awaiting_concept_development: 'strategy_owner',
  concept_script: 'strategy_owner',
  filming: 'filming_owner',
  editing: 'editing_owner',
  qc: 'qc_owner',
  uploaded_live: 'qc_owner',
};

const CONCEPT_CLASSIFICATIONS = ['tested_proven', 'new_experimental'];
const TIERS = ['core_proven', 'new_drop'];
const FORMATS = ['video', 'static'];

// Concept Development's own simple review status -- separate from STATUSES
// above (the full production pipeline). This just tracks how ready a
// concept is for the Tuesday review meeting.
const CONCEPT_DEV_STATUSES = ['not_started', 'in_development', 'ready_for_review', 'changes_required', 'approved', 'killed'];
const CONCEPT_DEV_STATUS_LABELS = {
  not_started: 'Not Started',
  in_development: 'In Development',
  ready_for_review: 'Ready for Review',
  changes_required: 'Changes Required',
  approved: 'Approved',
  killed: 'Killed',
};

// Tuesday Creative Review's own three decisions -- the only concept_dev_status
// values a review decision is ever allowed to move a concept INTO (see
// PATCH /concept-development/concepts/:id/review).
const TUESDAY_REVIEW_DECISIONS = ['approved', 'changes_required', 'killed'];

module.exports = {
  STATUSES,
  STATUS_LABELS,
  STATUS_OWNER_FIELD,
  CONCEPT_CLASSIFICATIONS,
  TIERS,
  FORMATS,
  CONCEPT_DEV_STATUSES,
  CONCEPT_DEV_STATUS_LABELS,
  TUESDAY_REVIEW_DECISIONS,
};
