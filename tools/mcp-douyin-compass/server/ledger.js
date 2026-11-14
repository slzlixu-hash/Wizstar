#!/usr/bin/env node
/**
 * 本地幂等账本（规范 §4）
 *
 * 口径：
 *   - 主键 (scope, operationId)，operationId 由平台下发，服务绝不自行生成。
 *     本服务不使用店铺 AppKey/Secret（凭证是浏览器页面会话 Cookie），故 scope 固定为 'compass'，
 *     凭证明文/哈希一律不入库、不进日志。
 *   - 同 operationId + 同参数 → 回放历史信封（replayed:true），不触发二次采集。
 *   - 同 operationId + 参数被篡改 → 43009（严重异常，直接终止）。
 *   - EXECUTING 孤儿记录（进程崩溃遗留）→ 允许「补缺」重跑，不覆盖已有结果。
 *   - 至少保留 30 天，支持 meta.list_operations({operationIds, since}) 孤儿对账。
 *   - 并发同键去重：in-flight Map，第二个调用等待首个结果后回放，杜绝重复下发。
 *
 * 实现：Node ≥22.5 用内置 node:sqlite（WAL，单文件，无外部依赖）；
 *       不可用时自动降级为 JSONL + 原子落盘（tmp + rename），对外接口完全一致。
 *
 * 严禁直连平台业务主库（规范 §1.1）：本文件只碰服务私有 data/ledger.db。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ErrorCodes, fail, replayed } = require('./envelope');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'ledger.db');
const JSONL_PATH = path.join(DATA_DIR, 'ledger.jsonl');
const SCOPE = 'compass';
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 稳定序列化：对象 key 排序，保证参数指纹不受键顺序影响。 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function paramHash(args) {
  return crypto.createHash('sha256').update(stable(args || {})).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function tsToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// ------------------------------------------------------------------ SQLite 后端

function createSqliteBackend(dataDir, dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      scope        TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      param_hash   TEXT NOT NULL,
      status       TEXT NOT NULL,
      envelope     TEXT,
      error_code   INTEGER,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (scope, operation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_operations_created ON operations(created_at);
  `);

  const getStmt = db.prepare('SELECT * FROM operations WHERE scope = ? AND operation_id = ?');
  const insertStmt = db.prepare(`INSERT INTO operations
    (scope, operation_id, param_hash, status, envelope, error_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateStmt = db.prepare(`UPDATE operations
    SET status = ?, envelope = ?, error_code = ?, updated_at = ?
    WHERE scope = ? AND operation_id = ?`);
  const purgeStmt = db.prepare('DELETE FROM operations WHERE created_at < ?');

  return {
    backend: 'sqlite-wal',
    get: (operationId) => getStmt.get(SCOPE, operationId) || null,
    insert: (row) => insertStmt.run(SCOPE, row.operationId, row.paramHash, row.status,
      row.envelope, row.errorCode, row.createdAt, row.updatedAt),
    update: (row) => updateStmt.run(row.status, row.envelope, row.errorCode, row.updatedAt, SCOPE, row.operationId),
    all: () => db.prepare('SELECT * FROM operations ORDER BY created_at DESC').all(),
    purge: (cutoffIso) => { purgeStmt.run(cutoffIso); },
    close: () => db.close()
  };
}

// ------------------------------------------------------------------ JSONL 降级后端

function createJsonlBackend(dataDir, jsonlPath) {
  fs.mkdirSync(dataDir, { recursive: true });
  let rows = [];
  if (fs.existsSync(jsonlPath)) {
    for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch (_) { /* 跳过坏行，不中断服务 */ }
    }
  }

  function flush() {
    const tmp = jsonlPath + '.tmp';
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, jsonlPath); // 原子替换
  }

  return {
    backend: 'jsonl-atomic',
    get: (operationId) => rows.find((r) => r.scope === SCOPE && r.operation_id === operationId) || null,
    insert: (row) => {
      rows.push({
        scope: SCOPE,
        operation_id: row.operationId,
        param_hash: row.paramHash,
        status: row.status,
        envelope: row.envelope,
        error_code: row.errorCode,
        created_at: row.createdAt,
        updated_at: row.updatedAt
      });
      flush();
    },
    update: (row) => {
      const hit = rows.find((r) => r.scope === SCOPE && r.operation_id === row.operationId);
      if (!hit) return;
      hit.status = row.status;
      hit.envelope = row.envelope;
      hit.error_code = row.errorCode;
      hit.updated_at = row.updatedAt;
      flush();
    },
    all: () => rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    purge: (cutoffIso) => {
      const before = rows.length;
      rows = rows.filter((r) => String(r.created_at) >= cutoffIso);
      if (rows.length !== before) flush();
    },
    close: () => {}
  };
}

// ------------------------------------------------------------------ 对外接口

