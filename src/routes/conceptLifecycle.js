// Archive / Kill / Remove Test Concept -- see lib/conceptLifecycle.js for the rules. One pair of endpoints serves every
// screen (Concept Development, Shooting, Editing, Final Approval, Ad Setup), because the rules depend on the concept's
// real state, never on which screen the button was clicked from.
const express = require('express');
const { describe, applyAction, LifecycleError } = require('../lib/conceptLifecycle');

const router = express.Router();

// What can be done to this concept, and what it would affect (drives the ... menu and the confirmation).
router.get('/:id', async (req, res, next) => {
  try {
    const out = await describe(Number(req.params.id), req.user);
    if (!out) return res.status(404).json({ error: 'Concept not found.' });
    res.json(out);
  } catch (err) { next(err); }
});

router.post('/:id/:action', async (req, res, next) => {
  try {
    const { confirm, reason } = req.body || {};
    if (confirm !== true) return res.status(400).json({ error: 'This action needs an explicit confirmation (confirm: true).' });
    const out = await applyAction(Number(req.params.id), req.params.action, req.user, { reason });
    res.json(out);
  } catch (err) {
    if (err instanceof LifecycleError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
