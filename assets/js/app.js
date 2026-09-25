/**
 * 绘本数字博物馆 — 单页小工具（无联网、无内联脚本）
 */
'use strict';

(function () {
    var pack = window.MUSEUM_PACK;
    var viewHome = document.getElementById('view-home');
    var viewExhibit = document.getElementById('view-exhibit');
    var grid = document.getElementById('museum-grid');
    var toastEl = document.getElementById('exhibit-toast');
    var toastTimer = null;
    var exhibitState = null;

    function toast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.hidden = true;
        }, 1800);
    }

    function showHome() {
        document.body.classList.remove('is-exhibit');
        viewHome.hidden = false;
        viewExhibit.hidden = true;
        exhibitState = null;
        window.scrollTo(0, 0);
    }

    function showExhibit() {
        document.body.classList.add('is-exhibit');
        viewHome.hidden = true;
        viewExhibit.hidden = false;
    }

    function renderGrid() {
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

    function openMuseum(museumId) {
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

        exhibitState = {
            museum: museum,
            byId: byId,
            childrenOf: childrenOf,
            currentId: museum.rootId,
            trail: [museum.rootId]
        };
        showExhibit();
        renderExhibit();
    }

    function renderExhibit() {
        var s = exhibitState;
        if (!s) return;
        var museumEl = document.getElementById('exhibit-museum');
        var titleEl = document.getElementById('exhibit-title');
        var imgEl = document.getElementById('exhibit-image');
        var beaconsEl = document.getElementById('exhibit-beacons');
        var backBtn = document.getElementById('exhibit-back');
        var hintEl = document.getElementById('exhibit-hint');
        var node = s.byId[s.currentId];
        if (!node) return;

        museumEl.textContent = s.museum.name;
        titleEl.textContent = node.title;
        imgEl.alt = node.title;
        imgEl.src = node.image;
        backBtn.hidden = s.trail.length < 2 && !node.parentId;
        beaconsEl.textContent = '';

        var kids = s.childrenOf[s.currentId] || [];
        kids.forEach(function (kid) {
            if (!kid.click) return;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'exhibit-beacon';
            btn.style.left = (kid.click.x * 100) + '%';
            btn.style.top = (kid.click.y * 100) + '%';
            btn.setAttribute('aria-label', '进入：' + kid.title);
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                s.trail.push(kid.id);
                s.currentId = kid.id;
                renderExhibit();
            });
            beaconsEl.appendChild(btn);
        });

        hintEl.textContent = kids.length
            ? '白点是已经点过的展项，点它进入下一页。画面其他位置不会生成新内容。'
            : '这条展线到此为止。可点「上一页」返回。';
    }

    function initExhibitControls() {
        document.getElementById('exhibit-home').addEventListener('click', showHome);
        document.getElementById('btn-logo').addEventListener('click', showHome);
        document.getElementById('exhibit-back').addEventListener('click', function () {
            var s = exhibitState;
            if (!s) return;
            if (s.trail.length > 1) {
                s.trail.pop();
                s.currentId = s.trail[s.trail.length - 1];
                renderExhibit();
            }
        });
        document.getElementById('exhibit-frame').addEventListener('click', function (e) {
            var t = e.target;
            while (t && t !== this) {
                if (t.classList && t.classList.contains('exhibit-beacon')) return;
                t = t.parentNode;
            }
            toast('此处尚未开放，请点击画面上的圆点');
        });
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
