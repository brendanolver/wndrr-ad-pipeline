// Concept lifecycle: one consistent way to take an unwanted concept out of the active pipeline without
// walking it backward through every stage first.
//
//   archive      the concept leaves every active queue and count; the row and ALL its history stay; restorable.
//   kill         the concept will not proceed (concept_dev_status = 'killed', reason kept); row and history stay.
//   remove_test  admin only: permanently deletes a disposable concept and what hangs off it (shoot schedule,
//                final edit rows, ad-setup drafts, status history). A JSON snapshot is written to
//                concept_lifecycle_log first, so what was removed stays auditable.
//
// Hard rules (enforced server-side, evaluated fresh from the database on every call):
//   * a published concept (status uploaded_live), an approved Ad Setup, or a concept whose ad setup is matched to a real
//     Meta ad can never be killed or deleted here -- only archived. Meta ads are never touched by any action.
//   * nothing external is touched: a Final Edit's link is just a row; no file, Drive/Frame.io item or Meta record is deleted.
//   * every action is idempotent (repeating it reports "already done" rather than failing or doing it twice).

// The pool is required lazily so the pure rules (evaluateLifecycle) can be unit-tested without a database.
const getPool = () => require('../db').pool;

const STAGE_LABELS = {
  'concept-dev': 'Concept Development',
  'tuesday-review': 'Tuesday Review',
  shooting: 'Shooting',
  editing: 'Editing',
  'final-approval': 'Final Approval',
  'ad-setup': 'Ad Setup',
  approved: 'Approved',
};

// SQL fragments shared by every active queue so "active" means one thing everywhere.
const ACTIVE_CONCEPT_SQL = "ca.archived_at IS NULL AND ca.concept_dev_status <> 'killed'";

const ACTION_LABELS = {
  archive: 'Archive Concept',
  unarchive: 'Restore Concept',
  kill: 'Kill Concept',
  remove_test: 'Remove Test Concept',
};

// Pure: from the facts about one concept, what may be done and what it will affect.
// facts: { id, name, stage, archived, killed, published, approvedAdSetup, metaLinked,
//          counts: { finalEdits, adSetups, shoot (bool), shot (bool), historyRows, siblings } }
function evaluateLifecycle(facts, { isAdmin = false } = {}) {
  const f = facts;
  const c = f.counts || {};
  const stageLabel = STAGE_LABELS[f.stage] || f.stage;
  const protectedReason = f.published
    ? 'This creative has been published to Meta, so its history must stay.'
    : f.metaLinked
      ? 'A live Meta ad is matched to this creative, so its history must stay.'
      : f.approvedAdSetup
        ? 'Its Ad Setup has been approved for Meta, so its history must stay.'
        : null;

  const consequences = [];
  if (c.shoot && !c.shot) consequences.push('It is scheduled for shooting; that booking leaves the Shooting calendar.');
  if (c.shot) consequences.push('Filming is already marked done; the footage itself is not touched.');
  if (c.finalEdits) consequences.push(`${c.finalEdits} final edit record${c.finalEdits === 1 ? '' : 's'} (links only, no files) stay attached.`);
  if (c.adSetups) consequences.push(`${c.adSetups} Ad Setup draft${c.adSetups === 1 ? '' : 's'} leave the Ad Setup queue.`);

  const actions = [];
  if (f.archived) {
    actions.push({ key: 'unarchive', label: ACTION_LABELS.unarchive, allowed: true, reason: null,
      description: 'Puts the concept back where it was. Nothing else changes.' });
  } else {
    actions.push({ key: 'archive', label: ACTION_LABELS.archive, allowed: true, reason: null,
      description: 'Removes it from every active queue and count. Its history is kept and it can be restored.' });
    const canKill = !f.killed && !protectedReason;
    actions.push({ key: 'kill', label: ACTION_LABELS.kill, allowed: canKill,
      reason: f.killed ? 'Already killed.' : protectedReason,
      description: 'Marks it as a legitimate concept that will not proceed. Reason and history are kept.' });
  }
  const canRemove = isAdmin && !protectedReason;
  actions.push({ key: 'remove_test', label: ACTION_LABELS.remove_test, allowed: canRemove,
    reason: !isAdmin ? 'Only an admin can permanently remove a concept.' : protectedReason,
    description: 'Permanently deletes a disposable test concept and its drafts. A record of what was removed is kept in the audit log.',
    destructive: true });

  return {
    id: f.id, name: f.name, stage: f.stage, stage_label: stageLabel, archived: !!f.archived, killed: !!f.killed,
    protected: !!protectedReason, protected_reason: protectedReason, consequences, actions,
  };
}

