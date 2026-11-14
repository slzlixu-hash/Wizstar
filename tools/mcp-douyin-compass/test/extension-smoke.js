#!/usr/bin/env node
/**
 * 步骤 3 专项冒烟：MV3 探针扩展静态契约校验
 *
 * 覆盖：
 *   - manifest 权限最小化（无 <all_urls> / cookies / declarativeNetRequest / webRequest）
 *   - 4 项安全加固：type 白名单、channelToken 握手、Request body 改写、域名白名单
 *   - 凭证红线：脚本中不出现 document.cookie / Set-Cookie / Authorization 回传
 *   - SW / content / inject 与 server/bridge.js 的消息协议对齐
 *   - selectors.json：9 条榜单规则、搜索词 3 接口、类目、DOM 选择器齐全
 *   - GET /selectors.json 端点可用且热更新字段存在
 *
 * 运行：node tools/mcp-douyin-compass/test/extension-smoke.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EXT = path.join(__dirname, '..', 'extension-mv3');
const SERVER = path.join(__dirname, '..', 'server');
let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push({ name, error: e.message }); console.log(`  FAIL  ${name} :: ${e.message}`); }
}
function read(name) { return fs.readFileSync(path.join(EXT, name), 'utf8'); }

/** 剥离块注释与行注释，只保留可执行代码（安全红线必须校验真实代码，而非注释措辞）。 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const manifest = JSON.parse(read('manifest.json'));
const inject = read('inject.js');
const content = read('content.js');
const sw = read('sw.js');
const selectors = JSON.parse(fs.readFileSync(path.join(SERVER, 'selectors.json'), 'utf8'));
const bridge = fs.readFileSync(path.join(SERVER, 'bridge.js'), 'utf8');

console.log('\n[mcp-douyin-compass extension-smoke]\n');

// ------------------------------------------------------------- manifest
check('manifest v3 + module SW', () => {
  assert.strictEqual(manifest.manifest_version, 3);
  assert.strictEqual(manifest.background.type, 'module');
  assert.strictEqual(manifest.background.service_worker, 'sw.js');
});
check('权限最小化：仅 storage', () => {
  assert.deepStrictEqual(manifest.permissions, ['storage']);
});
check('host_permissions 只含罗盘域名与本地回环', () => {
  const hosts = manifest.host_permissions;
  assert.strictEqual(hosts.length, 2);
  assert(hosts.includes('https://compass.jinritemai.com/*'));
  assert(hosts.includes('http://127.0.0.1:5206/*'));
  assert(!hosts.includes('<all_urls>'));
});
check('未申请高危权限', () => {
  const all = JSON.stringify(manifest).toLowerCase();
  for (const bad of ['cookies', 'declarativenetrequest', 'webrequest', 'tabs', 'debugger', 'scripting']) {
    assert(!all.includes(bad), `不应申请 ${bad}`);
  }
});
check('content_scripts 两层：isolated + MAIN world', () => {
  const cs = manifest.content_scripts;
  assert.strictEqual(cs.length, 2);
  assert.strictEqual(cs[0].world, undefined);
  assert.strictEqual(cs[0].run_at, 'document_idle');
  assert.strictEqual(cs[1].world, 'MAIN');
  assert.strictEqual(cs[1].run_at, 'document_start');
  for (const c of cs) {
    assert.deepStrictEqual(c.matches, ['https://compass.jinritemai.com/*']);
    assert.strictEqual(c.all_frames, false);
  }
});

// ------------------------------------------------------------- A. type 分流
check('A. inject 有 COMMAND_TYPES 白名单且校验 source', () => {
  assert(/COMMAND_TYPES\s*=\s*new Set\(/.test(inject));
  assert(/COMMAND_TYPES\.has\(msg\.type\)/.test(inject));
  assert(/msg\.source\s*!==\s*SRC_IN/.test(inject));
  assert(/event\.source\s*!==\s*window/.test(inject));
});
check('A. content 有 INJECT_TYPES 白名单，CATEGORY_DATA 单独处理', () => {
  assert(/INJECT_TYPES\s*=\s*new Set\(/.test(content));
  assert(/INJECT_TYPES\.has\(msg\.type\)/.test(content));
  assert(/case 'CATEGORY_DATA'/.test(content));
  assert(/lastCategory\s*=\s*msg\.data/.test(content), '类目必须单独缓存，不能写错 storage 键');
});
check('A. 类目消息不会走 API_RESPONSE 分支', () => {
  const block = content.slice(content.indexOf("case 'CATEGORY_DATA'"), content.indexOf("case 'API_RESPONSE'"));
  assert(!/storage\.local\.set/.test(block), '不得把类目/其它响应混写同一键');
});

// ------------------------------------------------------------- B. channelToken
check('B. inject 校验动态 channelToken', () => {
  assert(/SET_CHANNEL_TOKEN/.test(inject));
  assert(/msg\.channelToken\s*!==\s*channelToken/.test(inject));
  assert(/!channelToken\)\s*return/.test(inject));
});
check('B. SW 从 CHALLENGE 取 token 并回 HELLO', () => {
  assert(/type === 'CHALLENGE'/.test(sw));
  assert(/channelToken\s*=\s*msg\.channelToken/.test(sw));
  assert(/type: 'HELLO'/.test(sw));
});
check('B. content 在 HELLO 时把 token 下发给 inject', () => {
  assert(/case 'HELLO'/.test(content));
  assert(/toInject\('SET_CHANNEL_TOKEN'/.test(content));
});
check('B. 服务端 bridge 确有一次性 CHALLENGE 与轮换', () => {
  assert(/CHALLENGE/.test(bridge));
  assert(/channelToken\s*=\s*crypto\.randomBytes/.test(bridge));
  assert(/HELLO_TIMEOUT_MS/.test(bridge));
});

// ------------------------------------------------------------- C. Request body
check('C. fetch 入参为 Request 时读取自身 body 并重建', () => {
  assert(/input instanceof Request/.test(inject));
  assert(/input\.clone\(\)\.text\(\)/.test(inject), '必须读 Request 自身 body');
  assert(/rewriteBody\(body, rule\)/.test(inject));
  assert(/method: input\.method/.test(inject));
});
check('C. JSON 深合并 / urlencoded 两种 body 改写', () => {
  assert(/deepMerge/.test(inject));
  assert(/urlencoded/.test(inject));
  assert(/URLSearchParams/.test(inject));
});
check('C. query 覆盖/追加（含数组与 null 删除）', () => {
  assert(/applyQuery/.test(inject));
  assert(/searchParams\.delete/.test(inject));
  assert(/searchParams\.append/.test(inject));
  assert(/searchParams\.set/.test(inject));
});

// ------------------------------------------------------------- D. 域名白名单
check('D. inject 的 PAGE_FETCH 强制域名白名单', () => {
  assert(/hostAllowed\(url\)/.test(inject));
  assert(/ALLOWED_HOSTS/.test(inject));
  assert(/域名白名单拒绝/.test(inject));
});
check('D. 服务端 bridge 也锁同一域名白名单', () => {
  assert(/ALLOWED_HOSTS/.test(bridge));
  assert(/compass\.jinritemai\.com/.test(bridge));
  assert(/PAGE_FETCH 域名白名单拒绝/.test(bridge));
});
check('D. selectors 的 allowedHosts 只有罗盘域名', () => {
  assert.deepStrictEqual(selectors.allowedHosts, ['compass.jinritemai.com']);
});

// ------------------------------------------------------------- 凭证红线
check('凭证红线：三层脚本的可执行代码都不读 document.cookie', () => {
  for (const [name, src] of [['inject', inject], ['content', content], ['sw', sw]]) {
    const code = codeOnly(src);
    assert(!/document\.cookie/.test(code), `${name} 读取了 document.cookie`);
    assert(!/getCookie|cookieStore/.test(code), `${name} 读取了 Cookie`);
  }
});
check('凭证红线：可执行代码不回传 Authorization / Set-Cookie', () => {
  for (const [name, src] of [['inject', inject], ['content', content], ['sw', sw]]) {
    const code = codeOnly(src);
    assert(!/Authorization/.test(code), `${name} 出现了 Authorization`);
    assert(!/Set-Cookie/.test(code), `${name} 出现了 Set-Cookie`);
  }
});
check('PAGE_FETCH 用 credentials:include 借页面会话（不读取 Cookie）', () => {
  assert(/credentials:\s*'include'/.test(inject));
});
check('SW 只回传响应体，不携带凭证字段', () => {
  assert(/payload/.test(sw));
  assert(!/cookie/i.test(sw.replace(/Cookie 头|凭证|Cookie \/ 凭证/g, '')), 'SW 不应处理 Cookie');
});

// ------------------------------------------------------------- 协议对齐
check('SW / content / inject 与 bridge 的 type 集合对齐', () => {
  for (const t of ['CHALLENGE', 'HELLO', 'HELLO_ACK', 'CMD', 'PING', 'PONG', 'RESULT', 'ERROR', 'ABORT', 'EVENT']) {
    assert(bridge.includes(t) || sw.includes(t), `协议缺少 ${t}`);
  }
  assert(/PAGE_FETCH_RESULT/.test(inject) && /PAGE_FETCH_RESULT/.test(content));
  assert(/API_RESPONSE/.test(inject) && /API_RESPONSE/.test(content));
  assert(/CATEGORY_DATA/.test(inject) && /CATEGORY_DATA/.test(content));
});
check('SW 指令集覆盖 content 的动作集', () => {
  for (const action of ['PAGE_FETCH', 'SET_RULES', 'SWITCH_TAB', 'NEXT_PAGE', 'PAGINATION', 'WAIT_CAPTURE', 'GET_CATEGORY', 'READ_PRICES', 'PING']) {
    assert(sw.includes(`case '${action}'`), `SW 缺 ${action}`);
    assert(content.includes(`case '${action}'`), `content 缺 ${action}`);
  }
});
check('SW 有断线重连与代际号校验', () => {
  assert(/scheduleReconnect/.test(sw));
  assert(/generation/.test(sw));
  assert(/Number\(msg\.generation\) !== generation/.test(sw));
});

// ------------------------------------------------------------- selectors 契约
check('9 条榜单规则齐全且 id 唯一', () => {
  assert.strictEqual(selectors.rankRules.length, 9);
  const ids = selectors.rankRules.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, 9);
  for (const r of selectors.rankRules) {
    assert(r.rankType && r.match, `${r.id} 缺 rankType/match`);
    assert(r.responsePath || Array.isArray(r.responsePaths), `${r.id} 缺响应路径`);
  }
});
check('9 榜单接口路径与逆向报告一致', () => {
  const all = JSON.stringify(selectors.rankRules);
  for (const p of [
    'market_hot_sale', 'product_rank/search', 'live_product', 'product_card_hot_v2',
    'author_bring_good', 'video_bring_good', 'realtime_hot_dig', 'refund_analyse_v2/rank_list'
  ]) assert(all.includes(p), `缺少接口 ${p}`);
  const refunds = selectors.rankRules.filter((r) => r.match && r.match.query && r.match.query.rank_type);
  assert.deepStrictEqual(refunds.map((r) => r.match.query.rank_type).sort(), ['2', '3']);
});
check('搜索词 3 个接口与响应路径齐全', () => {
  const s = selectors.searchAnalysis;
  assert(s.dateRange.url.includes('data_range_v2'));
  assert(s.wordRank.url.includes('compass_rank_v3'));
  assert(s.wordProducts.url.includes('industry_detail_list_v2'));
  assert(s.wordRank.wordPath.includes('cell_info.query.value.value_str'));
  assert(s.wordProducts.productPath.includes('cell_info.product.product'));
});
check('类目接口与 DOM 选择器齐全', () => {
  assert(selectors.category.urlContains.includes('cate_list'));
  const d = selectors.dom;
  for (const k of ['tabButtons', 'paginationNext', 'realtimeScroller', 'productName', 'priceText', 'tableRow']) {
    assert(d[k], `DOM 选择器缺 ${k}`);
  }
});
check('价格解析拆 min/suggested 且不硬编码 0.01', () => {
  const code = codeOnly(content);
  assert(/isRange/.test(code));
  assert(/suggested/.test(code));
  assert(/Math\.round\(yuan\[0\] \* 100\)/.test(code));
  assert(!/0\.01/.test(code), '可执行代码不得再硬编码 0.01');
});

// ------------------------------------------------------------- /selectors.json 端点
(async () => {
  process.env.PORT = '0';
  const { createServer } = require('../server/index');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/selectors.json' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    check('GET /selectors.json 200 + 热更新字段 servedAt', () => {
      assert.strictEqual(result.status, 200);
      const json = JSON.parse(result.body);
      assert.strictEqual(json.rankRules.length, 9);
      assert(json.servedAt, '缺少 servedAt（热更新标记）');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n[extension-smoke] ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
})().catch((e) => { console.error('[extension-smoke] 崩溃:', e); process.exitCode = 1; });
