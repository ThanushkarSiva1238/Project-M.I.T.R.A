/** Thin client for MITRA's local REST API. */

export class ApiError extends Error {
  constructor(code, message, status, extra) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra || {};
  }
}

async function request(method, url, body) {
  const init = { method, headers: { 'X-MITRA-Request': '1' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (_) {
    throw new ApiError('server_unreachable', 'MITRA cannot reach its own program. Please make sure the MITRA window (the black console window) is still open, then try again.', 0);
  }
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const e = (data && data.error) || {};
    const { code, message, ...extra } = e;
    throw new ApiError(code || 'error', message || `Something went wrong (${res.status}).`, res.status, extra);
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b ?? {}),
  put: (u, b) => request('PUT', u, b ?? {}),
  patch: (u, b) => request('PATCH', u, b ?? {}),
  del: (u) => request('DELETE', u),
  upload: (u, file, fields = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', file);
    return request('POST', u, fd);
  },
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v === true ? '1' : v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