// Reads every fact the rules need, from the database (never trusted from the client).
async function loadFacts(db, id) {
  const { loadMoveBackState } = require('../routes/moveBack');
  const state = await loadMoveBackState(id);
  if (!state) return null;
  const c = state.concept;
  const q = (sql, params) => db.query(sql, params).then((r) => r.rows[0] || {});
  const ad = await q(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE au.status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM meta_ads ma WHERE ma.matched_ad_setup_id = au.id))::int AS meta_linked
       FROM ad_setups au WHERE au.creative_asset_id = $1`, [id]);
  const fe = await q('SELECT COUNT(*)::int AS n FROM final_edits WHERE creative_asset_id = $1', [id]);
  const hist = await q('SELECT COUNT(*)::int AS n FROM status_history WHERE creative_asset_id = $1', [id]);
  return {
    id: c.id, name: c.concept_name, stage: state.currentStage,
    archived: !!c.archived_at, killed: c.concept_dev_status === 'killed',
    published: c.status === 'uploaded_live',
    approvedAdSetup: ad.approved > 0 || !!c.ad_setup_approved_at,
    metaLinked: ad.meta_linked > 0,
    counts: { finalEdits: fe.n || 0, adSetups: ad.n || 0, shoot: !!c.shoot_schedule_id, shot: c.shoot_status === 'shot', historyRows: hist.n || 0 },
    row: c,
  };
}

async function describe(id, user) {
  const facts = await loadFacts(getPool(), id);
  if (!facts) return null;
  return evaluateLifecycle(facts, { isAdmin: !!(user && user.role === 'admin') });
}

class LifecycleError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function log(client, facts, action, user, reason, extra = {}) {
  await client.query(
    `INSERT INTO concept_lifecycle_log (creative_asset_id, concept_name, action, stage, actor_user_id, reason, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [facts.id, facts.name, action, facts.stage, user ? user.id : null, reason || null,
      JSON.stringify({ ...extra, counts: facts.counts, concept: facts.row ? snapshotRow(facts.row) : null })]
  );
}

