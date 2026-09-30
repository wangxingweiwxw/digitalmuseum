(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var catalog = {};
  window.MUSEUM_PACK.museums.forEach(function (m) {
    m.nodes.forEach(function (n) { catalog[n.id] = { node: n, museum: m }; });
  });
  var user = window.MuseumAuth.getUser();
  var epoch = 0, pageRequest = 0, listRequest = 0, noteRequest = 0;
  var current = null, currentItem = null, items = [], filter = 'favorites';
  var editing = null, savedText = '', version = 0, saving = false;
  var listDialog = $('library-dialog'), noteDialog = $('note-dialog');
  var text = $('note-text');

  async function api(path, patch) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch('/api/library' + path, {
        method: patch ? 'PATCH' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Museum-User': user ? encodeURIComponent(String(user.id)) : '' }, body: patch ? JSON.stringify(patch) : undefined
      });
      if (!response.ok) {
        var error = new Error('request'); error.status = response.status;
        var detail = await response.json().catch(function () { return {}; }); error.code = detail.error;
        if (error.code === 'account_changed') await window.MuseumAuth.refresh();
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  function errorMessage(error) {
    if (error.code === 'account_changed') return '登录账号已变化，请重新打开收藏或笔记。';
    if (error.status === 401) return '登录已过期，请重新登录；未保存的笔记请先复制留存。';
    if (error.status === 409) return '笔记已在另一处更新。你的文字仍在，请先复制，再重新载入已保存笔记。';
    return '暂时无法同步，请稍后重试。未保存的文字会留在当前编辑框中。';
  }
  async function requireLogin() {
    await window.MuseumAuth.refresh();
    if (window.MuseumAuth.getUser()) return true;
    window.MuseumAuth.login();
    return false;
  }
  function renderTools() {
    var favorite = Boolean(currentItem && currentItem.favorite);
    $('exhibit-favorite').textContent = favorite ? '★ 已收藏' : '☆ 收藏展品';
    $('exhibit-favorite').setAttribute('aria-pressed', String(favorite));
    $('exhibit-note').textContent = currentItem && currentItem.note ? '编辑私人笔记' : '写私人笔记';
  }
  async function refreshCurrent() {
    var id = current, serial = ++pageRequest, identity = epoch;
    currentItem = null; renderTools();
    $('library-action-status').textContent = '';
    $('exhibit-favorite').disabled = Boolean(user && id);
    if (!user || !id) return;
    try {
      var item = await api('/' + id);
      if (serial !== pageRequest || identity !== epoch) return;
      currentItem = item; renderTools();
    } catch (error) {
      if (serial === pageRequest && identity === epoch) $('library-action-status').textContent = errorMessage(error);
    } finally {
      if (serial === pageRequest && identity === epoch) $('exhibit-favorite').disabled = false;
    }
  }
  $('exhibit-favorite').addEventListener('click', async function () {
    var id = current;
    if (!id || !await requireLogin() || id !== current) return;
    var identity = epoch;
    $('exhibit-favorite').disabled = true;
    try {
      var before = await api('/' + id);
      if (identity !== epoch) return;
      var item = await api('/' + id, { favorite: !before.favorite });
      if (identity !== epoch || id !== current) return;
      currentItem = item; renderTools();
      $('library-action-status').textContent = item.favorite ? '已收藏，换设备登录后也能找到。' : '已取消收藏，私人笔记仍保留。';
    } catch (error) {
      if (identity === epoch && id === current) $('library-action-status').textContent = errorMessage(error);
    } finally { if (identity === epoch && id === current) $('exhibit-favorite').disabled = false; }
  });

  function button(label, fn) {
    var el = document.createElement('button'); el.type = 'button'; el.className = 'zhihu-auth-button'; el.textContent = label;
    el.addEventListener('click', fn); return el;
  }
  function renderList() {
    var mount = $('library-list'); mount.textContent = '';
    $('library-favorites').setAttribute('aria-pressed', String(filter === 'favorites'));
    $('library-notes').setAttribute('aria-pressed', String(filter === 'notes'));
    var picked = items.filter(function (item) { return catalog[item.nodeId] && (filter === 'favorites' ? item.favorite : item.hasNote); });
    $('library-list-status').textContent = picked.length ? '共 ' + picked.length + (filter === 'favorites' ? ' 件收藏' : ' 篇笔记') : (filter === 'favorites' ? '还没有收藏。在展品页点击“收藏展品”，就能在这里找到它。' : '还没有笔记。在展品页写下第一条观展感想吧。');
    picked.forEach(function (item) {
      var meta = catalog[item.nodeId], card = document.createElement('article'); card.className = 'library-item';
      var title = document.createElement('h3'); title.textContent = meta.node.title; card.appendChild(title);
      var museum = document.createElement('p'); museum.className = 'library-item-museum'; museum.textContent = meta.museum.name; card.appendChild(museum);
      if (item.hasNote) { var preview = document.createElement('p'); preview.textContent = item.notePreview; card.appendChild(preview); }
      card.appendChild(button('打开展品', function () { listDialog.close(); window.MuseumNavigation.open(meta.museum.id, item.nodeId); }));
      card.appendChild(button(item.hasNote ? '编辑笔记' : '写笔记', function () { listDialog.close(); openNote(item.nodeId); }));
      if (filter === 'favorites') card.appendChild(button('取消收藏', async function (event) {
        var control = event.currentTarget, identity = epoch;
        control.disabled = true;
        try {
          await api('/' + item.nodeId, { favorite: false });
          if (identity !== epoch) return;
          await loadList(); if (current === item.nodeId) refreshCurrent();
        } catch (error) { if (identity === epoch) { $('library-list-status').textContent = errorMessage(error); control.disabled = false; } }
      }));
      mount.appendChild(card);
    });
  }
  async function loadList() {
    var serial = ++listRequest, identity = epoch;
    $('library-list-status').textContent = '正在同步收藏与笔记…';
    $('library-refresh').disabled = true; $('library-login').hidden = true;
    try {
      var data = await api('');
      if (serial !== listRequest || identity !== epoch) return;
      items = data.items; renderList();
    } catch (error) {
      if (serial === listRequest && identity === epoch) {
        $('library-list-status').textContent = errorMessage(error); $('library-login').hidden = error.status !== 401;
      }
    } finally { if (serial === listRequest && identity === epoch) $('library-refresh').disabled = false; }
  }
  async function openLibrary() {
    if (!await requireLogin()) return;
    items = []; $('library-list').textContent = ''; listDialog.showModal(); loadList();
  }
  ['home-library', 'exhibit-library'].forEach(function (id) { $(id).addEventListener('click', openLibrary); });
  $('library-close').addEventListener('click', function () { listDialog.close(); });
  $('library-refresh').addEventListener('click', loadList);
  ['favorites', 'notes'].forEach(function (value) { $('library-' + value).addEventListener('click', function () { filter = value; renderList(); }); });
  $('library-login').addEventListener('click', function () { listDialog.close(); window.MuseumAuth.login(); });

  function dirty() { return Boolean(editing && text.value !== savedText); }
  function count() { $('note-count').textContent = text.value.length + ' / 2000'; }
  function closeNote() {
    if (saving) { $('note-status').textContent = '正在保存，请稍候…'; return false; }
    if (dirty() && !window.confirm('笔记尚未保存，确定放弃这次修改吗？')) return false;
    noteDialog.close(); return true;
  }
  function noteControls(busy) {
    text.disabled = busy; $('note-save').disabled = busy; $('note-delete').disabled = busy;
  }
  async function loadNote() {
    var id = editing, serial = ++noteRequest, identity = epoch;
    noteControls(true); $('note-status').textContent = '正在读取私人笔记…';
    $('note-reload').hidden = true; $('note-login').hidden = true;
    try {
      var item = await api('/' + id);
      if (serial !== noteRequest || identity !== epoch || !noteDialog.open) return;
      text.value = savedText = item.note; version = item.noteVersion; count(); noteControls(false);
      $('note-delete').hidden = !item.note; $('note-status').textContent = item.note ? '已载入保存的笔记。' : '写好后点击“保存笔记”。';
      text.focus();
    } catch (error) {
      if (serial === noteRequest && identity === epoch && noteDialog.open) {
        $('note-status').textContent = errorMessage(error); $('note-reload').hidden = false; $('note-login').hidden = error.status !== 401;
      }
    }
  }
  async function openNote(id) {
    if (!catalog[id] || !await requireLogin()) return;
    editing = id; savedText = text.value = ''; version = 0; count();
    $('note-exhibit').textContent = catalog[id].museum.name + ' · ' + catalog[id].node.title;
    $('note-delete').hidden = true; noteDialog.showModal(); loadNote();
  }
  async function saveNote(remove) {
    if (!editing || saving || text.disabled) return;
    if (remove && !window.confirm('确定删除这篇私人笔记吗？收藏展品会保留。')) return;
    var id = editing, identity = epoch, value = remove ? '' : text.value;
    saving = true; noteControls(true); $('note-status').textContent = '正在保存…';
    try {
      var item = await api('/' + id, { note: value, noteVersion: version });
      if (identity !== epoch || id !== editing) return;
      savedText = text.value = item.note; version = item.noteVersion; count();
      $('note-status').textContent = remove ? '笔记已删除。' : '已保存，仅你自己可见。';
      $('note-delete').hidden = !item.note; $('note-reload').hidden = true; $('note-login').hidden = true;
      if (current === id) { currentItem = item; renderTools(); }
    } catch (error) {
      if (identity === epoch && id === editing) {
        $('note-status').textContent = errorMessage(error); $('note-reload').hidden = error.status !== 409; $('note-login').hidden = error.status !== 401;
      }
    } finally { if (identity === epoch && id === editing) { saving = false; noteControls(false); } }
  }
  $('exhibit-note').addEventListener('click', function () { if (current) openNote(current); });
  $('note-save').addEventListener('click', function () { saveNote(false); });
  $('note-delete').addEventListener('click', function () { saveNote(true); });
  text.addEventListener('input', function () { count(); $('note-status').textContent = dirty() ? '有未保存的修改。' : ''; });
  $('note-close').addEventListener('click', closeNote);
  noteDialog.addEventListener('cancel', function (event) { event.preventDefault(); closeNote(); });
  noteDialog.addEventListener('close', function () { ++noteRequest; editing = null; text.value = savedText = ''; });
  $('note-reload').addEventListener('click', function () { if (!dirty() || window.confirm('重新载入会替换编辑框内未保存的文字，确定继续吗？')) loadNote(); });
  $('note-login').addEventListener('click', function () { if (closeNote()) window.MuseumAuth.login(); });
  window.addEventListener('beforeunload', function (event) { if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('museum:page', function (event) { current = event.detail && event.detail.nodeId; refreshCurrent(); });
  window.addEventListener('museum:auth', function (event) {
    var next = event.detail.user;
    if ((user && user.id) === (next && next.id)) return;
    user = next; ++epoch; items = []; currentItem = null; saving = false;
    listDialog.close(); noteDialog.close(); editing = null; text.value = savedText = ''; $('library-list').textContent = '';
    refreshCurrent();
  });
  // app.js may have restored an exhibit from the OAuth return hash before this script ran.
  current = $('view-exhibit').hidden ? null : $('view-exhibit').getAttribute('data-node-id');
  refreshCurrent();
})();
