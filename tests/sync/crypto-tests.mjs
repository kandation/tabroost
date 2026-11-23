import { test, assert, eq, throws } from './t.mjs';
import { createVault, unlockVault, changePassphrase, rotateKey, encrypt, decrypt, aad, WrongPassphraseError, CryptoFormatError } from '../../lib/sync/crypto.js';
import { pack, unpack, splitParts, reassemble, parseNodeUrl, headUrl, chunkUrl, vaultUrl, deviceMarkerUrl, PAD_TO, MAX_PLAINTEXT } from '../../lib/sync/codec.js';
import { b64uEnc, b64uDec } from '../../lib/sync/bytes.js';
import { sealTailChunk, openObject, splitOps, compactLog } from '../../lib/sync/oplog.js';
import { mulberry32 } from './harness.mjs';

const OPT = { iter: 1000, minIter: 1 };

test('crypto: vault create/unlock, wrong passphrase, non-extractable DEK', async () => {
  const { marker, dek } = await createVault('pass-one', OPT);
  assert(dek.extractable === false, 'dek must be non-extractable');
  await throws(() => crypto.subtle.exportKey('raw', dek), /./, 'export of non-extractable key must fail');
  const dek2 = await unlockVault(marker, 'pass-one', { minIter: 1 });
  const ct = await encrypt(dek, 'a', new Uint8Array([1, 2, 3]));
  eq([...await decrypt(dek2, 'a', ct)], [1, 2, 3]);
  const e = await throws(() => unlockVault(marker, 'pass-two', { minIter: 1 }), WrongPassphraseError.name);
  assert(e instanceof WrongPassphraseError);
});

test('crypto: kdf iteration floor is enforced', async () => {
  await throws(() => createVault('x', { iter: 1000 }), /iterations too low/);
  const { marker } = await createVault('x', OPT);
  await throws(() => unlockVault(marker, 'x'), /iterations too low/); // default floor 310k
});

test('crypto: change passphrase keeps the DEK; old passphrase stops working', async () => {
  const { marker, dek } = await createVault('old-pass', OPT);
  const ct = await encrypt(dek, 'ctx', new TextEncoder().encode('secret'));
  const m2 = await changePassphrase(marker, 'old-pass', 'new-pass', OPT);
  assert(m2.kdf.salt !== marker.kdf.salt && m2.iv !== marker.iv, 'fresh salt/iv');
  eq(m2.vaultId, marker.vaultId); eq(m2.epoch, marker.epoch);
  await throws(() => unlockVault(m2, 'old-pass', { minIter: 1 }), /WrongPassphrase/);
  const dek2 = await unlockVault(m2, 'new-pass', { minIter: 1 });
  eq(new TextDecoder().decode(await decrypt(dek2, 'ctx', ct)), 'secret');
  await throws(() => changePassphrase(marker, 'bad', 'z', OPT), /WrongPassphrase/);
});

test('crypto: rotateKey bumps epoch and old key cannot read new data', async () => {
  const { marker, dek } = await createVault('pw', OPT);
  const r = await rotateKey(marker, 'pw', OPT);
  eq(r.marker.epoch, marker.epoch + 1);
  const ct = await encrypt(r.dek, 'x', new Uint8Array(40));
  await throws(() => decrypt(dek, 'x', ct), CryptoFormatError.name);
  await throws(() => rotateKey(marker, 'nope', OPT), /WrongPassphrase/);
});

test('crypto: any bit flip / wrong AAD / truncation is rejected', async () => {
  const { dek } = await createVault('pw', OPT);
  const rng = mulberry32(5);
  const plain = new Uint8Array(200).map(() => Math.floor(rng() * 256));
  const ct = await encrypt(dek, 'slot-1', plain);
  eq([...await decrypt(dek, 'slot-1', ct)], [...plain]);
  for (let pos = 0; pos < ct.length; pos += 7) {
    const c = ct.slice(); c[pos] ^= 1 << (pos % 8);
    await throws(() => decrypt(dek, 'slot-1', c), CryptoFormatError.name, 'flip at ' + pos);
  }
  await throws(() => decrypt(dek, 'slot-2', ct), CryptoFormatError.name);
  await throws(() => decrypt(dek, 'slot-1', ct.subarray(0, ct.length - 1)), CryptoFormatError.name);
  await throws(() => decrypt(dek, 'slot-1', ct.subarray(0, 10)), CryptoFormatError.name);
  // unique IV per encryption
  const a = await encrypt(dek, 's', plain), b = await encrypt(dek, 's', plain);
  assert(Buffer.compare(Buffer.from(a.subarray(0, 12)), Buffer.from(b.subarray(0, 12))) !== 0, 'iv reuse');
});

test('codec: base64url roundtrip incl. all lengths', () => {
  const rng = mulberry32(9);
  for (let n = 0; n < 300; n++) {
    const b = new Uint8Array(n).map(() => Math.floor(rng() * 256));
    eq([...b64uDec(b64uEnc(b))], [...b], 'len ' + n);
    assert(!/[+/=]/.test(b64uEnc(b)));
  }
  for (const bad of ['a', 'abcde', 'ab$d']) { let ok = false; try { b64uDec(bad); } catch { ok = true; } assert(ok, 'should reject ' + bad); }
});

