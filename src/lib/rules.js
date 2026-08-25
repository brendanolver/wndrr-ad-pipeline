// The one business rule the brief calls out as "enforce, not just describe":
// a New Drop style can only move its creative asset into Filming if that
// asset is a Tested/Proven concept, unless it's explicitly flagged as a
// deliberate new-concept trial.

class RuleViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleViolationError';
    this.statusCode = 422;
  }
}

function assertCanEnterFilming({ styleTier, conceptClassification, isDeliberateTrial }) {
  if (styleTier !== 'new_drop') return;
  if (conceptClassification === 'tested_proven') return;
  if (isDeliberateTrial) return;

  throw new RuleViolationError(
    'New Drop styles can only move into Filming with a Tested/Proven concept, ' +
      'unless the creative asset is explicitly marked as a deliberate new-concept trial.'
  );
}

module.exports = { RuleViolationError, assertCanEnterFilming };
