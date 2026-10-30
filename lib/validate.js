/** Small input-validation helpers. They throw HttpError(400) with friendly messages. */
const { badInput } = require('./errors');

function text(value, name, { max = 500, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badInput(`${name} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw badInput(`${name} must be text.`);
  const t = value.trim();
  if (!t) {
    if (required) throw badInput(`${name} is required.`);
    return null;
  }
  if (t.length > max) throw badInput(`${name} is too long (maximum ${max} characters).`);
  return t;
}

function int(value, name, { min = 1, max = 1e9, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badInput(`${name} is required.`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badInput(`${name} is not valid.`);
  return n;
}

function id(value, name = 'id') {
  return int(value, name, { min: 1, required: true });
}

function oneOf(value, name, list, { required = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badInput(`${name} is required.`);
    return fallback;
  }
  if (!list.includes(value)) throw badInput(`${name} must be one of: ${list.join(', ')}.`);
  return value;
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function date(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badInput(`${name} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badInput(`${name} must be a date (YYYY-MM-DD).`);
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw badInput(`${name} is not a real date.`);
  return value;
}

function time(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badInput(`${name} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw badInput(`${name} must be a time (HH:MM).`);
  return value;
}

/** Escape a user string for use inside a SQL LIKE pattern (with ESCAPE '\'). */
function like(q) {
  return '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

module.exports = { text, int, id, oneOf, bool, date, time, like };
