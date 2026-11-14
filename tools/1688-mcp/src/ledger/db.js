'use strict';

/**
 * 本地幂等账本（规范第 4 章）。
 *
 * 为什么是 SQLite WAL：
 * - MAF 要求「单文件、零外部数据库」，WAL 模式读写不互相阻塞，
 *   同进程内一次写入耗时在亚毫秒级，够用且便于整体拷贝备份；
 * - 主键 (shop_key, operation_id) 天然完成跨店铺隔离，
 *   同一 operationId 在不同店铺是两条独立记录，不会被误判为回放。
 *
 * begin() 用 BEGIN IMMEDIATE 包住「查 → 判定 → 插入」：
 * - 若用 DEFERRED，两个并发调用都可能先读到「不存在」再同时插入，变成竞态；
 * - IMMEDIATE 立刻拿写锁，配合 busy_timeout=3000 让并发请求排队而不是报 SQLITE_BUSY。
 *
 * 状态机：EXECUTING → SUCCEEDED / FAILED，其余情况一律按「不重复执行」处理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { invalidParams } from '../core/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** IN 查询每批参数上限：远低于 SQLite 的 999/32766 变量上限，避免拼出超长 SQL */
const IN_CHUNK = 200;
/** meta.list_operations 单次返回条数硬上限 */
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operations (
  shop_key      TEXT    NOT NULL,
  operation_id  TEXT    NOT NULL,
  tool          TEXT    NOT NULL DEFAULT '',
  params_hash   TEXT    NOT NULL,
  params_json   TEXT,
  status        TEXT    NOT NULL,
  result        TEXT,
  error         TEXT,
  trace_id      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (shop_key, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_operations_created ON operations (created_at);
CREATE INDEX IF NOT EXISTS idx_operations_shop_created ON operations (shop_key, created_at);
`;

/** 值 → JSON 文本；undefined/函数等无法序列化时存 null，绝不让账本写入拖垮业务返回 */
function jsonText(value) {
  if (value == null) return null;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : text;
  } catch (e) {
    console.error(`[ledger] 结果无法 JSON 序列化，已存 null：${e.message}`);
    return null;
  }
}

/**
 * paramsJson 语义：调用方传入的通常已是 JSON 文本快照（与 paramsHash 一一对应），
 * 因此字符串按原样存储，保持「快照字节」语义；对象/数组才序列化。
 */
function paramsText(paramsJson) {
  if (paramsJson == null) return null;
  if (typeof paramsJson === 'string') return paramsJson;
  return jsonText(paramsJson);
}

function parseJson(text) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 手工改库/部分写入的脏数据：当作 null，而不是让查询整体失败
    return null;
  }
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    shopKey: String(row.shop_key),
    operationId: String(row.operation_id),
    tool: String(row.tool ?? ''),
    paramsHash: String(row.params_hash ?? ''),
    // 原样返回当初写入的快照文本，调用方需要对象时自行 JSON.parse
    paramsJson: row.params_json == null ? null : String(row.params_json),
    status: String(row.status),
    result: parseJson(row.result),
    error: parseJson(row.error),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function assertShopKey(shopKey) {
  if (typeof shopKey !== 'string' || shopKey.trim() === '') {
    throw invalidParams('账本操作必须提供 shopKey（形如 appId:shopId），否则无法隔离跨店铺操作');
  }
}

function assertOperationId(operationId) {
  if (typeof operationId !== 'string' || operationId.trim() === '') {
    throw invalidParams('账本操作必须提供 operationId（由 MAF 平台下发的幂等流水号）');
  }
}

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 打开/创建账本。
 *
 * @param {object} o
 * @param {string} o.path SQLite 文件路径，或 ':memory:'（测试用）
 * @param {number} [o.retentionDays] 保留天数，cleanup() 的默认值
 * @param {() => number} [o.now] 注入时钟（毫秒），测试用
 */
export function openLedger({ path: dbPath, retentionDays = 30, now = () => Date.now() } = {}) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new TypeError('openLedger 需要 path（SQLite 文件路径或 ":memory:"）');
  }

  // 目录不存在时自动创建：默认落在 <project>/.data 下，首次启动常见
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);

  const stmtGet = db.prepare('SELECT * FROM operations WHERE shop_key = ? AND operation_id = ?');
  const stmtInsert = db.prepare(
    `INSERT INTO operations
       (shop_key, operation_id, tool, params_hash, params_json, status, result, error, trace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  );
  const stmtComplete = db.prepare(
    `UPDATE operations
        SET status = 'SUCCEEDED', result = ?, error = NULL, updated_at = ?, trace_id = COALESCE(?, trace_id)
      WHERE shop_key = ? AND operation_id = ?`,
  );
  const stmtFail = db.prepare(
    `UPDATE operations
        SET status = 'FAILED', error = ?, updated_at = ?, trace_id = COALESCE(?, trace_id)
      WHERE shop_key = ? AND operation_id = ?`,
  );
  const stmtList = db.prepare(
    'SELECT * FROM operations WHERE shop_key = ? ORDER BY created_at DESC, operation_id ASC LIMIT ?',
  );
  const stmtListSince = db.prepare(
    'SELECT * FROM operations WHERE shop_key = ? AND created_at >= ? ORDER BY created_at DESC, operation_id ASC LIMIT ?',
  );
  const stmtCount = db.prepare('SELECT COUNT(*) AS c FROM operations');
  const stmtCountShop = db.prepare('SELECT COUNT(*) AS c FROM operations WHERE shop_key = ?');
  const stmtDeleteOld = db.prepare('DELETE FROM operations WHERE created_at < ?');

  /** 动态 IN 语句按「批大小 + 是否带 since」缓存，避免每次 list 重新 prepare */
  const inCache = new Map();
  function inStatement(batchSize, withSince) {
    const cacheKey = `${batchSize}:${withSince ? 1 : 0}`;
    let stmt = inCache.get(cacheKey);
    if (!stmt) {
      const placeholders = new Array(batchSize).fill('?').join(', ');
      stmt = db.prepare(
        `SELECT * FROM operations
          WHERE shop_key = ? AND operation_id IN (${placeholders})${withSince ? ' AND created_at >= ?' : ''}
          ORDER BY created_at DESC, operation_id ASC LIMIT ?`,
      );
      inCache.set(cacheKey, stmt);
    }
    return stmt;
  }

  let closed = false;
  function assertOpen() {
    if (closed) throw new Error('账本已关闭（close() 之后不可再用）');
  }

  /**
   * 幂等入口：原子地判定 new / in_progress / replay / tampered。
   *
   * @param {object} o
   * @param {string} o.shopKey
   * @param {string} o.operationId
   * @param {string} [o.tool]
   * @param {string} o.paramsHash 参数规范化后的 sha256（调用方计算，保证跨语言一致）
   * @param {string|object} [o.paramsJson] 参数快照
   * @param {string} [o.traceId]
   * @returns {{state:'new'|'replay'|'tampered'|'in_progress', record?:object}}
   */
  function begin({ shopKey, operationId, tool = '', paramsHash, paramsJson = null, traceId = null } = {}) {
    assertOpen();
    assertShopKey(shopKey);
    assertOperationId(operationId);
    if (typeof paramsHash !== 'string' || paramsHash === '') {
      // 没有参数哈希就无法识别「同 operationId 改参数」的篡改，宁可直接拒绝
      throw invalidParams('begin 需要 paramsHash（参数规范化后的 sha256），否则无法检测参数篡改');
    }

    const hash = paramsHash;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = stmtGet.get(shopKey, operationId);
      if (!row) {
        const t = now();
        stmtInsert.run(
          shopKey,
          operationId,
          String(tool ?? ''),
          hash,
          paramsText(paramsJson),
          'EXECUTING',
          traceId == null ? null : String(traceId),
          t,
          t,
        );
        db.exec('COMMIT');
        return { state: 'new' };
      }

      const record = rowToRecord(row);
      // 先比参数再比状态：参数变了就是状态错乱，优先级高于「执行中/已回放」
      if (record.paramsHash !== hash) {
        db.exec('COMMIT');
        return { state: 'tampered', record };
      }
      if (record.status === 'EXECUTING') {
        db.exec('COMMIT');
        return { state: 'in_progress', record };
      }
      db.exec('COMMIT');
      return { state: 'replay', record };
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ROLLBACK 失败说明事务已被 SQLite 自动回滚，保留原始错误更重要
      }
      throw e;
    }
  }

  /** 标记成功并落结果；返回 void，行不存在（例如已过保留期被清）时静默 no-op */
  function complete({ shopKey, operationId, result = null, traceId = null } = {}) {
    assertOpen();
    assertShopKey(shopKey);
    assertOperationId(operationId);
    stmtComplete.run(jsonText(result), now(), traceId == null ? null : String(traceId), shopKey, operationId);
  }

  /** 标记失败并落错误快照；同样对不存在的行静默 no-op */
  function fail({ shopKey, operationId, error = null, traceId = null } = {}) {
    assertOpen();
    assertShopKey(shopKey);
    assertOperationId(operationId);
    stmtFail.run(jsonText(error), now(), traceId == null ? null : String(traceId), shopKey, operationId);
  }

  /** 单条查询；不存在返回 null */
  function get(shopKey, operationId) {
    assertOpen();
    assertShopKey(shopKey);
    if (typeof operationId !== 'string' || operationId === '') return null;
    return rowToRecord(stmtGet.get(shopKey, operationId));
  }

  /**
   * 对账查询（meta.list_operations）。
   * shopKey 必填：这是跨店铺隔离红线，绝不提供「查全库」的入口。
   *
   * @param {object} o
   * @param {string} o.shopKey
   * @param {string[]} [o.operationIds] 为空数组表示「明确查这 0 个」，返回 []
   * @param {number} [o.since] 起始时间（ms，含）
   * @param {number} [o.limit] 上限 500，默认 200
   */
  function list({ shopKey, operationIds, since, limit = DEFAULT_LIST_LIMIT } = {}) {
    assertOpen();
    assertShopKey(shopKey);

    const cap = clampLimit(limit);
    const sinceMs = Number.isFinite(Number(since)) ? Number(since) : null;
    const hasSince = sinceMs != null;

    // 去重 + 去空，避免重复 ID 放大 SQL 参数
    const ids = Array.isArray(operationIds)
      ? [...new Set(operationIds.filter((v) => typeof v === 'string' && v !== ''))]
      : null;
    if (ids && ids.length === 0) return [];

    const rows = [];
    // 不传 operationIds：按店铺直接扫最近的 N 条
    if (!ids) {
      const found = hasSince ? stmtListSince.all(shopKey, sinceMs, cap) : stmtList.all(shopKey, cap);
      for (const r of found) rows.push(rowToRecord(r));
    } else {
      // 大批量 ID 分批查（每批 <= IN_CHUNK），最后统一排序截断，语义等价于一条巨型 IN
      for (const batch of chunk(ids, IN_CHUNK)) {
        const stmt = inStatement(batch.length, hasSince);
        const found = hasSince
          ? stmt.all(shopKey, ...batch, sinceMs, cap)
          : stmt.all(shopKey, ...batch, cap);
        for (const r of found) rows.push(rowToRecord(r));
      }
    }

    rows.sort((a, b) => b.createdAt - a.createdAt || (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const key = `${r.shopKey}\u0000${r.operationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= cap) break;
    }
    return out;
  }

  /** 总条数（传 shopKey 时只统计该店铺，用于 meta.health 上报） */
  function count(shopKey) {
    assertOpen();
    if (typeof shopKey === 'string' && shopKey !== '') return Number(stmtCountShop.get(shopKey)?.c ?? 0);
    return Number(stmtCount.get()?.c ?? 0);
  }

  /**
   * 清理超过保留期的行（规范 4.2：至少保留 30 天）。
   * 由调用方在启动时/定时任务里触发；不在 open() 时自动删，
   * 避免「注入假时钟或导入历史库」的场景被意外清空。
   *
   * @param {object} [o]
   * @param {number|(() => number)} [o.now] 覆盖时钟（ms 或函数）
   * @param {number} [o.retentionDays] 覆盖保留天数
   * @returns {number} 删除行数
   */
  function cleanup(o = {}) {
    assertOpen();
    const days = Number.isFinite(Number(o.retentionDays)) ? Number(o.retentionDays) : retentionDays;
    let baseMs;
    if (typeof o.now === 'function') baseMs = o.now();
    else if (Number.isFinite(Number(o.now))) baseMs = Number(o.now);
    else baseMs = now();

    const cutoff = baseMs - Math.max(0, days) * DAY_MS;
    const info = stmtDeleteOld.run(cutoff);
    return Number(info?.changes ?? 0);
  }

  /** 关闭连接；重复调用安全（WAL 文件会在关闭时合并/清理） */
  function close() {
    if (closed) return;
    closed = true;
    inCache.clear();
    db.close();
  }

  return {
    /** 只读属性：账本文件路径（':memory:' 表示内存库） */
    get path() {
      return dbPath;
    },
    begin,
    complete,
    fail,
    get,
    list,
    count,
    cleanup,
    close,
  };
}
