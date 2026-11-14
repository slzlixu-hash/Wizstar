'use strict';

/**
 * 真实上游适配器：复用现有的 Playwright + mtop 抓取实现（src/tools/*.js）。
 *
 * 说明：1688 没有给第三方开放「下单」API，浏览器自动化也只能读。
 * 因此写类工具落到本地草稿库（真实副作用，幂等账本保护）；
 * 下单（irreversible）在没有配置采购网关时按 43010 业务拒绝处理，绝不假装成功。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { searchProducts } from '../tools/search.js';
import { searchByImage } from '../tools/image-search.js';
import { getOffer } from '../tools/offer.js';
import { login } from '../tools/login.js';
import { DATA_DIR } from '../config.js';
import { ContractError, ERROR_CODES } from '../core/errors.js';

const DRAFT_DIR = path.join(DATA_DIR, 'drafts');

function draftIdOf(shopKey, operationId) {
  return `draft-${crypto.createHash('sha256').update(`${shopKey}|${operationId}`).digest('hex').slice(0, 12)}`;
}

function safeDirName(shopKey) {
  return String(shopKey || 'anonymous').replace(/[^A-Za-z0-9_.-]/g, '_');
}

const LABEL_PLATFORMS = [
  ['抖音', 'label_douyin'],
  ['快手', 'label_kuaishou'],
  ['微信小店', 'label_wechat_shop'],
  ['淘宝', 'label_taobao'],
  ['拼多多', 'label_pinduoduo'],
  ['小红书', 'label_xiaohongshu'],
  ['京东', 'label_jd'],
];

/**
 * 把 1688 商品/供应商数据映射成筛选候选。
 * 注意：揽收率、退款率、综合体验分属于店铺服务分，商品列表不返回，这里保持 null，
 * 由 filter_suppliers 按「指标缺失」处理（默认淘汰，不静默放行）。
 */
function toSupplierCandidate(offer) {
  const texts = [...(offer.tags || []), ...(offer.serviceTags || []), ...(offer.guarantees || [])].map(String);
  const joined = texts.join(' ');
  const shipHours = /当天发货/.test(joined) ? 12 : /24小时发货/.test(joined) ? 24 : /48小时发货/.test(joined) ? 48 : null;

  const guarantees = new Set();
  if (/7天/.test(joined)) guarantees.add('7day_return');
  if (offer.verified?.business) guarantees.add('strength_merchant');
  if (offer.verified?.factory || offer.verified?.superFactory) guarantees.add('certified_factory');

  const valueAdded = new Set();
  if (/一件代发/.test(joined)) valueAdded.add('dropship');
  if (/一件代发.*包邮|包邮.*一件代发/.test(joined)) valueAdded.add('dropship_free_shipping');
  if (/免费赊账/.test(joined)) valueAdded.add('free_credit');
  for (const [label, key] of LABEL_PLATFORMS) {
    if (new RegExp(`${label}.*密文`).test(joined)) valueAdded.add(key);
  }

  return {
    offerId: String(offer.offerId),
    title: offer.title,
    price: offer.price,
    moq: offer.moq ?? null,
    supplier: offer.supplier,
    location: offer.location,
    metrics: {
      shipHours,
      collectionRate24h: null,
      collectionRate48h: null,
      qualityRefundRate: null,
      totalRefundRate: null,
      experienceScore: null,
      guarantees: [...guarantees],
      valueAdded: [...valueAdded],
    },
  };
}

