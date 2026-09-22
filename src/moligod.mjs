import crypto from 'node:crypto';
import zlib from 'node:zlib';

const WIRE_VERSION = 1;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ADDITIONAL_DATA = Buffer.from('special-ops-snapshot-v1', 'utf8');

export function decodeSpecialOpsSnapshot(wireBytes, keyLabel) {
  const bytes = Buffer.from(wireBytes);
  if (!keyLabel) {
    throw new Error('moligod 响应缺少 x-special-ops-key');
  }
  if (bytes.length <= 1 + IV_LENGTH + AUTH_TAG_LENGTH || bytes[0] !== WIRE_VERSION) {
    throw new Error('moligod 快照格式或版本不受支持');
  }

  const key = crypto.createHash('sha256').update(keyLabel, 'utf8').digest();
  const iv = bytes.subarray(1, 1 + IV_LENGTH);
  const encryptedWithTag = bytes.subarray(1 + IV_LENGTH);
  const ciphertext = encryptedWithTag.subarray(0, -AUTH_TAG_LENGTH);
  const authTag = encryptedWithTag.subarray(-AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(ADDITIONAL_DATA);
  decipher.setAuthTag(authTag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const json = zlib.gunzipSync(compressed).toString('utf8');
  const snapshot = JSON.parse(json);

  if (!Array.isArray(snapshot.recipes)) {
    throw new Error('moligod 快照缺少 recipes 数组');
  }
  return snapshot;
}

export async function fetchSpecialOpsSnapshot(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const attempts = options.attempts ?? 3;
  let response;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/octet-stream',
          'user-agent': 'DeltaHarvestAdvisor/1.0 (personal low-frequency client)'
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(600 * attempt);
    }
  }
  if (!response) throw lastError ?? new Error('moligod 请求失败');

  if (!response.ok) {
    throw new Error(`moligod 请求失败：HTTP ${response.status}`);
  }

  const keyLabel = response.headers.get('x-special-ops-key') || '';
  const wire = Buffer.from(await response.arrayBuffer());
  const snapshot = decodeSpecialOpsSnapshot(wire, keyLabel);
  const headerGeneratedAt = Number(response.headers.get('x-special-ops-generated-at'));

  return {
    snapshot,
    metadata: {
      fetchedAtMs: Date.now(),
      generatedAtMs: Number.isFinite(headerGeneratedAt) ? headerGeneratedAt : null,
      cacheTtlSeconds: Number(response.headers.get('x-special-ops-ttl')) || null,
      wireBytes: wire.length
    }
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
