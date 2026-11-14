import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { PROFILE_DIR, HEADLESS, CHANNEL } from './config.js';

// 1688 对 navigator.webdriver / headless 指纹很敏感，用 stealth 插件抹掉常见特征
chromiumExtra.use(StealthPlugin());
const chromium = chromiumExtra;
export { chromiumExtra };

let ctxPromise = null;
let queue = Promise.resolve();

/** 所有浏览器操作串行执行：一个 profile 同时只能有一个页面在跑业务 */
export function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

export async function getContext() {
  if (!ctxPromise) {
    ctxPromise = chromium
      .launchPersistentContext(PROFILE_DIR, {
        channel: CHANNEL,
        headless: HEADLESS,
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args: ['--disable-blink-features=AutomationControlled'],
      })
      .catch((e) => {
        ctxPromise = null;
        throw new Error(
          `启动 Chrome 失败（profile=${PROFILE_DIR}）：${e.message}\n` +
            `如果 1688-cli 的 daemon 正在运行，先执行 1688 daemon stop 释放 profile 锁。`,
        );
      });
  }
  return ctxPromise;
}

export async function withPage(fn) {
  return serialize(async () => {
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  });
}

export async function closeBrowser() {
  if (!ctxPromise) return;
  const ctx = await ctxPromise.catch(() => null);
  ctxPromise = null;
  if (ctx) await ctx.close().catch(() => {});
}

/** 页面状态：ok / login / blocked */
export function pageState(page) {
  const u = page.url();
  if (/login\.1688\.com|login\.taobao\.com/.test(u)) return 'login';
  if (/\/punish|x5secdata=/.test(u)) return 'blocked';
  return 'ok';
}

export function stateError(state) {
  if (state === 'login') {
    return new Error(
      'NOT_LOGGED_IN：1688 登录态无效。调用 login 工具扫码，或先执行 1688 login。',
    );
  }
  if (state === 'blocked') {
    return new Error(
      'RISK_CONTROL：命中 1688 滑块验证（punish 页）。以 Z1688_HEADLESS=0 重启本服务，调用 login 工具打开窗口手动拖一次滑块，之后几小时内有效。',
    );
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
