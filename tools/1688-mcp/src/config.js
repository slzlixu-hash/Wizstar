'use strict';

/**
 * 1688 MCP 服务配置（MAF 规范改造版）。
 *
 * 兼容旧的环境变量（Z1688_*），新增 HTTP / 鉴权 / 账本 / 凭证加密相关配置。
 * 所有默认值以「本机回环、离线可跑」为原则，生产环境必须显式提供 HMAC 密钥。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
const cliProfile = path.join(home, '.1688', 'profiles', 'default');

const bool = (v, def) => (v == null || v === '' ? def : !/^(0|false|no)$/i.test(String(v)));
const int = (v, def) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Chrome profile：优先复用 1688-cli 的登录态 */
export const PROFILE_DIR =
  process.env.Z1688_PROFILE_DIR ||
  (fs.existsSync(cliProfile) ? cliProfile : path.join(home, '.1688-mcp', 'profile'));

/** 浏览器是否无头（老变量语义：Z1688_HEADLESS=0 → 有头） */
export const HEADLESS = bool(process.env.Z1688_HEADLESS, true);
export const CHANNEL = process.env.Z1688_CHANNEL || 'chrome';

/** 本地页面抓取超时（沿用旧值） */
export const T = Object.freeze({
  nav: 30_000,
  capture: 25_000,
  upload: 20_000,
  offer: 20_000,
  poll: 300,
});

export const UA_NOTE =
  '1688 对自动化比较敏感：连续快速调用会触发滑块（punish 页）。保持人速（两次调用间隔 3s 以上），遇到滑块时用 login 工具以有头模式打开窗口手动过一次。';

/* ------------------------------ HTTP 传输 ------------------------------ */

export const HTTP = Object.freeze({
  host: process.env.MCP_HOST || '127.0.0.1',
  port: int(process.env.MCP_PORT, 5207),
  /** JSON-RPC 请求体上限 */
  maxBodyBytes: int(process.env.MCP_MAX_BODY_BYTES, 1024 * 1024),
  /** 与 MAF 平台约定的服务身份 */
  serverName: 'mcp-1688',
  serverVersion: '1.0.0',
  toolVersion: '1.0',
  protocolVersion: '2025-06-18',
  legacyProtocolVersions: Object.freeze(['2025-03-26']),
});

/* ------------------------------ 鉴权 ------------------------------ */

/**
 * HMAC 密钥表：`MCP_HMAC_KEYS` 为 JSON（{ keyId: secret }），
 * 或 `MCP_HMAC_KEY` 单密钥（keyId=default）。
 * 开发环境未配置时生成随机 dev 密钥（进程内有效，重启失效），并打印警告。
 */
function loadHmacKeys() {
  const raw = process.env.MCP_HMAC_KEYS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const keys = {};
      for (const [id, secret] of Object.entries(parsed)) {
        if (typeof secret === 'string' && secret.length >= 8) keys[id] = secret;
      }
      if (Object.keys(keys).length) return { keys, dev: false, warning: null };
      return null;
    } catch (e) {
      throw new Error(`MCP_HMAC_KEYS 不是合法 JSON：${e.message}`);
    }
  }
  if (process.env.MCP_HMAC_KEY) {
    return { keys: { default: process.env.MCP_HMAC_KEY }, dev: false, warning: null };
  }
  const devSecret = crypto.randomBytes(32).toString('base64url');
  return {
    keys: { dev: devSecret },
    dev: true,
    warning:
      '未配置 MCP_HMAC_KEYS / MCP_HMAC_KEY，已生成进程内随机 dev 密钥。生产环境必须显式配置！',
  };
}

const hmac = loadHmacKeys();
export const AUTH = Object.freeze({
  keys: hmac.keys,
  devMode: hmac.dev,
  warning: hmac.warning,
  /** 时间戳容差（秒） */
  toleranceSec: int(process.env.MCP_HMAC_TOLERANCE_SEC, 300),
  /** nonce 防重放 TTL（秒） */
  nonceTtlSec: int(process.env.MCP_NONCE_TTL_SEC, 600),
  /**
   * 本机回环免签（默认开）：127.0.0.1 / ::1 直连跳过验签，本地调试即插即用。
   * 仅当服务对外监听（MCP_HOST 非 127.0.0.1）且承载高危写操作时，才需要
   * 设 MCP_AUTH_LOOPBACK_BYPASS=0 关闭（Bearer 静态令牌通道仍可用）。
   */
  loopbackBypass: bool(process.env.MCP_AUTH_LOOPBACK_BYPASS, true),
});

/* ------------------------------ 账本 ------------------------------ */

const defaultDataDir = path.join(ROOT, '.data');
export const DATA_DIR = process.env.MCP_1688_DATA_DIR || defaultDataDir;
export const LEDGER = Object.freeze({
  path: process.env.MCP_LEDGER_PATH || path.join(DATA_DIR, 'ledger.db'),
  retentionDays: int(process.env.MCP_LEDGER_RETENTION_DAYS, 30),
  /** meta.list_operations 单次最多返回条数 */
  maxListSize: int(process.env.MCP_LEDGER_MAX_LIST, 200),
});

/* ------------------------------ 店铺凭证 ------------------------------ */

/**
 * AES-256-GCM 落盘密钥：32 字节 hex（64 字符）或任意长字符串（sha256 派生）。
 * 未配置时仅在内存缓存凭证，不落盘。
 */
export const CREDENTIALS = Object.freeze({
  encryptionKey: process.env.MCP_CREDENTIAL_KEY || null,
  cacheFile: process.env.MCP_CREDENTIAL_CACHE || path.join(DATA_DIR, 'credentials.enc.json'),
  ttlSec: int(process.env.MCP_CREDENTIAL_TTL_SEC, 300),
});

/* ------------------------------ 运行模式 ------------------------------ */

/** 离线 mock：不启动 Chrome，用内置假数据完成协议/幂等/错误归一化自测 */
export const MOCK_MODE = bool(process.env.MCP_1688_MOCK ?? process.env.Z1688_MOCK, false);

/** 限流：单进程最大并发（meta.describe 会如实上报） */
export const LIMITS = Object.freeze({
  maxConcurrency: int(process.env.MCP_MAX_CONCURRENCY, 4),
  /** 工具默认超时（毫秒），超时按 50001 归一化 */
  toolTimeoutMs: int(process.env.MCP_TOOL_TIMEOUT_MS, 60_000),
});
