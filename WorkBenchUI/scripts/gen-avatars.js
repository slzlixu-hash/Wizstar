'use strict';

/**
 * 生成 Agent 头像 SVG（纯文本，无第三方依赖）。
 *
 *   node scripts/gen-avatars.js
 *
 * 产物：renderer/assets/avatars/*.svg（160 × 160，圆形裁切由 .avatar 负责）
 * 统一构图：径向底色 + 细网格 + 外环 + 全息胸像（头 / 面罩 / 肩）+ 各自标识配件。
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.resolve(__dirname, '..', 'renderer', 'assets', 'avatars');

const AGENTS = [
  { id: 'commander', accent: '#22d3ee', accent2: '#0ea5e9', bg1: '#0e2a3d', bg2: '#050b14', body1: '#183a52', body2: '#0a1524', acc: 'headset' },
  { id: 'scout', accent: '#38bdf8', accent2: '#2563eb', bg1: '#0d2440', bg2: '#050a14', body1: '#173350', body2: '#0a1424', acc: 'scope' },
  { id: 'sourcing', accent: '#34d399', accent2: '#0d9488', bg1: '#0d2b28', bg2: '#050f10', body1: '#153a34', body2: '#0a1717', acc: 'tag' },
  { id: 'creative', accent: '#a78bfa', accent2: '#7c3aed', bg1: '#221a3d', bg2: '#0a0714', body1: '#2c2350', body2: '#120e22', acc: 'sparkle' },
  { id: 'publisher', accent: '#22c55e', accent2: '#0f9d58', bg1: '#102b1d', bg2: '#050f0a', body1: '#163a28', body2: '#0a1710', acc: 'plane' },
  { id: 'analyst', accent: '#c084fc', accent2: '#6366f1', bg1: '#25183a', bg2: '#0a0712', body1: '#302153', body2: '#140e22', acc: 'chart' },
];

function grid() {
  const lines = [];
  for (let i = 20; i < 160; i += 20) {
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="160" />`);
    lines.push(`<line x1="0" y1="${i}" x2="160" y2="${i}" />`);
  }
  return `<g stroke="#9fc4e8" stroke-width="0.6" opacity=".14">${lines.join('')}</g>`;
}

function accessory(kind, a) {
  const c = a.accent;
  switch (kind) {
    case 'headset':
      return `<g fill="none" stroke="${c}" stroke-linecap="round">
        <path d="M47 60 A35 35 0 0 1 113 60" stroke-width="2.4" opacity=".85"/>
        <rect x="41" y="58" width="9" height="16" rx="4" fill="${c}" opacity=".9" stroke="none"/>
        <rect x="110" y="58" width="9" height="16" rx="4" fill="${c}" opacity=".9" stroke="none"/>
        <path d="M114 74 q7 10 2 20" stroke-width="2.2" opacity=".7"/>
      </g>
      <circle cx="117" cy="96" r="3" fill="${c}" opacity=".95"/>
      <path d="M80 34 V23" stroke="${c}" stroke-width="2" opacity=".8"/><circle cx="80" cy="21" r="3" fill="${c}"/>`;
    case 'scope':
      return `<g fill="none" stroke="${c}" stroke-linecap="round">
        <circle cx="80" cy="58" r="40" stroke-width="1.6" stroke-dasharray="3 9" opacity=".55"/>
        <circle cx="80" cy="58" r="34" stroke-width="1" opacity=".25"/>
        <path d="M80 12 v8 M80 96 v8 M34 58 h8 M118 58 h8" stroke-width="2" opacity=".8"/>
      </g>
      <circle cx="122" cy="38" r="3.2" fill="${c}"/><circle cx="122" cy="38" r="7" fill="none" stroke="${c}" opacity=".4"/>`;
    case 'tag':
      return `<g transform="rotate(-14 116 130)" fill="none">
        <rect x="99" y="118" width="34" height="22" rx="5" stroke="${c}" stroke-width="1.8" opacity=".85" fill="rgba(52,211,153,.08)"/>
        <circle cx="106" cy="124" r="2.4" fill="${c}" opacity=".9"/>
        <path d="M112 123 h17 M112 128 h17 M112 133 h11" stroke="${c}" stroke-width="1.4" opacity=".6"/>
      </g>`;
    case 'sparkle':
      return `<g fill="${c}">
        <path d="M120 36 l2.6 6.4 6.4 2.6 -6.4 2.6 -2.6 6.4 -2.6 -6.4 -6.4 -2.6 6.4 -2.6 z" opacity=".95"/>
        <path d="M132 62 l1.8 4.4 4.4 1.8 -4.4 1.8 -1.8 4.4 -1.8 -4.4 -4.4 -1.8 4.4 -1.8 z" opacity=".7"/>
        <path d="M102 26 l1.4 3.4 3.4 1.4 -3.4 1.4 -1.4 3.4 -1.4 -3.4 -3.4 -1.4 3.4 -1.4 z" opacity=".55"/>
      </g>
      <circle cx="126" cy="128" r="10" fill="none" stroke="${c}" opacity=".5" stroke-width="1.4"/>
      <path d="M121 128 a5 5 0 0 1 10 0" fill="none" stroke="${c}" stroke-width="1.6" opacity=".8"/>`;
    case 'plane':
      return `<g fill="${c}">
        <path d="M97 131 L128 115 L119 143 L112 133 Z" opacity=".9"/>
        <path d="M112 133 L128 115" stroke="#eafff2" stroke-width="1" opacity=".6"/>
      </g>
      <path d="M100 118 h16 M96 124 h10" stroke="${c}" stroke-width="1.4" opacity=".5" stroke-linecap="round"/>`;
    case 'chart':
      return `<g>
        <rect x="98" y="132" width="6" height="14" rx="2" fill="${c}" opacity=".55"/>
        <rect x="108" y="124" width="6" height="22" rx="2" fill="${c}" opacity=".75"/>
        <rect x="118" y="114" width="6" height="32" rx="2" fill="${c}" opacity=".95"/>
        <path d="M98 128 L111 120 L122 108" fill="none" stroke="#f0e8ff" stroke-width="1.6" opacity=".8" stroke-linecap="round"/>
        <circle cx="122" cy="108" r="2.6" fill="#fff" opacity=".9"/>
      </g>`;
    default:
      return '';
  }
}

function avatar(a) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160" fill="none">
  <defs>
    <radialGradient id="bg" cx="50%" cy="24%" r="88%">
      <stop offset="0" stop-color="${a.bg1}"/>
      <stop offset="0.62" stop-color="${a.bg2}"/>
      <stop offset="1" stop-color="#04080f"/>
    </radialGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${a.body1}"/>
      <stop offset="1" stop-color="${a.body2}"/>
    </linearGradient>
    <linearGradient id="head" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#2f5f85"/>
      <stop offset="1" stop-color="#12253a"/>
    </linearGradient>
    <linearGradient id="visor" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${a.accent}" stop-opacity=".25"/>
      <stop offset="0.5" stop-color="${a.accent}" stop-opacity=".95"/>
      <stop offset="1" stop-color="${a.accent2}" stop-opacity=".35"/>
    </linearGradient>
    <radialGradient id="aura" cx="50%" cy="42%" r="50%">
      <stop offset="0" stop-color="${a.accent}" stop-opacity=".45"/>
      <stop offset="1" stop-color="${a.accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#04080f" stop-opacity="0"/>
      <stop offset="1" stop-color="#04080f" stop-opacity=".55"/>
    </linearGradient>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="4.5"/>
    </filter>
  </defs>

  <rect width="160" height="160" fill="url(#bg)"/>
  ${grid()}
  <circle cx="80" cy="72" r="58" fill="url(#aura)"/>
  <ellipse cx="80" cy="62" rx="40" ry="26" fill="${a.accent}" opacity=".22" filter="url(#glow)"/>

  <circle cx="80" cy="80" r="74" stroke="${a.accent}" stroke-opacity=".26" stroke-width="1.4"/>
  <circle cx="80" cy="80" r="66" stroke="${a.accent}" stroke-opacity=".12" stroke-width="1" stroke-dasharray="2 7"/>

  <!-- 全息胸像 -->
  <path d="M20 162 C23 121 47 103 80 103 C113 103 137 121 140 162 Z" fill="url(#body)" stroke="${a.accent}" stroke-opacity=".45"/>
  <path d="M28 158 C36 132 54 118 80 118 C106 118 124 132 132 158" stroke="${a.accent}" stroke-opacity=".32" stroke-width="1.2"/>
  <rect x="72" y="83" width="16" height="24" rx="7" fill="${a.body2}" stroke="${a.accent}" stroke-opacity=".18"/>
  <rect x="56" y="31" width="48" height="56" rx="24" fill="url(#head)" stroke="${a.accent}" stroke-opacity=".55" stroke-width="1.4"/>
  <rect x="55" y="46" width="50" height="18" rx="9" fill="url(#visor)" filter="url(#glow)" opacity=".9"/>
  <rect x="58" y="47.5" width="44" height="15" rx="7.5" fill="url(#visor)"/>
  <rect x="64" y="51" width="6" height="8" rx="2" fill="#04121c" opacity=".55"/>
  <rect x="90" y="51" width="6" height="8" rx="2" fill="#04121c" opacity=".55"/>
  <path d="M70 92 q10 5 20 0" stroke="${a.accent}" stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round"/>

  <!-- 胸甲细节 -->
  <rect x="59" y="120" width="42" height="26" rx="8" stroke="${a.accent}" stroke-opacity=".22" fill="rgba(8,16,28,.4)"/>
  <path d="M69 128 h22 M69 134 h16 M69 140 h10" stroke="${a.accent}" stroke-opacity=".28" stroke-width="1.6" stroke-linecap="round"/>

  ${accessory(a.acc, a)}

  <path d="M24 96 L44 76" stroke="#eaf6ff" stroke-opacity=".12" stroke-width="2" stroke-linecap="round"/>
  <path d="M122 110 L138 94" stroke="#eaf6ff" stroke-opacity=".08" stroke-width="2" stroke-linecap="round"/>
  <rect width="160" height="160" fill="url(#fade)"/>
</svg>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const agent of AGENTS) {
  const file = path.join(OUT_DIR, `${agent.id}.svg`);
  fs.writeFileSync(file, avatar(agent), 'utf8');
  console.log(`[gen-avatars] ${file}`);
}
