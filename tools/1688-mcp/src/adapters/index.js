'use strict';

/**
 * 适配器工厂：真实上游（Playwright 抓 1688）与离线 mock 二选一。
 *
 * mock 模式下用动态 import 避开 playwright/browser 模块，保证测试与 CI
 * 不需要 Chrome、不会加载浏览器依赖。
 */
import { MOCK_MODE } from '../config.js';

/**
 * @param {{mock?: boolean}} [opts]
 * @returns {Promise<object>} 适配器实例（见 adapters/mock.js 与 adapters/real.js 的方法集）
 */
export async function createAdapters({ mock = MOCK_MODE } = {}) {
  if (mock) {
    const { createMockAdapter } = await import('./mock.js');
    return createMockAdapter();
  }
  const { createRealAdapter } = await import('./real.js');
  return createRealAdapter();
}
