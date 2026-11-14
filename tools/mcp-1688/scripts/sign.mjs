#!/usr/bin/env node
'use strict';

/**
 * MCP-HMAC 签名小工具（联调/自测用，不属于服务运行时）。
 *
 * 用法：
 *   node scripts/sign.mjs --key-id dev --secret s3cret --path /mcp \
 *     --body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
 *
 *   # 从文件读请求体，并直接输出可粘贴的 curl
 *   node scripts/sign.mjs --key-id dev --secret s3cret --body-file req.json --curl
 *
 * 密钥也可以走环境变量：MCP_HMAC_KEY / MCP_HMAC_KEY_ID。
 */
import fs from 'node:fs';
import process from 'node:process';

import { signRequest } from '../src/http/auth.js';

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
const keyId = args['key-id'] || process.env.MCP_HMAC_KEY_ID || 'dev';
const secret = args.secret || process.env.MCP_HMAC_KEY || '';
const method = String(args.method || 'POST').toUpperCase();
const path = String(args.path || '/mcp');
const ts = args.ts ? Number(args.ts) : undefined;
const nonce = args.nonce ? String(args.nonce) : undefined;

if (!secret) {
  console.error('缺少签名密钥：传 --secret <secret> 或设置 MCP_HMAC_KEY 环境变量');
  process.exit(2);
}

let rawBody = '';
if (typeof args['body-file'] === 'string') rawBody = fs.readFileSync(args['body-file'], 'utf8');
else if (typeof args.body === 'string') rawBody = args.body;
else rawBody = '';

const authorization = signRequest({ secret, keyId, method, path, rawBody, ts, nonce });

if (args.curl) {
  console.log(
    [
      'curl -sS http://127.0.0.1:5207' + path,
      `-H 'content-type: application/json'`,
      `-H 'accept: application/json, text/event-stream'`,
      `-H 'mcp-protocol-version: 2025-06-18'`,
      `-H 'authorization: ${authorization}'`,
      `-H 'x-shop-credential: <base64url({appId,appSecret,shopId})>'`,
      `--data-binary @- <<'JSON'`,
      rawBody || '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      'JSON',
    ].join(' \\\n  '),
  );
} else {
  console.log(JSON.stringify({ authorization, method, path, bodyLength: Buffer.byteLength(rawBody) }, null, 2));
}
