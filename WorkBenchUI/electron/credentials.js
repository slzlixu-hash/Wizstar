'use strict';

/**
 * 「记住账号和密码」的本地凭据存储（主进程专属）。
 *
 * 安全口径：
 *  - 优先用 Electron `safeStorage`（Windows 上是 DPAPI，绑定当前系统用户）加密后落盘；
 *  - 系统不支持加密时退化为 base64 + 仅当前用户可读的文件权限（0600），并在返回值里标注 encrypted=false；
 *  - 文件位于 app.getPath('userData')/login-credentials.json，不进仓库、不进渲染进程 localStorage；
 *  - 渲染进程只能通过 IPC 读取「填充用」的账号密码，拿不到文件本身。
 */

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;

function filePath() {
  return path.join(app.getPath('userData'), 'login-credentials.json');
}

function encryptionAvailable() {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function readFileSafe() {
  try {
    const text = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null; // 不存在 / 损坏都按「没记住」处理
  }
}

function writeFileSafe(payload) {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** 保存账号密码；密码为空时不保存（避免把空密码记住误填）。 */
function save(username, password) {
  const account = String(username || '').trim();
  const secret = String(password || '');
  if (!account || !secret) {
    return { ok: false, error: '账号或密码为空，未保存' };
  }

  const data = { username: account, password: secret, savedAt: new Date().toISOString() };
  const json = JSON.stringify(data);

  if (encryptionAvailable()) {
    writeFileSafe({
      version: VERSION,
      enc: 'safeStorage',
      data: safeStorage.encryptString(json).toString('base64'),
    });
    return { ok: true, encrypted: true };
  }

  writeFileSafe({ version: VERSION, enc: 'plain', data: Buffer.from(json, 'utf8').toString('base64') });
  return { ok: true, encrypted: false };
}

/** 读取已记住的账号密码；不存在或无法解密返回 null。 */
function load() {
  const raw = readFileSafe();
  if (!raw || !raw.data) return null;

  try {
    let json = null;
    if (raw.enc === 'safeStorage') {
      if (!encryptionAvailable()) return null; // 换了系统用户/机器，DPAPI 解不开
      json = safeStorage.decryptString(Buffer.from(raw.data, 'base64'));
    } else if (raw.enc === 'plain') {
      json = Buffer.from(raw.data, 'base64').toString('utf8');
    }
    if (!json) return null;

    const parsed = JSON.parse(json);
    if (!parsed || !parsed.username || !parsed.password) return null;
    return {
      username: String(parsed.username),
      password: String(parsed.password),
      savedAt: parsed.savedAt || null,
    };
  } catch (_) {
    return null;
  }
}

function clear() {
  try {
    fs.rmSync(filePath(), { force: true });
  } catch (_) {
    /* 文件不存在或占用：清空失败不影响登录 */
  }
}

module.exports = { save, load, clear, encryptionAvailable, filePath };
