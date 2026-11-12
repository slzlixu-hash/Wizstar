'use strict';

/**
 * 登录页交互（纯界面阶段）：
 *  - 文案 / 版本 / 端口从 WB.data.app 读取，不在页面里硬编码业务数据
 *  - 标题栏：最小化 / 关闭走 preload 注入的 window.workbench
 *  - 表单：空值红边 + 抖动 + toast；回车提交；眼睛切换密码可见；记住账号
 *  - 登录调用 window.workbench.login()，非 Electron 环境给出提示且不抛错
 */
(function () {
  const WB = window.WB || {};
  const app = (WB.data && WB.data.app) || {};
  const bridge = window.workbench || null;

  const $ = (id) => document.getElementById(id);

  function toast(message, tone) {
    if (WB.ui && typeof WB.ui.toast === 'function') WB.ui.toast(message, tone || 'info');
  }

  /* ------------------------------ 文案填充 ------------------------------ */
  const copy = {
    'login-product': app.product,
    'login-platform': app.platform,
    'login-tagline': app.tagline,
  };
  Object.keys(copy).forEach((id) => {
    const el = $(id);
    if (el && copy[id]) el.textContent = copy[id];
  });

  const versionEl = $('login-version');
  if (versionEl && app.version) versionEl.textContent = app.version;

  const endpointEl = $('login-endpoint');
  if (endpointEl && app.endpoint) endpointEl.textContent = '(' + app.endpoint + ')';

  if (app.product) document.title = app.product + ' · 登录';

  /* ------------------------------ 标题栏窗口操作 ------------------------------ */
  function callBridge(action, failMessage) {
    if (bridge && typeof bridge[action] === 'function') {
      try {
        bridge[action]();
        return true;
      } catch (err) {
        /* 纯界面阶段：忽略桥接异常，退化为提示，不产生 console.error */
      }
    }
    toast(failMessage, 'warn');
    return false;
  }

  const minBtn = $('login-win-min');
  const closeBtn = $('login-win-close');
  if (minBtn) minBtn.addEventListener('click', () => callBridge('minimize', '该操作需要在 Electron 桌面端中运行'));
  if (closeBtn) closeBtn.addEventListener('click', () => callBridge('close', '该操作需要在 Electron 桌面端中运行'));

  /* ------------------------------ 登录表单 ------------------------------ */
  const form = $('login-form');
  const accountInput = $('login-username');
  const passwordInput = $('login-password');
  const submitBtn = $('login-submit');
  const submitLabel = submitBtn ? submitBtn.querySelector('.login-submit-label') : null;
  const eyeBtn = $('login-eye');

  const fields = {
    account: $('login-field-user'),
    password: $('login-field-password'),
  };

  let submitting = false;

  function clearError(key) {
    const field = fields[key];
    if (field) field.classList.remove('is-invalid', 'is-shake');
  }

  function raiseError(key) {
    const field = fields[key];
    if (!field) return;
    field.classList.remove('is-shake');
    field.classList.add('is-invalid');
    /* 强制回流，让重复提交时抖动动画可以重放 */
    void field.offsetWidth;
    field.classList.add('is-shake');
  }

  Object.keys(fields).forEach((key) => {
    const field = fields[key];
    if (!field) return;
    field.addEventListener('animationend', () => field.classList.remove('is-shake'));
  });

  if (accountInput) accountInput.addEventListener('input', () => clearError('account'));
  if (passwordInput) passwordInput.addEventListener('input', () => clearError('password'));

  function setLoading(loading) {
    if (!submitBtn) return;
    submitBtn.classList.toggle('is-loading', loading);
    submitBtn.disabled = loading;
    if (submitLabel) submitLabel.textContent = loading ? '正在登录…' : '立即登录';
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (submitting) return;

      const account = accountInput ? accountInput.value.trim() : '';
      const password = passwordInput ? passwordInput.value : '';

      if (!account) {
        raiseError('account');
        if (accountInput) accountInput.focus();
        toast('请输入账号或手机号', 'warn');
        return;
      }
      if (!password) {
        raiseError('password');
        if (passwordInput) passwordInput.focus();
        toast('请输入登录密码', 'warn');
        return;
      }

      if (!bridge || typeof bridge.login !== 'function') {
        toast('本地服务未就绪：请在 Electron 桌面端中运行', 'error');
        return;
      }

      submitting = true;
      setLoading(true);
      window.setTimeout(() => {
        try {
          bridge.login();
        } catch (err) {
          submitting = false;
          setLoading(false);
          toast('登录请求失败，请稍后重试', 'error');
        }
      }, 260);
    });
  }

  /* ------------------------------ 密码可见切换 ------------------------------ */
  if (eyeBtn && passwordInput) {
    eyeBtn.addEventListener('click', () => {
      const visible = passwordInput.type === 'password';
      passwordInput.type = visible ? 'text' : 'password';
      eyeBtn.classList.toggle('is-visible', visible);
      const label = visible ? '隐藏密码' : '显示密码';
      eyeBtn.title = label;
      eyeBtn.setAttribute('aria-label', label);
      passwordInput.focus();
    });
  }
})();
