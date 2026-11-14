'use strict';

/**
 * 店铺凭证隔离与加密缓存（规范 2.3 安全红线）。
 *
 * 三条硬约束：
 * 1. AppKey/AppSecret 只允许走 HTTP 头 X-Shop-Credential，
 *    严禁进入 JSON-RPC 参数体 —— 否则会随工具入参进入日志、Prompt 上下文和模型会话；
 * 2. 内存缓存按 shopKey 分桶，带 TTL；凭证轮换后旧值自然过期，不需要显式失效；
 * 3. 需要落盘时必须 AES-256-GCM 加密（GCM 自带完整性校验，
 *    换了密钥或文件被改动都会解密失败，此时按「空缓存」处理而不是崩溃）。
 *
 * 无 encryptionKey 时只做内存缓存、flush() 为 no-op：
 * 规范要求「Token 分桶缓存仅限内存」，宁可重启后重新注入，也不留明文凭证在磁盘。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { authFailed, invalidParams } from '../core/errors.js';

/** 凭证字段名黑名单：命中即说明调用方把凭证塞进了参数体 */
const SECRET_KEY_RE = /^(app_?secret|app_?key|secret|client_?secret|access_?token|refresh_?token)$/i;

/** 缓存文件结构版本，升级格式时用于拒绝旧文件而不是误解密 */
const CACHE_VERSION = 1;
/** 参数体递归检查的最大深度，超过即视为异常载荷 */
const MAX_WALK_DEPTH = 64;

/** appId / shopId 里不允许出现的字符：冒号会破坏 shopKey 的「appId:shopId」结构 */
function assertSafeId(value, field) {
  if (/[:\s\x00-\x1f\x7f]/.test(value)) {
    throw authFailed(`X-Shop-Credential 解析失败：${field} 含非法字符（不允许冒号/空白/控制字符）`);
  }
  if (value.length > 128) {
    throw authFailed(`X-Shop-Credential 解析失败：${field} 过长（>128 字符）`);
  }
}

/**
 * 解析 X-Shop-Credential 头。
 * 接受 base64url / 标准 base64，忽略前后空白与换行。
 *
 * @param {string} headerValue base64url(JSON.stringify({ appId, appSecret, shopId }))
 * @returns {{appId:string, shopId:string, shopKey:string, appSecret:string}}
 * @throws {import('../core/errors.js').ContractError} 41001
 */
export function decodeShopCredential(headerValue) {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  // 去掉全部空白：有些 HTTP 客户端会把长头折行
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
  if (!text) {
    throw authFailed('缺少 X-Shop-Credential 头：店铺凭证必须通过 HTTP 头透传，严禁放入 JSON-RPC 参数体');
  }

  // Node 的 base64 解码器同时接受标准与 url-safe 字符，这里显式归一化更稳妥
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  let jsonText;
  try {
    jsonText = Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    throw authFailed('X-Shop-Credential 解析失败：不是合法的 base64url 编码');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw authFailed('X-Shop-Credential 解析失败：解码后不是合法 JSON（应为 {appId,appSecret,shopId}）');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw authFailed('X-Shop-Credential 解析失败：解码结果必须是 JSON 对象');
  }

  const appId = typeof parsed.appId === 'string' ? parsed.appId.trim() : '';
  if (!appId) {
    throw authFailed('X-Shop-Credential 解析失败：缺少必填字段 appId');
  }
  assertSafeId(appId, 'appId');

  const appSecret = typeof parsed.appSecret === 'string' ? parsed.appSecret.trim() : '';

  // shopId 缺省为 'default'：单店铺部署时平台可以只带 appId/appSecret
  const shopIdRaw = typeof parsed.shopId === 'string' ? parsed.shopId.trim() : '';
  const shopId = shopIdRaw || 'default';
  assertSafeId(shopId, 'shopId');

  return { appId, shopId, shopKey: `${appId}:${shopId}`, appSecret };
}

/** 递归检查参数体是否出现凭证字段（只报路径，绝不把值的副本带进错误） */
export function assertNoSecretsInBody(params) {
  walkForSecrets(params, '$', new WeakSet(), 0);
}