function snapshotRow(r) {
  const keep = ['id', 'concept_name', 'status', 'concept_dev_status', 'format', 'concept_type', 'angle', 'hook', 'hook_variations', 'shoot_plan_item_id',
    'concept_assignee', 'filming_owner', 'editing_owner', 'final_approval_status', 'editing_submitted_at', 'created_at', 'kill_reason', 'kill_note'];
  const out = {};
  for (const k of keep) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

// Applies one action inside a transaction. Returns { ok, already, action, ... }.
async function applyAction(id, action, user, { reason } = {}) {
  if (!ACTION_LABELS[action]) throw new LifecycleError(400, `Unknown action "${action}".`);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT id FROM creative_assets WHERE id = $1 FOR UPDATE', [id]);
    if (!lock.rows.length) {
      await client.query('ROLLBACK');
      if (action === 'remove_test') {
        const prior = await getPool().query("SELECT 1 FROM concept_lifecycle_log WHERE creative_asset_id = $1 AND action IN ('remove_test', 'remove_workspace') LIMIT 1", [id]);
        if (prior.rows.length) return { ok: true, already: true, action };
      }
      throw new LifecycleError(404, 'Concept not found.');
    }
    const facts = await loadFacts(client, id);
    const verdict = evaluateLifecycle(facts, { isAdmin: !!(user && user.role === 'admin') });
    const entry = verdict.actions.find((a) => a.key === action);

    if (action === 'archive' && facts.archived) { await client.query('ROLLBACK'); return { ok: true, already: true, action }; }
    if (action === 'unarchive' && !facts.archived) { await client.query('ROLLBACK'); return { ok: true, already: true, action }; }
    if (action === 'kill' && facts.killed) { await client.query('ROLLBACK'); return { ok: true, already: true, action }; }
    if (!entry || !entry.allowed) {
      await client.query('ROLLBACK');
      throw new LifecycleError(entry && /admin/.test(entry.reason || '') ? 403 : 409, (entry && entry.reason) || 'That action is not available for this concept.');
    }

    const note = reason && String(reason).trim() ? String(reason).trim().slice(0, 500) : null;
    if (action === 'archive') {
      await client.query(
        `UPDATE creative_assets SET archived_at = now(), archived_by_user_id = $2, archive_reason = $3, archived_from_stage = $4, updated_at = now() WHERE id = $1`,
        [id, user ? user.id : null, note, facts.stage]);
      await log(client, facts, 'archive', user, note);
    } else if (action === 'unarchive') {
      await client.query(
        `UPDATE creative_assets SET archived_at = NULL, archived_by_user_id = NULL, archive_reason = NULL, archived_from_stage = NULL, updated_at = now() WHERE id = $1`, [id]);
      await log(client, facts, 'unarchive', user, note);
    } else if (action === 'kill') {
      await client.query(
        `UPDATE creative_assets SET concept_dev_status = 'killed', kill_reason = COALESCE($2, kill_reason), kill_note = COALESCE($3, kill_note), updated_at = now() WHERE id = $1`,
        [id, note ? 'Other' : null, note]);
      await log(client, facts, 'kill', user, note);
    } else if (action === 'remove_test') {
      await log(client, facts, 'remove_test', user, note, { removed: { final_edits: facts.counts.finalEdits, ad_setups: facts.counts.adSetups } });
      const itemId = facts.row.shoot_plan_item_id;
      await client.query('DELETE FROM creative_assets WHERE id = $1', [id]);
      await pruneEmptyItem(client, itemId);
    }
    await client.query('COMMIT');
    return { ok: true, already: false, action, concept_name: facts.name };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// An ad-hoc ("manual") or Promotion workspace that has lost its last concept is an empty shell; remove it so it can't
// linger as an orphan card. Core / High Stock / Drop items are Planning selections and are never removed here.
async function pruneEmptyItem(client, itemId) {
  if (!itemId) return;
  const item = await client.query('SELECT id, source FROM shoot_plan_items WHERE id = $1', [itemId]);
  if (!item.rows.length || !['manual', 'promotion'].includes(item.rows[0].source)) return;
  const left = await client.query('SELECT 1 FROM creative_assets WHERE shoot_plan_item_id = $1 LIMIT 1', [itemId]);
  if (!left.rows.length) await client.query('DELETE FROM shoot_plan_items WHERE id = $1', [itemId]);
}

// Promotion workspace removal (Concept Development): an empty workspace is simply deleted; a workspace with concepts is
// removed only if EVERY concept may be removed (admin, nothing published/approved). It never requires moving a concept
// back a stage -- if something is protected, the answer lists exactly which concept and why, and points at Archive.
async function planWorkspaceRemoval(db, itemId, user) {
  const concepts = (await db.query('SELECT id FROM creative_assets WHERE shoot_plan_item_id = $1', [itemId])).rows;
  const verdicts = [];
  for (const c of concepts) {
    const facts = await loadFacts(db, c.id);
    verdicts.push(evaluateLifecycle(facts, { isAdmin: !!(user && user.role === 'admin') }));
  }
  const blockers = verdicts.filter((v) => !v.actions.find((a) => a.key === 'remove_test').allowed);
  return { concepts: verdicts, blockers, empty: concepts.length === 0 };
}

module.exports = {
  STAGE_LABELS, ACTIVE_CONCEPT_SQL, ACTION_LABELS, evaluateLifecycle, loadFacts, describe, applyAction, planWorkspaceRemoval, pruneEmptyItem, LifecycleError,
};