export function createRealAdapter() {
  const calls = {
    searchOffers: 0,
    searchByImage: 0,
    getOffer: 0,
    getSkuModel: 0,
    getSupplierProfile: 0,
    listSupplierCandidates: 0,
    saveDraft: 0,
    submitOrder: 0,
    login: 0,
  };

  return {
    mode: 'real',
    calls,
    stats: () => ({ ...calls }),
    reset() {
      for (const k of Object.keys(calls)) calls[k] = 0;
    },

    async searchOffers({ query, max, sort }) {
      calls.searchOffers += 1;
      const r = await searchProducts({ query, max, sort });
      return { query: r.query, sort: r.sort, url: r.url, total: r.total, offers: r.offers };
    },

    async searchByImage({ image, max }) {
      calls.searchByImage += 1;
      const r = await searchByImage({ image, max });
      return { image: r.image, imageId: r.imageId, resultUrl: r.resultUrl, total: r.total, offers: r.offers };
    },

    async getOffer({ offerId }) {
      calls.getOffer += 1;
      const r = await getOffer({ offerId });
      return {
        offerId: String(offerId),
        title: r.title,
        price: r.price,
        supplier: { name: r.supplier, shopUrl: null, years: null },
        location: { province: null, city: null },
        sku: r.sku,
        url: r.url,
      };
    },

    async getSkuModel({ offerId }) {
      calls.getSkuModel += 1;
      const r = await getOffer({ offerId });
      return { offerId: String(offerId), ...(r.sku || {}) };
    },

    async getSupplierProfile({ offerId }) {
      calls.getSupplierProfile += 1;
      const r = await getOffer({ offerId });
      return {
        offerId: String(offerId),
        title: r.title,
        price: r.price,
        supplier: { name: r.supplier },
        skuProps: r.sku?.props ?? [],
        skuCount: r.sku?.skuCount ?? 0,
      };
    },

    /** 筛选候选池：按 offerIds 或关键词抓取候选，尽量派生服务指标（缺失项保持 null） */
    async listSupplierCandidates({ keywords, offerIds, limit } = {}) {
      calls.listSupplierCandidates += 1;
      const cap = Math.min(limit ?? 20, 20);
      if (Array.isArray(offerIds) && offerIds.length) {
        const offers = [];
        for (const offerId of offerIds.slice(0, cap)) {
          calls.getOffer += 1;
          const r = await getOffer({ offerId });
          offers.push({
            offerId: String(offerId),
            title: r.title,
            price: r.price,
            moq: r.moq ?? null,
            supplier: { name: r.supplier },
            location: r.location ?? null,
            tags: r.tags ?? [],
            serviceTags: r.serviceTags ?? [],
            verified: r.verified ?? null,
          });
        }
        return offers.map(toSupplierCandidate);
      }
      const r = await searchProducts({ query: keywords ?? '', max: cap });
      const offers = (r.offers || []).slice(0, cap);
      return offers.map(toSupplierCandidate);
    },

    async saveDraft({ shopKey, operationId, offerId, quantity, targetPriceCents, note }) {
      calls.saveDraft += 1;
      const draftId = draftIdOf(shopKey, operationId);
      const dir = path.join(DRAFT_DIR, safeDirName(shopKey));
      await fsp.mkdir(dir, { recursive: true });
      const draft = {
        draftId,
        shopKey,
        operationId,
        offerId: String(offerId),
        quantity: quantity ?? 1,
        targetPriceCents: targetPriceCents ?? null,
        note: note ?? null,
        status: 'DRAFT',
        savedAt: new Date().toISOString(),
      };
      await fsp.writeFile(path.join(dir, `${draftId}.json`), JSON.stringify(draft, null, 2), 'utf8');
      return draft;
    },

    async submitOrder({ shopKey, operationId, offerId, quantity, priceCents, confirm }) {
      calls.submitOrder += 1;
      if (confirm !== true) {
        throw new ContractError(ERROR_CODES.BUSINESS_REJECTED, '未确认提交：irreversible 操作必须显式传 confirm=true');
      }
      const gateway = process.env.Z1688_ORDER_GATEWAY;
      if (!gateway) {
        throw new ContractError(
          ERROR_CODES.BUSINESS_REJECTED,
          '1688 采购下单网关未配置（Z1688_ORDER_GATEWAY）：当前服务只提供询价与草稿，正式下单需接入平台采购通道',
          { retryable: false, data: { offerId: String(offerId), shopKey, requiredEnv: 'Z1688_ORDER_GATEWAY' } },
        );
      }
      throw new ContractError(
        ERROR_CODES.BUSINESS_REJECTED,
        `下单网关 ${gateway} 尚未实现适配：请在 tools/1688-mcp/src/adapters/real.js 中接入真实采购接口`,
      );
    },

    async login({ timeoutSec }) {
      calls.login += 1;
      return login({ timeoutSec });
    },
  };
}