function walkForSecrets(value, jsonPath, seen, depth) {
  if (value == null || typeof value !== 'object') return;
  if (depth > MAX_WALK_DEPTH) {
    throw invalidParams('JSON-RPC 参数体嵌套层级过深（>64 层），已拒绝处理');
  }
  if (seen.has(value)) return; // 循环引用：已检查过的节点不再重复
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walkForSecrets(value[i], `${jsonPath}[${i}]`, seen, depth + 1);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      throw invalidParams('凭证严禁放入 JSON-RPC 参数体，请改用 X-Shop-Credential 头', {
        path: `${jsonPath}.${key}`,
      });
    }
    walkForSecrets(child, `${jsonPath}.${key}`, seen, depth + 1);
  }
}

/** 64 位 hex 视为原始 32 字节 AES 密钥，其它字符串 sha256 派生；null/'' → 不加密 */
function deriveKey(encryptionKey) {
  if (encryptionKey == null || encryptionKey === '') return null;
  if (Buffer.isBuffer(encryptionKey)) {
    return encryptionKey.length === 32 ? encryptionKey : crypto.createHash('sha256').update(encryptionKey).digest();
  }
  const text = String(encryptionKey).trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

function normalizeCred(cred) {
  if (!cred || typeof cred !== 'object') throw invalidParams('凭证对象不能为空');
  let appId = typeof cred.appId === 'string' ? cred.appId.trim() : '';
  let shopId = typeof cred.shopId === 'string' ? cred.shopId.trim() : '';
  let shopKey = typeof cred.shopKey === 'string' ? cred.shopKey.trim() : '';

  if (!shopKey) {
    if (!appId) throw invalidParams('凭证缺少 appId，无法计算 shopKey（形如 appId:shopId）');
    if (!shopId) shopId = 'default';
    shopKey = `${appId}:${shopId}`;
  } else if (shopKey.includes(':')) {
    // 由 shopKey 反推，便于只拿到 shopKey 的调用方写入
    const idx = shopKey.indexOf(':');
    if (!appId) appId = shopKey.slice(0, idx);
    if (!shopId) shopId = shopKey.slice(idx + 1);
  } else if (!appId) {
    throw invalidParams('凭证的 shopKey 非法：应为 appId:shopId');
  }
  if (!appId) throw invalidParams('凭证缺少 appId，无法计算 shopKey');
  if (!shopId) shopId = 'default';

  return {
    appId,
    shopId,
    shopKey,
    appSecret: typeof cred.appSecret === 'string' ? cred.appSecret : '',
  };
}

/**
 * 创建凭证注册表（内存 Map + 可选加密落盘）。
 *
 * @param {object} o
 * @param {string|Buffer|null} [o.encryptionKey] 64 位 hex（32 字节）或任意口令（sha256 派生）；null = 仅内存
 * @param {string|null} [o.cacheFile] 加密缓存文件路径；无 encryptionKey 时忽略
 * @param {number} [o.ttlSec] 凭证缓存 TTL（秒）
 * @param {() => number} [o.now] 注入时钟（毫秒），测试用
 */
export function createCredentialRegistry({
  encryptionKey = null,
  cacheFile = null,
  ttlSec = 300,
  now = () => Date.now(),
} = {}) {
  const key = deriveKey(encryptionKey);
  const file = typeof cacheFile === 'string' && cacheFile !== '' ? cacheFile : null;
  const ttlMs = Math.max(0, Number(ttlSec) || 0) * 1000;

  /** @type {Map<string, {appId:string,shopId:string,shopKey:string,appSecret:string,expiresAt:number}>} */
  const entries = new Map();
  let closed = false;

  function purge(nowMs = now()) {
    for (const [shopKey, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(shopKey);
    }
  }

  /** 原子落盘：先写同目录 tmp 再 rename，避免进程崩溃留下半截密文被误读 */
  function persist() {
    if (!key || !file) return;
    purge();
    const payload = { savedAt: now(), entries: [...entries.values()] };
    try {
      const iv = crypto.randomBytes(12); // GCM 推荐 96bit IV
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
      const envelope = JSON.stringify({
        v: CACHE_VERSION,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      });

      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.writeFileSync(tmp, envelope, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (e) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // tmp 清理失败不掩盖原始错误
        }
        throw e;
      }
    } catch (e) {
      // 落盘失败只降级为内存缓存：凭证丢失不应让正在执行的上游调用失败
      console.error(`[credentials] 凭证缓存落盘失败（本进程仍使用内存缓存）：${e.message}`);
    }
  }

  /** 写入/更新凭证；有 encryptionKey 时同步刷新磁盘密文 */
  function put(cred) {
    if (closed) throw new Error('凭证注册表已关闭，无法写入');
    const normalized = normalizeCred(cred);
    entries.set(normalized.shopKey, { ...normalized, expiresAt: now() + ttlMs });
    persist();
  }

  /** 读取凭证；过期即删除并返回 null（TTL 是凭证轮换的唯一收敛机制） */
  function get(shopKey) {
    if (closed) return null;
    const id = String(shopKey ?? '');
    if (!id) return null;
    const entry = entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(id);
      return null;
    }
    // 返回副本：调用方修改不会污染注册表内部状态
    return { appId: entry.appId, shopId: entry.shopId, shopKey: entry.shopKey, appSecret: entry.appSecret };
  }

  function has(shopKey) {
    return get(shopKey) != null;
  }

  function size() {
    if (closed) return 0;
    purge();
    return entries.size;
  }

  /** 立即持久化；无 encryptionKey 时为 no-op（规范：Token 缓存仅限内存） */
  function flush() {
    if (closed) return;
    persist();
  }

  /**
   * 启动时读回缓存；文件缺失/损坏/密钥不匹配都按空缓存处理，绝不抛错。
   * @returns {number} 载入的有效条目数
   */
  function load() {
    if (closed) return 0;
    if (!key || !file) return 0;

    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[credentials] 读取凭证缓存失败，按空缓存处理：${e.message}`);
      return 0;
    }

    try {
      const envelope = JSON.parse(raw);
      if (!envelope || envelope.v !== CACHE_VERSION) throw new Error('缓存版本不支持');
      const iv = Buffer.from(String(envelope.iv ?? ''), 'base64');
      const tag = Buffer.from(String(envelope.tag ?? ''), 'base64');
      const data = Buffer.from(String(envelope.data ?? ''), 'base64');
      if (iv.length !== 12 || tag.length !== 16 || data.length === 0) throw new Error('缓存结构不完整');

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag); // GCM 完整性校验：密钥错/被篡改这里就会 throw
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      const payload = JSON.parse(plain.toString('utf8'));

      const list = Array.isArray(payload?.entries) ? payload.entries : [];
      const t = now();
      entries.clear();
      let loaded = 0;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.shopKey !== 'string' || item.shopKey === '') continue;
        if (!Number.isFinite(item.expiresAt) || item.expiresAt <= t) continue;
        entries.set(item.shopKey, {
          appId: typeof item.appId === 'string' ? item.appId : '',
          shopId: typeof item.shopId === 'string' ? item.shopId : 'default',
          shopKey: item.shopKey,
          appSecret: typeof item.appSecret === 'string' ? item.appSecret : '',
          expiresAt: item.expiresAt,
        });
        loaded += 1;
      }
      return loaded;
    } catch (e) {
      // 密钥变更、文件损坏、版本升级都会走到这里：清空并告警，绝不把半解密结果当成凭证
      entries.clear();
      console.error(`[credentials] 凭证缓存解密/解析失败，已丢弃（密钥变更或文件损坏）：${e.message}`);
      return 0;
    }
  }

  /** 关闭：先把未过期凭证落盘，再清空内存；可重复调用 */
  function close() {
    if (closed) return;
    flush();
    entries.clear();
    closed = true;
  }

  return { put, get, has, size, flush, load, close };
}
