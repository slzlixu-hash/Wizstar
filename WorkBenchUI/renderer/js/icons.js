'use strict';

/**
 * 内联图标库（24×24 线性图标，继承 currentColor）。
 * 用法：WB.icon('settings', 18, 'extra-class')
 */
(function () {
  const WB = (window.WB = window.WB || {});

  const PATHS = {
    home: '<path d="M3 10.6 12 3l9 7.6"/><path d="M5.6 9.4V21h12.8V9.4"/><path d="M10 21v-6h4v6"/>',
    box: '<path d="m12 3 8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z"/><path d="m4.4 7.7 7.6 4.2 7.6-4.2"/><path d="M12 12v8.6"/>',
    clipboard:
      '<rect x="5" y="4.5" width="14" height="16.5" rx="2.4"/><path d="M9 4.5V3.4c0-.8.6-1.4 1.4-1.4h3.2c.8 0 1.4.6 1.4 1.4v1.1"/><path d="M9 10h6M9 13.6h6M9 17.2h4"/>',
    shop: '<path d="M4 9.2V20h16V9.2"/><path d="M3.2 9.2 5 4h14l1.8 5.2a3 3 0 0 1-5.6 1.7 3 3 0 0 1-5.2 0 3 3 0 0 1-5.2 0 3 3 0 0 1-1.6-1.7Z"/><path d="M9.2 20v-5.4h5.6V20"/>',
    robot:
      '<rect x="4.5" y="7.5" width="15" height="12" rx="3.2"/><path d="M12 3.2v4.3"/><circle cx="12" cy="2.6" r="1.1"/><circle cx="9.2" cy="13.2" r="1.2"/><circle cx="14.8" cy="13.2" r="1.2"/><path d="M9.6 16.6h4.8"/><path d="M2.6 12.2v3M21.4 12.2v3"/>',
    plugin:
      '<path d="M9.4 3.8v3.4M14.6 3.8v3.4"/><path d="M6 7.2h12v5.4a6 6 0 0 1-12 0V7.2Z"/><path d="M12 18.6V21"/>',
    settings:
      '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.2v2.5M12 18.3v2.5M3.2 12h2.5M18.3 12h2.5M5.8 5.8l1.8 1.8M16.4 16.4l1.8 1.8M18.2 5.8l-1.8 1.8M7.6 16.4l-1.8 1.8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    maximize: '<rect x="4.5" y="4.5" width="15" height="15" rx="1.4"/>',
    restore: '<rect x="4" y="7" width="12" height="12" rx="1.2"/><path d="M8 7V4.8h11.2V16H17"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.2 4.2"/>',
    filter: '<path d="M4 5.5h16l-6.2 7.3V19l-3.6 1.6v-7.8L4 5.5Z"/>',
    bell: '<path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15L18 15.5Z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
    'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
    'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
    'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
    'arrow-right': '<path d="M4 12h15"/><path d="m13.5 6.5 5.5 5.5-5.5 5.5"/>',
    'arrow-up-right': '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
    check: '<path d="m5 12.5 4.2 4.2L19 6.8"/>',
    eye: '<path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.9"/>',
    'eye-off':
      '<path d="M4 4.5 20 20"/><path d="M9.8 5.9A9.6 9.6 0 0 1 12 5.8c6 0 9.2 6.2 9.2 6.2a17 17 0 0 1-3.1 3.9"/><path d="M6.3 7.6A16.7 16.7 0 0 0 2.8 12S6 18.2 12 18.2a10 10 0 0 0 4.4-1"/><path d="M10 10a2.9 2.9 0 0 0 4 4"/>',
    pencil: '<path d="M4.5 19.5h4L20 8l-4-4L4.5 15.5v4Z"/><path d="m14.8 5.2 4 4"/>',
    key: '<circle cx="8.2" cy="15.8" r="3.9"/><path d="m11 13 8.2-8.2M17 5l2.4 2.4M14.6 7.4l2.4 2.4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-.7 4.6"/><path d="M20 4.5V11h-6.4"/>',
    shield: '<path d="M12 3 5 6v5.4c0 4.3 2.9 7.6 7 9.6 4.1-2 7-5.3 7-9.6V6l-7-3Z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
    lock: '<rect x="4.8" y="10.4" width="14.4" height="10.2" rx="2.4"/><path d="M8.2 10.4V8a3.8 3.8 0 0 1 7.6 0v2.4"/><path d="M12 14.6v2.4"/>',
    user: '<circle cx="12" cy="8.4" r="3.8"/><path d="M4.8 20.2c.7-3.6 3.7-5.8 7.2-5.8s6.5 2.2 7.2 5.8"/>',
    play: '<path d="M8 5.4v13.2L19 12 8 5.4Z"/>',
    power: '<path d="M12 3.2v8.4"/><path d="M6.6 6.2a8 8 0 1 0 10.8 0"/>',
    terminal: '<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.4"/><path d="m7.4 9.6 3 2.4-3 2.4"/><path d="M12.4 14.4h4.2"/>',
    wifi: '<path d="M3.5 8.6a13.4 13.4 0 0 1 17 0"/><path d="M6.5 12.2a9 9 0 0 1 11 0"/><path d="M9.5 15.8a4.6 4.6 0 0 1 5 0"/><circle cx="12" cy="19.2" r="1.2" fill="currentColor" stroke="none"/>',
    link: '<path d="M10 14a4.4 4.4 0 0 0 6.2 0l2.7-2.7a4.4 4.4 0 0 0-6.2-6.2l-1.5 1.5"/><path d="M14 10a4.4 4.4 0 0 0-6.2 0l-2.7 2.7a4.4 4.4 0 0 0 6.2 6.2l1.5-1.5"/>',
    alert: '<path d="M12 4.2 21 19.6H3L12 4.2Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17.1" r=".9" fill="currentColor" stroke="none"/>',
    trash: '<path d="M4.6 7h14.8"/><path d="M9.2 7V4.8h5.6V7"/><path d="m6.6 7 1 13h8.8l1-13"/><path d="M10.2 10.6v6M13.8 10.6v6"/>',
    memory:
      '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.2"/><path d="M9.6 9.8h4.8v4.8H9.6z"/><path d="M9.6 3.4v3M14.4 3.4v3M9.6 17.6v3M14.4 17.6v3M3.4 9.6h3M3.4 14.4h3M17.6 9.6h3M17.6 14.4h3"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.6" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.6" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
    chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8.2 16.4V11M12.4 16.4V7.4M16.6 16.4v-3.6"/>',
    image: '<rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2.4"/><circle cx="8.8" cy="9.8" r="1.6"/><path d="m4.4 16.6 4.6-4.4 3.4 3.2 3-2.8 4.2 4"/>',
    tag: '<path d="m12.4 3.6 8 8-8.8 8.8-8-8V3.6h8.8Z"/><circle cx="8.4" cy="8.4" r="1.5"/>',
    cart: '<circle cx="9.4" cy="19" r="1.5"/><circle cx="17.4" cy="19" r="1.5"/><path d="M3.4 4h2.4l2.4 11.4h10.2L20.6 7H6.4"/>',
    truck: '<path d="M3.4 6.4h10.4v9.8H3.4z"/><path d="M13.8 9.6h3.6l3 3.4v3.2h-6.6"/><circle cx="7" cy="18.2" r="1.6"/><circle cx="17.2" cy="18.2" r="1.6"/>',
    server: '<rect x="3.6" y="4" width="16.8" height="7" rx="1.8"/><rect x="3.6" y="13" width="16.8" height="7" rx="1.8"/><path d="M7.2 7.5h.02M7.2 16.5h.02" stroke-width="2.4"/>',
    globe: '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6a13.4 13.4 0 0 1 0 16.8 13.4 13.4 0 0 1 0-16.8Z"/>',
    database: '<ellipse cx="12" cy="6.4" rx="7.6" ry="3"/><path d="M4.4 6.4v11.2c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3V6.4"/><path d="M4.4 12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3"/>',
    sparkles: '<path d="m12 3.4 1.8 4.8 4.8 1.8-4.8 1.8L12 16.6l-1.8-4.8-4.8-1.8 4.8-1.8L12 3.4Z"/><path d="m18.6 15.4.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z"/>',
    clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7v5.4l3.4 2"/>',
    more: '<circle cx="5.4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
    'more-vertical': '<circle cx="12" cy="5.4" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.6" r="1.3" fill="currentColor" stroke="none"/>',
    'play-circle': '<circle cx="12" cy="12" r="8.4"/><path d="m10 8.6 5.4 3.4-5.4 3.4V8.6Z"/>',
    copy: '<rect x="8.6" y="8.6" width="11" height="11" rx="2"/><path d="M15.4 8.6V6.2a1.8 1.8 0 0 0-1.8-1.8H6.2a1.8 1.8 0 0 0-1.8 1.8v7.4a1.8 1.8 0 0 0 1.8 1.8h2.4"/>',
    zap: '<path d="M13.4 3 5 13.6h5.6L10.6 21 19 10.4h-5.6L13.4 3Z"/>',
    layers: '<path d="m12 3.6 8.6 4.6L12 12.8 3.4 8.2 12 3.6Z"/><path d="m3.4 12.5 8.6 4.6 8.6-4.6"/><path d="m3.4 16.6 8.6 4.6 8.6-4.6"/>',
    target: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
    download: '<path d="M12 4v11"/><path d="m7 10.6 5 5 5-5"/><path d="M4.6 19.4h14.8"/>',
    upload: '<path d="M12 20V9"/><path d="m7 13.4 5-5 5 5"/><path d="M4.6 4.6h14.8"/>',
    'log-out': '<path d="M14 5.2H19v13.6h-5"/><path d="M10 8.4 6 12l4 3.6"/><path d="M6 12h8"/>',
    info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.4v3.6M14 3.4v3.6M10 17v3.6M14 17v3.6M3.4 10h3.6M3.4 14h3.6M17 10h3.6M17 14h3.6"/>',
    wand: '<path d="m4 20 9.4-9.4"/><path d="m14.6 4.4.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z"/><path d="m19.6 12.4.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z"/>',
    route: '<circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.4 6h5.2a3 3 0 0 1 0 6h-3.2a3 3 0 0 0 0 6h5.2"/>',
    inbox: '<path d="M4 13.6V20h16v-6.4"/><path d="M4 13.6 6.6 4h10.8L20 13.6h-4.4l-1.4 2.8h-4.4l-1.4-2.8H4Z"/>',
    command: '<path d="M9 6.4a2.4 2.4 0 1 0-2.4 2.4H9V6.4Zm0 0V17.6M9 6.4h6M15 6.4a2.4 2.4 0 1 1 2.4 2.4H15V6.4Zm0 0V17.6M9 17.6h6M9 17.6a2.4 2.4 0 1 1-2.4-2.4H9v2.4Zm6 0a2.4 2.4 0 1 0 2.4-2.4H15v2.4Z"/>',
  };

  /**
   * @param {string} name 图标名
   * @param {number} [size=18]
   * @param {string} [cls='']
   * @param {number} [stroke=1.7]
   * @returns {string} 内联 SVG 字符串
   */
  WB.icon = function icon(name, size = 18, cls = '', stroke = 1.7) {
    const body = PATHS[name];
    if (!body) return '';
    return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };

  WB.iconNames = Object.keys(PATHS);

  /** 品牌 Logo（填充图形，非描边）。 */
  WB.brandLogo = function brandLogo(size = 20, cls = '') {
    return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity=".55"/>
      <path d="M7.4 9.2 12 6.6l4.6 2.6v5.2L12 17l-4.6-2.6V9.2Z" fill="currentColor" opacity=".9"/>
      <path d="M12 10.4v6.2" stroke="#04121c" stroke-width="1.2" stroke-linecap="round" opacity=".55"/>
    </svg>`;
  };
})();
