/**
 * API Key 的本地加密存储。
 *
 * 目标：磁盘上只保存密文，防止备份、云同步或扫盘直接读到明文。
 * 运行时仍然解密到内存（调用模型必须用明文），主密码不会落盘。
 *
 * 算法：scrypt 派生密钥 + AES-256-GCM（带认证标签，密码错误会解密失败）。
 */
import crypto from 'node:crypto';

const KDF = { name: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 };
const VERSION = 1;
const MAX_MEM = 64 * 1024 * 1024;

/** 明文 → 可写入配置文件的密文对象 */
export function encryptSecret(plain, passphrase) {
  const text = String(plain || '');
  const pass = String(passphrase || '');
  if (!text) throw new Error('没有可加密的内容');
  if (pass.length < 6) throw new Error('主密码至少 6 位');

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, KDF.keylen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: MAX_MEM,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);

  return {
    v: VERSION,
    kdf: { ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** 密文对象 + 主密码 → 明文；密码错误或数据损坏返回 null */
export function decryptSecret(payload, passphrase) {
  try {
    if (!payload || typeof payload !== 'object' || !payload.data) return null;
    const kdf = payload.kdf || {};
    const salt = Buffer.from(String(kdf.salt || ''), 'base64');
    const key = crypto.scryptSync(String(passphrase || ''), salt, KDF.keylen, {
      N: Number(kdf.N) || KDF.N,
      r: Number(kdf.r) || KDF.r,
      p: Number(kdf.p) || KDF.p,
      maxmem: MAX_MEM,
    });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(payload.iv || ''), 'base64'));
    decipher.setAuthTag(Buffer.from(String(payload.tag || ''), 'base64'));
    const data = Buffer.concat([
      decipher.update(Buffer.from(String(payload.data), 'base64')),
      decipher.final(),
    ]);
    return data.toString('utf8');
  } catch {
    return null;
  }
}
