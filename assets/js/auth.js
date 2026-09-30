(function () {
  'use strict';
  var login = document.getElementById('zhihu-login');
  var account = document.getElementById('zhihu-account');
  var logout = document.getElementById('zhihu-logout');
  var dialog = document.getElementById('zhihu-auth-dialog');
  var status = document.getElementById('zhihu-auth-status');
  var user = null;
  var configured = false;
  var errors = { state_invalid: '此次登录验证未通过，请重新登录。', denied: '你已取消知乎授权，可以继续浏览展馆。', code_missing: '未收到授权结果，请重新登录。', provider_failed: '暂时无法完成知乎登录，请稍后重试。' };
  function message(text) { status.textContent = text; }
  function render(data) {
    configured = Boolean(data.configured);
    user = data.authenticated ? data.user : null;
    login.hidden = Boolean(user);
    account.hidden = !user;
    logout.hidden = !user;
    account.textContent = user ? user.name : '';
    document.getElementById('zhihu-auth-title').textContent = user ? '知乎账号' : '使用知乎登录';
    document.getElementById('zhihu-auth-intro').hidden = Boolean(user);
    document.getElementById('zhihu-authorize').hidden = Boolean(user);
    var profile = document.getElementById('zhihu-profile');
    profile.hidden = !user;
    if (user) {
      document.getElementById('zhihu-name').textContent = user.name;
      document.getElementById('zhihu-headline').textContent = user.headline;
      document.getElementById('zhihu-contact').textContent = [user.email, user.phone].filter(Boolean).join(' · ');
      var avatar = document.getElementById('zhihu-avatar');
      avatar.hidden = !user.avatar;
      if (user.avatar) avatar.src = user.avatar; else avatar.removeAttribute('src');
    }
    window.dispatchEvent(new CustomEvent('museum:auth', { detail: { user: user } }));
  }
  async function session() {
    try {
      var response = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error();
      render(await response.json());
    } catch { configured = false; }
    return user;
  }
  window.MuseumAuth = {
    getUser: function () { return user; },
    refresh: session,
    login: function () { message(''); dialog.showModal(); }
  };
  login.addEventListener('click', function () { message(''); dialog.showModal(); });
  account.addEventListener('click', function () { message(''); dialog.showModal(); });
  document.getElementById('zhihu-auth-close').addEventListener('click', function () { dialog.close(); });
  document.getElementById('zhihu-authorize').addEventListener('click', async function () {
    var button = this;
    button.disabled = true;
    message('正在连接知乎…');
    try {
      await session();
      if (!configured) { message('知乎登录暂未开放，你可以继续浏览全部展馆。'); return; }
      var response = await fetch('/api/auth/zhihu/start', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo: '/' + location.hash }) });
      if (!response.ok) throw new Error();
      var data = await response.json();
      var url = new URL(data.authorizationUrl);
      if (url.origin !== 'https://openapi.zhihu.com' || url.pathname !== '/authorize') throw new Error();
      location.assign(url.href);
    } catch { message('暂时无法连接知乎，请稍后重试。'); }
    finally { button.disabled = false; }
  });
  logout.addEventListener('click', async function () {
    logout.disabled = true;
    try {
      var response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error();
      render({ configured: true, authenticated: false });
      message('已退出本网站，你可以继续浏览展馆。');
    } catch { message('退出失败，请稍后重试。'); }
    finally { logout.disabled = false; }
  });
  var params = new URLSearchParams(location.search);
  if (params.has('auth_error')) {
    message(errors[params.get('auth_error')] || '登录未完成，请重试。');
    history.replaceState(null, '', location.pathname + location.hash);
    dialog.showModal();
  }
  session();
  window.addEventListener('pageshow', function (event) { if (event.persisted) session(); });
})();
