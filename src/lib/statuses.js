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

module.exports = {
  STATUSES,
  STATUS_LABELS,
  STATUS_OWNER_FIELD,
  CONCEPT_CLASSIFICATIONS,
  TIERS,
  FORMATS,
};
