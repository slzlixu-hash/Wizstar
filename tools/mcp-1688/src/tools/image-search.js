import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withPage, pageState, stateError } from '../browser.js';
import { createOfferCapture } from '../capture.js';
import { T } from '../config.js';

const UPLOAD_PAGE = 'https://s.1688.com/youyuan/index.htm';

const UPLOAD_SELECTORS = [
  '.image-upload-button-container',
  '[class*="image-upload"]',
  'input[type=file]',
];

const SUBMIT_SELECTORS = ['button:has-text("搜索图片")', 'text=搜索图片'];

async function clickAny(page, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    try {
      if (await el.count()) {
        await el.click({ timeout: 4000 });
        return sel;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function resolveImage(image) {
  if (/^https?:\/\//i.test(image)) {
    const res = await fetch(image);
    if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (image.match(/\.(jpe?g|png|webp|bmp)(\?|#|$)/i)?.[1] || 'jpg').toLowerCase();
    const tmp = path.join(os.tmpdir(), `z1688-${Date.now()}.${ext === 'jpeg' ? 'jpg' : ext}`);
    await fs.writeFile(tmp, buf);
    return tmp;
  }
  const abs = path.resolve(image);
  await fs.access(abs);
  return abs;
}

/**
 * 以图搜款。
 *
 * 关键差异（也是 1688-cli 0.1.47 的 bug 所在）：
 * CLI 上传拿到 imageId 后，会另开页面访问 offer_search.htm?imageId=xxx ——
 * 这个 URL 1688 并不认，于是返回通用推荐流。
 * 这里的做法是：在上传页里直接完成“搜索图片”并就地抓 mtop 响应，
 * 只有页面自己没出结果时才回退到 imageId URL。
 */
export async function searchByImage({ image, max = 20 }) {
  const local = await resolveImage(image);

  return withPage(async (page) => {
    const cap = createOfferCapture(page);
    page.on('filechooser', (chooser) => chooser.setFiles(local).catch(() => {}));
    try {
      await page.goto(UPLOAD_PAGE, { waitUntil: 'domcontentloaded', timeout: T.nav });
      const bad = stateError(pageState(page));
      if (bad) throw bad;

      await clickAny(page, UPLOAD_SELECTORS);
      // 选择文件后，页面通常会自己跳转到 imageId=... 的结果页
      await page.waitForURL(/imageId=\d+/, { timeout: T.upload }).catch(() => {});

      // 有的版本停在预览态，需要点一下“搜索图片”
      await clickAny(page, SUBMIT_SELECTORS);
      await page.waitForURL(/imageId=\d+/, { timeout: T.upload }).catch(() => {});

      const imageId = page.url().match(/imageId=(\d+)/)?.[1] ?? null;
      let offers = await cap.wait(T.capture);

      // 回退：上传页没触发搜索，就直接开结果页（等价于 CLI 的行为，可能拿到推荐流）
      if (!offers.length && imageId) {
        await page.goto(`https://s.1688.com/selloffer/offer_search.htm?imageId=${imageId}`, {
          waitUntil: 'domcontentloaded',
          timeout: T.nav,
        });
        offers = await cap.wait(T.capture);
      }

      return {
        image,
        imageId,
        resultUrl: page.url(),
        total: offers.length,
        offers: offers.slice(0, max),
      };
    } finally {
      cap.dispose();
    }
  });
}
