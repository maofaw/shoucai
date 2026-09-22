import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { decodeSpecialOpsSnapshot } from '../src/moligod.mjs';

test('decodeSpecialOpsSnapshot decodes AES-GCM + gzip wire format', () => {
  const keyLabel = 'test-key-label';
  const payload = { recipes: [{ id: 1, output_display_name: '测试配方' }], status: 'ok' };
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const key = crypto.createHash('sha256').update(keyLabel, 'utf8').digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('special-ops-snapshot-v1', 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const wire = Buffer.concat([Buffer.from([1]), iv, ciphertext, cipher.getAuthTag()]);

  assert.deepEqual(decodeSpecialOpsSnapshot(wire, keyLabel), payload);
});

test('decodeSpecialOpsSnapshot rejects unsupported version', () => {
  assert.throws(() => decodeSpecialOpsSnapshot(Buffer.alloc(64, 2), 'key'), /不受支持/);
});
