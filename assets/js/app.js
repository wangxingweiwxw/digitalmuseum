/**
 * 绘本数字博物馆 — 单页小工具
 * 展馆内按树形目录翻页；话题简介在构建时由知乎搜索写入 zhihu-topics.js。
 */
'use strict';

(function () {
    var pack = window.MUSEUM_PACK;
    var topics = window.ZHIHU_TOPICS || {};
    var viewHome = document.getElementById('view-home');
    var viewExhibit = document.getElementById('view-exhibit');
    var toastEl = document.getElementById('exhibit-toast');
    var toastTimer = null;
    var exhibitState = null;
    var suppressClick = false;
    var suppressClickTimer = null;

    function toast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.hidden = true;
        }, 1800);
    }

    function setTocOpen(open) {
        var pop = document.getElementById('exhibit-tree-pop');
        var btn = document.getElementById('exhibit-toc');
        if (!pop || !btn) return;
        pop.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) btn.classList.add('is-active');
        else btn.classList.remove('is-active');
    }

    function showHome() {
        document.body.classList.remove('is-exhibit');
        viewHome.hidden = false;
        viewExhibit.hidden = true;
        exhibitState = null;
        setTocOpen(false);
        window.scrollTo(0, 0);
    }

    function showExhibit() {
        document.body.classList.add('is-exhibit');
        viewHome.hidden = true;
        viewExhibit.hidden = false;
        window.scrollTo(0, 0);
    }

    function renderGrid() {
        var grid = document.getElementById('museum-grid');
        if (!pack || !grid) return;
        var order = ['sichuan', 'shanghai', 'baoensi', 'shanxi', 'guangdong', 'henan', 'hainan', 'hunan'];
        var byId = {};
        pack.museums.forEach(function (m) { byId[m.id] = m; });
        grid.textContent = '';
        order.forEach(function (id) {
            var m = byId[id];
            if (!m) return;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'museum-card';
            btn.setAttribute('data-museum', m.id);

            var img = document.createElement('img');
            img.src = m.cover;
            img.alt = m.name;

            var body = document.createElement('div');
            body.className = 'museum-card-body';

            var tag = document.createElement('span');
            tag.className = 'project-tag';
            tag.textContent = m.city;

            var h3 = document.createElement('h3');
            h3.textContent = m.name;

            var p = document.createElement('p');
            p.textContent = m.blurb;

            body.appendChild(tag);
            body.appendChild(h3);
            body.appendChild(p);
            btn.appendChild(img);
            btn.appendChild(body);
            btn.addEventListener('click', function () {
                openMuseum(m.id);
            });
            grid.appendChild(btn);
        });
    }

    function treeOrder(byId, childrenOf, rootId) {
        var order = [];
        (function walk(id) {
            if (!byId[id]) return;
            order.push(id);
            var kids = childrenOf[id] || [];
            for (var k = 0; k < kids.length; k++) walk(kids[k].id);
        })(rootId);
        return order;
    }

    function openMuseum(museumId, nodeId) {
        if (!pack) {
            toast('展厅数据未加载');
            return;
        }
        var museum = null;
        for (var i = 0; i < pack.museums.length; i++) {
            if (pack.museums[i].id === museumId) {
                museum = pack.museums[i];
                break;
            }
        }
        if (!museum) {
            toast('未找到这座博物馆');
            return;
        }

        var byId = {};
        var childrenOf = {};
        museum.nodes.forEach(function (n) {
            byId[n.id] = n;
            if (n.parentId) {
                if (!childrenOf[n.parentId]) childrenOf[n.parentId] = [];
                childrenOf[n.parentId].push(n);
            }
        });

        var order = treeOrder(byId, childrenOf, museum.rootId);
        var startId = nodeId && byId[nodeId] ? nodeId : museum.rootId;
        var index = order.indexOf(startId);
        if (index < 0) index = 0;
        exhibitState = {
            museum: museum,
            byId: byId,
            childrenOf: childrenOf,
            order: order,
            index: index,
            navLockUntil: 0
        };
        showExhibit();
        renderExhibit();
    }

    function currentId(s) {
        return s.order[s.index];
    }

    function showExhibitNode(id) {
        var s = exhibitState;
        if (!s) return;
        var nextIndex = s.order.indexOf(id);
        if (nextIndex < 0) return;
        setTocOpen(false);
        s.index = nextIndex;
        renderExhibit();
    }

    function goExhibit(delta) {
        var s = exhibitState;
        if (!s || !delta) return;
        var now = Date.now();
        if (now < s.navLockUntil) return;
        var next = s.index + delta;
        if (next < 0) {
            s.navLockUntil = now + 280;
            toast('已经是第一页');
            return;
        }
        if (next >= s.order.length) {
            s.navLockUntil = now + 280;
            toast('已经是最后一页');
            return;
        }
        setTocOpen(false);
        s.navLockUntil = now + 280;
        s.index = next;
        renderExhibit();
    }

    function safeZhihuUrl(url) {
        if (!url || typeof url !== 'string') return '';
        if (url.indexOf('https://www.zhihu.com/') === 0) return url;
        if (url.indexOf('https://zhuanlan.zhihu.com/') === 0) return url;
        if (url.indexOf('https://zhihu.com/') === 0) return url;
        return '';
    }

    function renderZhihu(node) {
        var box = document.getElementById('exhibit-zhihu');
        var listEl = document.getElementById('exhibit-zhihu-list');
        if (!box || !listEl || !node) return;
        listEl.textContent = '';
        var items = topics[node.id] || [];
        var picked = null;
        for (var i = 0; i < items.length; i++) {
            if (safeZhihuUrl(items[i].url) && items[i].title) {
                picked = items[i];
                break;
            }
        }
        if (!picked) {
            box.hidden = true;
            return;
        }
        var line = document.createElement('p');
        line.className = 'exhibit-zhihu-line';
        var mark = document.createElement('span');
        mark.className = 'exhibit-zhihu-mark';
        mark.textContent = '知乎';
        var link = document.createElement('a');
        link.href = safeZhihuUrl(picked.url);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = picked.title;
        line.appendChild(mark);
        line.appendChild(link);
        listEl.appendChild(line);
        if (picked.summary) {
            var summary = document.createElement('p');
            summary.className = 'exhibit-zhihu-summary';
            summary.textContent = picked.summary;
            listEl.appendChild(summary);
        }
        box.hidden = false;
    }

    function renderTree(s, node) {
        var mount = document.getElementById('exhibit-tree');
        if (!mount || typeof window.renderMuseumTree !== 'function') return;
        window.renderMuseumTree(mount, s.museum, {
            currentId: node.id,
            onSelect: function (picked) {
                setTocOpen(false);
                showExhibitNode(picked.id);
            }
        });
    }

    function hasClassWalk(el, className, stopEl) {
        var node = el;
        while (node && node !== stopEl) {
            if (node.classList && node.classList.contains(className)) return true;
            node = node.parentNode;
        }
        return false;
    }

    function renderExhibit() {
        var s = exhibitState;
        if (!s) return;
        var museumEl = document.getElementById('exhibit-museum');
        var titleEl = document.getElementById('exhibit-title');
        var imgEl = document.getElementById('exhibit-image');
        var beaconsEl = document.getElementById('exhibit-beacons');
        var backBtn = document.getElementById('exhibit-back');
        var nextBtn = document.getElementById('exhibit-next');
        var hintEl = document.getElementById('exhibit-hint');
        var node = s.byId[currentId(s)];
        if (!node) return;

        museumEl.textContent = s.museum.name;
        titleEl.textContent = node.title;
        imgEl.alt = node.title;
        imgEl.src = node.image;
        if (backBtn) backBtn.hidden = s.index <= 0;
        if (nextBtn) nextBtn.hidden = s.index >= s.order.length - 1;
        beaconsEl.textContent = '';

        var kids = s.childrenOf[currentId(s)] || [];
        kids.forEach(function (kid) {
            if (!kid.click) return;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'exhibit-beacon';
            btn.style.left = (kid.click.x * 100) + '%';
            btn.style.top = (kid.click.y * 100) + '%';
            btn.setAttribute('aria-label', '进入：' + kid.title);
            btn.addEventListener('click', function (e) {
                if (suppressClick) {
                    suppressClick = false;
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                e.stopPropagation();
                showExhibitNode(kid.id);
            });
            beaconsEl.appendChild(btn);
        });

        if (hintEl) {
            hintEl.textContent = '向左或向上滑动进入下一页，向右或向下滑动回到上一页。白点可进入对应展项。';
        }
        renderTree(s, node);
        renderZhihu(node);
    }

    function exhibitOpen() {
        return !!(exhibitState && viewExhibit && !viewExhibit.hidden);
    }

    function initExhibitControls() {
        document.getElementById('exhibit-home').addEventListener('click', showHome);
        document.getElementById('btn-logo').addEventListener('click', showHome);
        document.getElementById('exhibit-toc').addEventListener('click', function () {
            var pop = document.getElementById('exhibit-tree-pop');
            setTocOpen(pop && pop.hidden);
        });
        document.addEventListener('click', function (e) {
            var pop = document.getElementById('exhibit-tree-pop');
            var btn = document.getElementById('exhibit-toc');
            if (!pop || pop.hidden || !btn) return;
            if (pop.contains(e.target) || btn.contains(e.target)) return;
            setTocOpen(false);
        });
        document.getElementById('exhibit-back').addEventListener('click', function () {
            goExhibit(-1);
        });
        var nextBtn = document.getElementById('exhibit-next');
        if (nextBtn) {
            nextBtn.addEventListener('click', function () {
                goExhibit(1);
            });
        }

        var surface = document.getElementById('exhibit-stage');
        if (!surface) return;
        var imgEl = document.getElementById('exhibit-image');
        if (imgEl) imgEl.draggable = false;

        var drag = null;

        function point(e, prop) {
            if (e.changedTouches && e.changedTouches[0]) return e.changedTouches[0][prop];
            if (e.touches && e.touches[0]) return e.touches[0][prop];
            return e[prop];
        }

        function threshold() {
            var w = window.innerWidth || 800;
            return Math.max(36, Math.min(72, w * 0.1));
        }

        function swipeDelta(dx, dy) {
            var ax = Math.abs(dx);
            var ay = Math.abs(dy);
            var min = threshold();
            if (ax < min && ay < min) return 0;
            if (ax >= ay) return dx < 0 ? 1 : -1;
            return dy < 0 ? 1 : -1;
        }

        function ignoreStart(el) {
            return hasClassWalk(el, 'exhibit-tree', surface)
                || hasClassWalk(el, 'exhibit-tree-pop', surface)
                || hasClassWalk(el, 'story-tree', surface)
                || hasClassWalk(el, 'exhibit-zhihu', surface)
                || hasClassWalk(el, 'exhibit-toc', surface)
                || hasClassWalk(el, 'exhibit-home', surface)
                || hasClassWalk(el, 'exhibit-pager', surface)
                || hasClassWalk(el, 'exhibit-back', surface)
                || hasClassWalk(el, 'exhibit-hint', surface);
        }

        function start(e) {
            if (!exhibitOpen()) return;
            if (e.touches && e.touches.length > 1) {
                drag = null;
                return;
            }
            if (typeof e.button === 'number' && e.button !== 0) return;
            if (ignoreStart(e.target)) return;
            drag = {
                x: point(e, 'clientX'),
                y: point(e, 'clientY'),
                moved: false
            };
            if (surface.classList) surface.classList.add('is-dragging');
            if (e.pointerId != null && surface.setPointerCapture) {
                try { surface.setPointerCapture(e.pointerId); } catch (err) {}
            }
        }

        function move(e) {
            if (!exhibitOpen() || !drag) return;
            var dx = point(e, 'clientX') - drag.x;
            var dy = point(e, 'clientY') - drag.y;
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) drag.moved = true;
            if (drag.moved && e.cancelable) e.preventDefault();
        }

        function end(e) {
            if (!drag) return;
            var dx = point(e, 'clientX') - drag.x;
            var dy = point(e, 'clientY') - drag.y;
            var moved = drag.moved;
            drag = null;
            if (surface.classList) surface.classList.remove('is-dragging');
            if (e.pointerId != null && surface.releasePointerCapture) {
                try { surface.releasePointerCapture(e.pointerId); } catch (err) {}
            }
            if (!exhibitOpen()) return;
            var delta = swipeDelta(dx, dy);
            if (!delta) return;
            suppressClick = true;
            clearTimeout(suppressClickTimer);
            suppressClickTimer = setTimeout(function () {
                suppressClick = false;
            }, 400);
            goExhibit(delta);
            if (moved && e.cancelable) e.preventDefault();
        }

        function cancel() {
            drag = null;
            if (surface.classList) surface.classList.remove('is-dragging');
        }

        document.getElementById('exhibit-frame').addEventListener('click', function (e) {
            if (!exhibitOpen()) return;
            var pop = document.getElementById('exhibit-tree-pop');
            if (pop && !pop.hidden) {
                setTocOpen(false);
                return;
            }
            if (suppressClick) {
                suppressClick = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (hasClassWalk(e.target, 'exhibit-beacon', this)) return;
            toast('此处尚未开放。向左或向上滑动进入下一页，点白点或目录可进入对应展项。');
        });

        if (window.PointerEvent) {
            surface.addEventListener('pointerdown', start);
            surface.addEventListener('pointermove', move, { passive: false });
            surface.addEventListener('pointerup', end);
            surface.addEventListener('pointercancel', cancel);
            return;
        }
        surface.addEventListener('touchstart', start, { passive: true });
        surface.addEventListener('touchmove', move, { passive: false });
        surface.addEventListener('touchend', end);
        surface.addEventListener('touchcancel', cancel);
        surface.addEventListener('mousedown', start);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
    }

    function initNavScroll() {
        var navbar = document.querySelector('.navbar');
        if (!navbar) return;
        window.addEventListener('scroll', function () {
            if (window.scrollY > 60) navbar.classList.add('scrolled');
            else navbar.classList.remove('scrolled');
        });
    }

    function initBackToTop() {
        var btn = document.getElementById('back-to-top');
        if (!btn) return;
        window.addEventListener('scroll', function () {
            if (window.scrollY > 400) btn.classList.add('show');
            else btn.classList.remove('show');
        });
        btn.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    function init() {
        renderGrid();
        initExhibitControls();
        initNavScroll();
        initBackToTop();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
