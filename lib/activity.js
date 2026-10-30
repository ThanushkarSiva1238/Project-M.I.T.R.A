/** Writes real user actions to activity_log (shown on the dashboard). */
const db = require('../database/db');

function log({ type, label, refType = null, refId = null }) {
  db.prepare('INSERT INTO activity_log (type, label, ref_type, ref_id) VALUES (?, ?, ?, ?)').run(
    type,
    String(label).slice(0, 200),
    refType,
    refId
  );
}

/**
 * Autosave fires often, so a note edit is logged once per 30 minutes per note;
 * further edits just refresh the existing entry's timestamp and label.
 */
function logNoteUpdate(note) {
  const label = `Note: ${note.title || 'Untitled'}`.slice(0, 200);
  const recent = db
    .prepare(
      `SELECT id FROM activity_log
       WHERE type IN ('note_updated', 'note_created') AND ref_type = 'note' AND ref_id = ?
         AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')
       ORDER BY id DESC LIMIT 1`
    )
    .get(note.id);
  if (recent) {
    db.prepare(`UPDATE activity_log SET label = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(label, recent.id);
  } else {
    log({ type: 'note_updated', label, refType: 'note', refId: note.id });
  }
}

module.exports = { log, logNoteUpdate };
