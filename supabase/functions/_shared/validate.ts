/**
 * Input validation.
 *
 * Every value that arrives from the network is checked here before it
 * reaches the database. The database has its own CHECK constraints saying
 * the same things - these functions exist to return a clear 400 instead of
 * a 500, not to be the only guard.
 */

/** Hard cap on a request body, applied before it is parsed. */
export const MAX_BODY_BYTES = 16 * 1024; // 16 KB

/** Message length, matching the CHECK constraint on chat_messages.body. */
export const MAX_MESSAGE_CHARS = 4000;

/** Optional contact fields. Generous, but bounded. */
export const MAX_NAME_CHARS = 120;
export const MAX_EMAIL_CHARS = 254; // the practical maximum for an address
export const MAX_PHONE_CHARS = 40;

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Read and parse a JSON body without letting an unbounded stream through.
 *
 * Content-Length is checked first when present, but it is a claim from the
 * caller, so the body is also read into a string and measured. A caller
 * that lies about the length, or omits it entirely and streams, still hits
 * the cap.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const declared = req.headers.get('content-length');
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new ValidationError('Request body too large.');
  }

  const raw = await readCapped(req, MAX_BODY_BYTES);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Body must be valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

async function readCapped(req: Request, limit: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Stop pulling. Do not buffer any more of a body we are rejecting.
      await reader.cancel().catch(() => {});
      throw new ValidationError('Request body too large.');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(joined);
}

/** Strict UUID check. A malformed id is a 400, never a database error. */
export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required.`);
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!re.test(value)) throw new ValidationError(`${field} is not a valid id.`);
  return value.toLowerCase();
}

/**
 * A message body: trimmed, non-empty, within the cap.
 *
 * Trimming happens here so that a body of only whitespace is rejected as
 * empty rather than stored as a blank bubble.
 */
export function requireMessageBody(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('Message is required.');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError('Message cannot be empty.');
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new ValidationError(`Message is too long. The limit is ${MAX_MESSAGE_CHARS} characters.`);
  }
  return trimmed;
}

/** An optional short text field. Empty or missing becomes null. */
export function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new ValidationError(`${field} is too long.`);
  return trimmed;
}

/**
 * A very forgiving email check.
 *
 * Deliberately not RFC-complete: the address is optional, unverified, and
 * only ever displayed to staff. The job here is to reject obvious rubbish
 * and anything long enough to be an attack, not to referee the standard.
 */
export function optionalEmail(value: unknown): string | null {
  const text = optionalText(value, 'Email', MAX_EMAIL_CHARS);
  if (text === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new ValidationError('That email address does not look right.');
  }
  return text;
}

/** Conversation status, for the staff endpoint. */
export function requireStatus(value: unknown): 'open' | 'closed' {
  if (value !== 'open' && value !== 'closed') {
    throw new ValidationError("Status must be 'open' or 'closed'.");
  }
  return value;
}
