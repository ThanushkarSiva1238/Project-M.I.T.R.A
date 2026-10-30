/**
 * Date helpers. MITRA runs on the student's own computer, so the server's
 * local clock is the student's local clock. "Calendar" dates (events, flashcard
 * due dates) are plain local YYYY-MM-DD strings; instants (created_at, ...) are
 * stored as UTC ISO strings and converted to local time in the browser.
 */
const pad = (n) => String(n).padStart(2, '0');

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

module.exports = { localDate, localTime, addDays };
