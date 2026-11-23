// Page side of the passkey / security key unlock (WebAuthn PRF extension; findings: docs/webauthn-prf-findings.md).
// Runs in an extension page (the list page or the popup), never in the service worker (no WebAuthn there). The browser shows its own
// dialog; this module only creates a credential and later asks it for the PRF output of a stored 32-byte salt. The PRF output is the
// secret that wraps the master key (lib/lock/keys.js: prf slots). Nothing here stores anything: the credential id and salt are public
// and live in meta.lock.slots, the PRF output goes straight into one runtime message and is dropped.
// The relying party id is left to the browser: for an extension page it is the extension id, so a passkey only works for this exact
// install (an unpacked copy and the Web Store copy have different ids).
import { b64enc, b64dec, b64uEnc, bytesEqual } from './lock/bytes.js';

const toBytes = (x) => (typeof x === 'string' ? b64dec(x) : x);
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const OPTS_TIMEOUT = 120000;

export const supported = () => typeof navigator !== 'undefined' && !!navigator.credentials && typeof PublicKeyCredential !== 'undefined';
const failCode = (e) => (e && (e.name === 'NotAllowedError' || e.name === 'AbortError') ? 'cancel' : e && e.name === 'NotSupportedError' ? 'nosupport' : 'fail');
const prfOf = (cred) => {
  const r = cred.getClientExtensionResults ? cred.getClientExtensionResults() : null;
  const f = r && r.prf && r.prf.results && r.prf.results.first;
  return f ? new Uint8Array(f) : null;
};

/** Ask for the PRF output of one credential. @returns {{prf:string}|{error}} (prf = base64 of 32 bytes) */
async function evalOne(cid, psalt) {
  let a;
  try {
    a = await navigator.credentials.get({ publicKey: {
      challenge: rand(32), timeout: OPTS_TIMEOUT, userVerification: 'preferred',
      allowCredentials: [{ type: 'public-key', id: cid }],
      extensions: { prf: { eval: { first: psalt } } },
    } });
  } catch (e) { return { error: failCode(e) }; }
  if (!a) return { error: 'cancel' };
  const out = prfOf(a);
  if (!out || out.length !== 32) return { error: 'noprf' };
  return { prf: b64enc(out) };
}

/**
 * Make a new credential and read its PRF output once (the second prompt cannot be skipped: not every authenticator returns the
 * output while creating). @returns {{cid, psalt, prf}} (base64) or {error: 'nosupport'|'cancel'|'noprf'|'fail'}
 */
export async function createPasskey() {
  if (!supported()) return { error: 'nosupport' };
  const psalt = rand(32);
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Tabroost' },
      user: { id: rand(16), name: 'Tabroost', displayName: 'Tabroost' },
      challenge: rand(32), timeout: OPTS_TIMEOUT,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      extensions: { prf: {} },
    } });
  } catch (e) { return { error: failCode(e) }; }
  if (!cred) return { error: 'cancel' };
  const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
  if (!ext.prf || ext.prf.enabled === false) return { error: 'noprf' };
  const cid = new Uint8Array(cred.rawId);
  const r = await evalOne(cid, psalt);
  if (r.error) return r;
  return { cid: b64enc(cid), psalt: b64enc(psalt), prf: r.prf };
}

/**
 * Unlock: slots = [{id, cid, psalt}] (base64 strings or bytes). One credential -> eval, several -> evalByCredential.
 * @returns {{id, prf}} or {error}
 */
export async function assertSlots(slots) {
  if (!supported()) return { error: 'nosupport' };
  const list = (slots || []).map((s) => ({ id: s.id, cid: toBytes(s.cid), psalt: toBytes(s.psalt) }));
  if (!list.length) return { error: 'nosupport' };
  const byCred = {};
  for (const s of list) byCred[b64uEnc(s.cid)] = { first: s.psalt };
  let a;
  try {
    a = await navigator.credentials.get({ publicKey: {
      challenge: rand(32), timeout: OPTS_TIMEOUT, userVerification: 'preferred',
      allowCredentials: list.map((s) => ({ type: 'public-key', id: s.cid })),
      extensions: { prf: list.length === 1 ? { eval: { first: list[0].psalt } } : { evalByCredential: byCred } },
    } });
  } catch (e) { return { error: failCode(e) }; }
  if (!a) return { error: 'cancel' };
  const out = prfOf(a);
  if (!out || out.length !== 32) return { error: 'noprf' };
  const used = list.find((s) => bytesEqual(s.cid, new Uint8Array(a.rawId)));
  if (!used) return { error: 'fail' };
  return { id: used.id, prf: b64enc(out) };
}
