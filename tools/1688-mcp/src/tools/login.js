import { chromiumExtra as chromium, sleep } from '../browser.js';
import { PROFILE_DIR, CHANNEL } from '../config.js';

const YOUYUAN = 'https://s.1688.com/youyuan/index.htm';

/**
 * 打开有头浏览器：先扫码登录，再顺便访问以图搜货页。
 * 如果 1688 弹滑块（punish 页），用户可以在这个窗口里直接拖过去 ——
 * 这一步做完，后续 search_by_image 才能正常跑。
 */
export async function login({ timeoutSec = 300 } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: CHANNEL,
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    await page.goto('https://login.1688.com/member/signin.htm', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    const deadline = Date.now() + timeoutSec * 1000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (page.isClosed()) return { ok: false, reason: '窗口被关闭' };
      if (!/login\.(1688|taobao)\.com/.test(page.url())) {
        loggedIn = true;
        break;
      }
    }
    if (!loggedIn) return { ok: false, reason: `等待超时（${timeoutSec}s），未检测到登录` };

    // 登录完成后再去以图搜货页，给用户机会把滑块拖掉
    await page.goto(YOUYUAN, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    const challengeDeadline = Date.now() + 90_000;
    let cleared = false;
    while (Date.now() < challengeDeadline) {
      if (page.isClosed()) break;
      if (!/punish|x5secdata=/.test(page.url())) {
        cleared = true;
        break;
      }
      await sleep(2000);
    }

    return {
      ok: true,
      loggedIn,
      imageSearchReady: cleared,
      url: page.url().slice(0, 200),
      hint: cleared
        ? '登录完成，以图搜货页可直接使用'
        : '登录完成，但以图搜货页仍在滑块验证中：在刚打开的窗口里拖一下滑块即可',
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}