test('codec: pack/unpack, padding, unicode, parts out of order, zip-bomb guard', async () => {
  const obj = { th: 'ทดสอบภาษาไทย 😀', arr: Array.from({ length: 50 }, (_, i) => ({ i, u: 'https://x.test/' + i })) };
  const p = await pack(obj);
  assert(p.length % PAD_TO === 0, 'padded');
  eq(await unpack(p), obj);
  const bytes = new Uint8Array(20000).map((_, i) => (i * 7919) % 251);
  const parts = splitParts(bytes, 1000);
  assert(parts.length >= 7 && parts.every((s) => s.length <= 1000));
  const m = new Map(); [...parts.keys()].reverse().forEach((i) => m.set(i + 1, parts[i]));
  eq([...reassemble(m, parts.length)], [...bytes]);
  m.delete(3);
  eq(reassemble(m, parts.length), null);
  // zip bomb: highly compressible payload far above the plaintext cap
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter(); w.write(new Uint8Array(MAX_PLAINTEXT * 8)); w.close();
  const z = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  const framed = new Uint8Array(4 + z.length); new DataView(framed.buffer).setUint32(0, z.length); framed.set(z, 4);
  await throws(() => unpack(framed), /too large/);
});

test('codec: node url packing/parsing and malformed urls', () => {
  const h = parseNodeUrl(headUrl(2, 3, 'AbC-_9'));
  eq([h.kind, h.part, h.parts, h.b64], ['h', 2, 3, 'AbC-_9']);
  const c = parseNodeUrl(chunkUrl(4, 7, 1, 2, 'xyz'));
  eq([c.kind, c.gen, c.chunkNo, c.part, c.parts, c.b64], ['c', 4, 7, 1, 2, 'xyz']);
  eq(parseNodeUrl(deviceMarkerUrl('abcd1234')).deviceId, 'abcd1234');
  const v = parseNodeUrl(vaultUrl({ vaultId: 'q', epoch: 1 }));
  eq(v.marker, { vaultId: 'q', epoch: 1 });
  for (const bad of ['https://example.com/', 'https://cmr.invalid/', 'https://cmr.invalid/h#1.0.1.x', 'https://cmr.invalid/c#1.1.0.1.1.x',
    'https://cmr.invalid/h#2.1.1.x', 'https://cmr.invalid/h#1.2.1.x', 'https://cmr.invalid/c#1.1.1.1.x', 'https://cmr.invalid/v#1.@@@', 'https://cmr.invalid/z#1', null, 5]) {
    eq(parseNodeUrl(bad), null, String(bad));
  }
});

test('oplog: chunk bound to device, generation and slot (moved chunks rejected)', async () => {
  const { marker, dek } = await createVault('pw', OPT);
  const mk = (deviceId) => ({ dek, vaultId: marker.vaultId, epoch: marker.epoch, deviceId });
  const ops = [{ h: '000000000000', t: 'i', id: 'a', f: { url: 'u' } }];
  const { ct, hash } = await sealTailChunk(mk('devA'), 3, 1, 1, ops, '');
  const o = await openObject(mk('devB'), 'devA', 'c', 1, 3, ct);
  eq(o.ops, ops); eq(o.seqFrom, 1); assert(hash.length === 32);
  await throws(() => openObject(mk('devB'), 'devB', 'c', 1, 3, ct), CryptoFormatError.name, 'other device');
  await throws(() => openObject(mk('devB'), 'devA', 'c', 2, 3, ct), CryptoFormatError.name, 'other gen');
  await throws(() => openObject(mk('devB'), 'devA', 'c', 1, 4, ct), CryptoFormatError.name, 'other chunk no');
  await throws(() => openObject({ ...mk('devB'), epoch: 2 }, 'devA', 'c', 1, 3, ct), CryptoFormatError.name, 'other epoch');
  await throws(() => openObject({ ...mk('devB'), vaultId: 'zzz' }, 'devA', 'c', 1, 3, ct), CryptoFormatError.name, 'other vault');
});

test('oplog: splitOps respects limits; compaction keeps newest fields, drops superseded, keeps tombstones', async () => {
  const ops = Array.from({ length: 5000 }, (_, i) => ({ h: String(i).padStart(13, '0'), t: 'i', id: 'x' + i, f: { url: 'u' } }));
  const chunks = splitOps(ops);
  assert(chunks.length >= 3 && chunks.every((c) => c.length <= 2000));
  eq(chunks.flat().length, 5000);
  const e = [
    { seq: 1, op: { h: '00000000a0001', t: 'g', id: 'g1', f: { title: 'a', starred: true } } },
    { seq: 2, op: { h: '00000000a0002', t: 'g', id: 'g1', f: { title: 'b' } } },
    { seq: 3, op: { h: '00000000a0003', t: 'i', id: 'i1', f: { url: 'u1' } } },
    { seq: 4, op: { h: '00000000a0004', t: 'g', id: 'g2', f: { title: 'dead' } } },
    { seq: 5, op: { h: '00000000a0005', t: 'g', id: 'g2', x: 1 } },
  ];
  const out = await compactLog(e, { isSuperseded: async (t, id, f) => id === 'i1' && f === 'url' });
  const flat = JSON.stringify(out.map((x) => x.op));
  assert(flat.includes('"starred":true') && flat.includes('"title":"b"') && !flat.includes('"title":"a"'), 'newest per field kept');
  assert(!flat.includes('u1'), 'superseded dropped');
  assert(!flat.includes('dead') && flat.includes('"x":1'), 'tombstone supersedes, tombstone kept');
});
