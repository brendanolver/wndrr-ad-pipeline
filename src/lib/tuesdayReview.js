// Tuesday Review eligibility. A concept enters review only when someone explicitly submits it via Ready for Review in
// Concept Development (or it already carries a review decision). Drafts (not_started / in_development) never appear.
// A killed concept shows only if it was actually submitted or reviewed: killing a draft from Concept Development
// ("Kill Concept") must not create a review record.
function isInTuesdayReview(concept) {
  const s = concept && concept.concept_dev_status;
  if (s === 'ready_for_review' || s === 'changes_required' || s === 'approved') return true;
  if (s === 'killed') return Boolean(concept.submitted_for_review_at || concept.reviewed_at);
  return false;
}

module.exports = { isInTuesdayReview };
