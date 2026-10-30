class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || undefined;
  }
}

const notFound = (what = 'Item') => new HttpError(404, 'not_found', `${what} was not found.`);
const badInput = (message) => new HttpError(400, 'invalid_input', message);
const conflict = (message, extra) => new HttpError(409, 'conflict', message, extra);

module.exports = { HttpError, notFound, badInput, conflict };
