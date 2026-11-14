#!/usr/bin/env node
'use strict';

/**
 * 1688 MCP 服务入口（MAF 规范版）：Streamable HTTP + 幂等账本 + 凭证隔离。
 *
 * 启动：
 *   MCP_HMAC_KEYS='{"keyId":"secret"}' node src/index.js
 *   MCP_1688_MOCK=1 node src/index.js       # 离线 mock 模式（不加载 Playwright）
 *
 * 端点：
 *   POST http://127.0.0.1:5207/mcp         JSON-RPC 2.0（需 MCP-HMAC 签名）
 *   GET  http://127.0.0.1:5207/healthz     轻量探活（免鉴权）
 */
import fs from 'node:fs';

import { createAdapters } from './adapters/index.js';
import { AUTH, CREDENTIALS, DATA_DIR, HTTP, LEDGER, LIMITS, MOCK_MODE } from './config.js';
import { startHttpServer } from './http/server.js';
import { openLedger } from './ledger/db.js';
import { createCredentialRegistry } from './security/credentials.js';
import { closeBrowser } from './browser.js';

const log = (...a) => console.error('[1688-mcp]', ...a);

let ledger = null;
let credentials = null;
let httpServer = null;
let cleanupTimer = null;
let shuttingDown = false;

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  ledger = openLedger({ path: LEDGER.path, retentionDays: LEDGER.retentionDays });
  const removed = ledger.cleanup();
  if (removed > 0) log(`账本清理：删除 ${removed} 条超过 ${LEDGER.retentionDays} 天的历史操作`);

  credentials = createCredentialRegistry({
    encryptionKey: CREDENTIALS.encryptionKey,
    cacheFile: CREDENTIALS.cacheFile,
    ttlSec: CREDENTIALS.ttlSec,
  });
  const loadedCreds = credentials.load();
  if (loadedCreds > 0) log(`凭证缓存：从加密文件恢复 ${loadedCreds} 个店铺凭证`);

  const adapters = await createAdapters();
  httpServer = await startHttpServer({ adapters, ledger, credentials });

  // 每 6 小时清理一次过期记录（unref，不阻止进程退出）
  cleanupTimer = setInterval(
    () => {
      try {
        const n = ledger.cleanup();
        if (n > 0) log(`账本例行清理：删除 ${n} 条过期记录`);
      } catch (e) {
        log('账本清理失败：', e?.message || e);
      }
    },
    6 * 60 * 60 * 1000,
  );
  cleanupTimer.unref?.();

  log(`ready · mode=${adapters.mode} · listen=${httpServer.url}`);
  log(`probe · GET http://${HTTP.host}:${HTTP.port}/healthz`);
  log(`ledger · ${LEDGER.path}`);
  log(`limits · concurrency=${LIMITS.maxConcurrency} timeout=${LIMITS.toolTimeoutMs}ms retention=${LEDGER.retentionDays}d`);
  if (MOCK_MODE) log('mock 模式：全部上游调用走本地夹具，不会访问 1688');
  if (AUTH.devMode) log(`警告：${AUTH.warning}`);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      shutdown(sig).catch((e) => {
        log('关闭失败：', e?.message || e);
        process.exit(1);
      });
    });
  }
}

async function shutdown(reason = 'manual') {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown (${reason}) ...`);
  try {
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (httpServer) await httpServer.close();
    if (credentials) credentials.close();
    if (ledger) ledger.close();
    await closeBrowser();
  } catch (e) {
    log('清理阶段异常：', e?.message || e);
  }
  log('bye');
  process.exit(0);
}

main().catch((e) => {
  log('fatal:', e?.stack || e?.message || e);
  process.exit(1);
});