function create(options = {}) {
  // 允许测试注入临时目录（options 或环境变量），避免污染服务真实 data/
  const dataDir = options.dataDir || process.env.WIZSTAR_COMPASS_LEDGER_DIR || DATA_DIR;
  const dbPath = options.dbPath || (dataDir === DATA_DIR ? DB_PATH : path.join(dataDir, 'ledger.db'));
  const jsonlPath = options.jsonlPath || (dataDir === DATA_DIR ? JSONL_PATH : path.join(dataDir, 'ledger.jsonl'));

  let storage;
  try {
    storage = createSqliteBackend(dataDir, dbPath);
  } catch (e) {
    console.warn(`[ledger] node:sqlite 不可用，降级 JSONL：${e && e.message ? e.message : e}`);
    storage = createJsonlBackend(dataDir, jsonlPath);
  }

  const inflight = new Map(); // `${scope}|${operationId}` -> Promise<envelope>
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  try { storage.purge(cutoff); } catch (e) { console.warn('[ledger] 清理过期记录失败:', e.message); }

  function rowEnvelope(row) {
    if (!row || !row.envelope) return null;
    try { return JSON.parse(row.envelope); } catch (_) { return null; }
  }

  /**
   * 幂等执行包装。
   * @param {string} operationId 平台下发
   * @param {object} args        完整参数（用于指纹）
   * @param {Function} runOnce   真正执行一次，返回统一信封
   * @returns {Promise<object>}  统一信封（回放时 replayed=true）
   */
  async function run(operationId, args, runOnce) {
    const hash = paramHash(args);
    const key = `${SCOPE}|${operationId}`;

    // 并发去重：同键第二次不重复下发，等首个结果后回放
    if (inflight.has(key)) {
      const first = await inflight.get(key);
      return replayed(first);
    }

    const existing = storage.get(operationId);
    if (existing) {
      if (existing.param_hash !== hash) {
        return fail(
          ErrorCodes.IdempotencyConflict,
          `幂等冲突：operationId=${operationId} 的参数与历史记录不一致（规范 §4 / 43009）`
        );
      }
      if (existing.status !== 'EXECUTING') {
        const env = rowEnvelope(existing);
        if (env) return replayed(env);
      }
      // EXECUTING 且无结果 = 孤儿记录，按「只补缺不覆盖」允许重跑
    }

    const task = (async () => {
      const at = nowIso();
      if (!existing) {
        storage.insert({
          operationId,
          paramHash: hash,
          status: 'EXECUTING',
          envelope: null,
          errorCode: null,
          createdAt: at,
          updatedAt: at
        });
      }

      let envelope;
      try {
        envelope = await runOnce();
      } catch (e) {
        envelope = fail(ErrorCodes.InternalError, `采集异常：${e && e.message ? e.message : String(e)}`);
      }

      storage.update({
        operationId,
        status: envelope.success ? 'SUCCEEDED' : 'FAILED',
        envelope: JSON.stringify(envelope),
        errorCode: envelope.error ? envelope.error.code : null,
        updatedAt: nowIso()
      });
      return envelope;
    })();

    inflight.set(key, task);
    try {
      return await task;
    } finally {
      inflight.delete(key);
    }
  }

  function stats() {
    const rows = storage.all();
    const byStatus = { EXECUTING: 0, SUCCEEDED: 0, FAILED: 0 };
    let oldest = null;
    for (const r of rows) {
      if (byStatus[r.status] !== undefined) byStatus[r.status]++;
      if (!oldest || String(r.created_at) < oldest) oldest = r.created_at;
    }
    return {
      available: true,
      backend: storage.backend,
      entries: rows.length,
      executing: byStatus.EXECUTING,
      succeeded: byStatus.SUCCEEDED,
      failed: byStatus.FAILED,
      oldestAt: oldest,
      retentionDays: RETENTION_DAYS,
      scope: SCOPE
    };
  }

  /** 孤儿对账：只返回脱敏摘要，不含参数明文与凭证。 */
  function list(query = {}) {
    const ids = Array.isArray(query.operationIds) ? query.operationIds.filter((x) => typeof x === 'string') : [];
    const sinceMs = tsToMs(query.since);
    const idSet = new Set(ids);
    return storage.all()
      .filter((r) => ids.length === 0 || idSet.has(r.operation_id))
      .filter((r) => sinceMs === null || Date.parse(r.created_at) >= sinceMs)
      .map((r) => ({
        operationId: r.operation_id,
        scope: r.scope,
        status: r.status,
        errorCode: r.error_code,
        paramHash: r.param_hash,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        hasResult: Boolean(r.envelope)
      }));
  }

  return { run, stats, list, close: () => storage.close(), backend: storage.backend, paramHash };
}

module.exports = { create, paramHash, RETENTION_DAYS, SCOPE, DATA_DIR };
