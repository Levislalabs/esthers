/**
 * Unit tests for the pure logic the Edge Functions depend on: the customer
 * token and the input validators.
 *
 * These deliberately import the real modules rather than copies, so the
 * thing under test is the thing that ships. They use only web-standard
 * APIs (crypto, Request, TextEncoder), so they run under Deno and under
 * Node 22 with --experimental-strip-types:
 *
 *   node --experimental-strip-types supabase/tests/unit_test.ts
 *   deno run --allow-none supabase/tests/unit_test.ts
 */

import {
  generateToken,
  hashToken,
  timingSafeEqual,
  looksLikeToken,
} from '../functions/_shared/token.ts';

import {
  readJsonBody,
  requireUuid,
  requireMessageBody,
  optionalText,
  optionalEmail,
  requireStatus,
  ValidationError,
  MAX_MESSAGE_CHARS,
  MAX_BODY_BYTES,
} from '../functions/_shared/validate.ts';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log('PASS  ' + label);
  } else {
    failed++;
    console.log('FAIL  ' + label);
  }
}

async function rejects(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    check(label, false);
  } catch (err) {
    check(label, err instanceof ValidationError);
  }
}

function jsonRequest(body: string): Request {
  return new Request('https://example.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

async function main(): Promise<void> {
  console.log('--- customer token ---');

  const a = generateToken();
  const b = generateToken();

  check('T1. token is 43 chars (32 bytes, base64url)', a.length === 43);
  check('T2. token is base64url only', /^[A-Za-z0-9_-]+$/.test(a));
  check('T3. two tokens differ', a !== b);

  // 200 tokens, all distinct. A broken RNG shows up here immediately.
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(generateToken());
  check('T4. 200 generated tokens are all distinct', seen.size === 200);

  const hashA = await hashToken(a);
  check('T5. hash is 64 hex chars (SHA-256)', /^[0-9a-f]{64}$/.test(hashA));
  check('T6. hashing is deterministic', (await hashToken(a)) === hashA);
  check('T7. a different token hashes differently', (await hashToken(b)) !== hashA);
  check('T8. the hash does not contain the token', !hashA.includes(a));

  // Known-answer test. The expected value is SHA-256('token-a-raw') as
  // computed independently by Postgres' pgcrypto, which is what the SQL
  // fixtures in rls_test.sql use. If TypeScript and Postgres ever disagree
  // about the digest, a customer token minted by one and checked by the
  // other would silently stop matching - this catches that.
  const known = await hashToken('token-a-raw');
  check(
    'T9. SHA-256("token-a-raw") matches the digest Postgres computes',
    known === 'fa1ad05a0e3e63b98df361b139e99ab1e97a9bd6411be3faec26a9ea29d54ef4',
  );

  check('T10. timingSafeEqual: equal strings', timingSafeEqual(hashA, hashA));
  check('T11. timingSafeEqual: different strings', !timingSafeEqual(hashA, await hashToken(b)));
  check('T12. timingSafeEqual: different lengths', !timingSafeEqual('abc', 'abcd'));
  check('T13. timingSafeEqual: empty vs value', !timingSafeEqual('', hashA));

  check('T14. looksLikeToken accepts a real token', looksLikeToken(a));
  check('T15. looksLikeToken rejects short input', !looksLikeToken('tooshort'));
  check('T16. looksLikeToken rejects non-string', !looksLikeToken(12345));
  check('T17. looksLikeToken rejects null', !looksLikeToken(null));
  check('T18. looksLikeToken rejects punctuation', !looksLikeToken('a'.repeat(42) + '!'));
  check('T19. looksLikeToken rejects an over-long value', !looksLikeToken('a'.repeat(500)));

  console.log('--- uuid ---');

  check(
    'U1. a valid v4 uuid is accepted',
    requireUuid('11111111-1111-4111-8111-111111111111', 'id') ===
      '11111111-1111-4111-8111-111111111111',
  );
  check(
    'U2. uppercase is normalised to lowercase',
    requireUuid('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', 'id') ===
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  );
  await rejects('U3. a malformed uuid is rejected', () => requireUuid('not-a-uuid', 'id'));
  await rejects('U4. an empty string is rejected', () => requireUuid('', 'id'));
  await rejects('U5. a non-string is rejected', () => requireUuid(42, 'id'));
  await rejects('U6. null is rejected', () => requireUuid(null, 'id'));
  await rejects(
    'U7. SQL-ish input is rejected before it reaches the database',
    () => requireUuid("' or 1=1 --", 'id'),
  );
  await rejects(
    'U8. a uuid with trailing junk is rejected',
    () => requireUuid('11111111-1111-4111-8111-111111111111 or true', 'id'),
  );

  console.log('--- message body ---');

  check('M1. a normal message survives', requireMessageBody('  hello  ') === 'hello');
  await rejects('M2. an empty message is rejected', () => requireMessageBody(''));
  await rejects('M3. a whitespace-only message is rejected', () => requireMessageBody('   \n\t '));
  await rejects('M4. a non-string message is rejected', () => requireMessageBody(99));
  await rejects('M5. null is rejected', () => requireMessageBody(null));
  check(
    'M6. exactly 4000 characters is accepted',
    requireMessageBody('x'.repeat(MAX_MESSAGE_CHARS)).length === MAX_MESSAGE_CHARS,
  );
  await rejects(
    'M7. 4001 characters is rejected',
    () => requireMessageBody('x'.repeat(MAX_MESSAGE_CHARS + 1)),
  );
  check(
    'M8. trailing whitespace does not smuggle past the cap',
    requireMessageBody('x'.repeat(MAX_MESSAGE_CHARS) + '   ').length === MAX_MESSAGE_CHARS,
  );

  console.log('--- optional fields ---');

  check('O1. missing optional text becomes null', optionalText(undefined, 'Name', 10) === null);
  check('O2. empty optional text becomes null', optionalText('   ', 'Name', 10) === null);
  check('O3. optional text is trimmed', optionalText('  Sam  ', 'Name', 10) === 'Sam');
  await rejects('O4. over-long optional text is rejected', () => optionalText('x'.repeat(11), 'Name', 10));
  check('O5. a plausible email is accepted', optionalEmail('a@b.ca') === 'a@b.ca');
  check('O6. a missing email is null', optionalEmail(undefined) === null);
  await rejects('O7. a malformed email is rejected', () => optionalEmail('not-an-email'));
  await rejects('O8. an email with spaces is rejected', () => optionalEmail('a b@c.ca'));
  check('S1. status open is accepted', requireStatus('open') === 'open');
  check('S2. status closed is accepted', requireStatus('closed') === 'closed');
  await rejects('S3. an unknown status is rejected', () => requireStatus('archived'));
  await rejects('S4. a non-string status is rejected', () => requireStatus(1));

  console.log('--- request body ---');

  const body = await readJsonBody(jsonRequest('{"a":1}'));
  check('B1. a JSON object is parsed', body.a === 1);
  await rejects('B2. invalid JSON is rejected', () => readJsonBody(jsonRequest('{oops')));
  await rejects('B3. a JSON array is rejected', () => readJsonBody(jsonRequest('[1,2,3]')));
  await rejects('B4. a bare string is rejected', () => readJsonBody(jsonRequest('"hello"')));
  await rejects('B5. JSON null is rejected', () => readJsonBody(jsonRequest('null')));

  // Oversized body, with an honest Content-Length.
  const huge = JSON.stringify({ message: 'x'.repeat(MAX_BODY_BYTES + 1000) });
  await rejects('B6. an oversized body is rejected', () => readJsonBody(jsonRequest(huge)));

  // And with a lying Content-Length: the stream cap must still catch it.
  const lying = new Request('https://example.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '10' },
    body: huge,
  });
  await rejects('B7. an oversized body with a false Content-Length is still rejected',
    () => readJsonBody(lying));

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    if (typeof process !== 'undefined') process.exitCode = 1;
    throw new Error(`${failed} unit test(s) failed`);
  }
}

await main();
