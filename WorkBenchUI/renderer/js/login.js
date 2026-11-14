'use strict';

/**
 * 登录页交互（真实鉴权）：
 *  - 文案 / 版本 / 端口从 WB.data.app 读取，不在页面里硬编码业务数据
 *  - 标题栏：最小化 / 关闭走 preload 注入的 window.workbench
 *  - 表单：空值红边 + 抖动 + toast；回车提交；眼睛切换密码可见；记住账号和密码
 *  - 提交调用 window.workbench.login(username, password, remember) → 主进程请求 /api/auth/login，
 *    成功才切主窗口；失败把服务端文案（账号或密码错误 / 账号已停用）原样提示
 *  - 「记住账号和密码」由主进程用 safeStorage 加密落盘，本页只负责读取预填
 */
(function () {
  const WB = window.WB || {};
  const app = (WB.data && WB.data.app) || {};
  const bridge = window.workbench || null;
  const LEGACY_REMEMBER_KEY = 'wizstar.login.username';

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
  const rememberInput = $('login-remember-input');

  /* 记住账号和密码：凭据由主进程 safeStorage 加密保存，这里只负责预填。
     旧版本只记账号（localStorage），顺手清掉避免残留。 */
  try {
    window.localStorage.removeItem(LEGACY_REMEMBER_KEY);
  } catch (_) {
    /* file:// 下 localStorage 不可用时忽略 */
  }

  if (bridge && typeof bridge.getRemembered === 'function') {
    Promise.resolve()
      .then(() => bridge.getRemembered())
      .then((cred) => {
        if (!cred || !cred.ok) return;
        if (accountInput) accountInput.value = cred.username || '';
        if (passwordInput) passwordInput.value = cred.password || '';
        if (rememberInput) rememberInput.checked = true;
        // 账号密码都已预填：焦点给登录按钮，回车直接提交
        if (submitBtn) submitBtn.focus();
      })
      .catch(() => {
        /* 读取失败按「未记住」处理 */
      });
  }

  /* 会话过期 / 被动退出提示（由主进程推来） */
  if (bridge && typeof bridge.onAuthNotice === 'function') {
    bridge.onAuthNotice(function (message) {
      if (message) toast(message, 'info');
    });
  }

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
      const remember = !!(rememberInput && rememberInput.checked);

      Promise.resolve()
        .then(() => bridge.login(account, password, remember))
        .then((res) => {
          if (res && res.ok) {
            // 主进程即将切到主窗口，当前页面销毁，保持 loading 态即可
            return;
          }
          submitting = false;
          setLoading(false);
          raiseError('password');
          if (passwordInput) passwordInput.select();
          toast((res && res.error) || '账号或密码错误', 'error');
        })
        .catch(() => {
          submitting = false;
          setLoading(false);
          toast('登录请求失败，请稍后重试', 'error');
        });
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
