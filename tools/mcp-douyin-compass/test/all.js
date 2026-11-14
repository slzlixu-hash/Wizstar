#!/usr/bin/env node
/** 顺序跑全部冒烟脚本；任一失败则整体失败。 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['步骤1 骨架/信封/HMAC', 'smoke.js'],
  ['步骤2 WS 桥接/幂等账本', 'bridge-smoke.js'],
  ['步骤3 MV3 探针契约', 'extension-smoke.js'],
  ['步骤4 解析器/筛选 DSL', 'parser-smoke.js'],
  ['步骤5 语义工具端到端', 'e2e-smoke.js']
];

let failed = 0;
for (const [label, file] of SUITES) {
  console.log(`\n===== ${label} (${file}) =====`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });
  if (result.status !== 0) {
    failed++;
    console.error(`[all] ${label} 失败（exit ${result.status}）`);
  }
}
console.log(`\n[all] ${SUITES.length - failed}/${SUITES.length} 组通过`);
if (failed) process.exitCode = 1;
