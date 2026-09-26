/**
 * 展馆内树形目录。参照绘本数字图书馆的图层树，按当前馆的父子关系绘制。
 */
'use strict';

(function (global) {
    function childrenOf(nodes, parentId) {
        var kids = [];
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].parentId === parentId) kids.push(nodes[i]);
        }
        return kids;
    }

    function walk(nodes, parentId, prefix, lines) {
        var kids = childrenOf(nodes, parentId);
        for (var i = 0; i < kids.length; i++) {
            var last = i === kids.length - 1;
            var branch = last ? '└─ ' : '├─ ';
            var nextPrefix = prefix + (last ? '   ' : '│  ');
            lines.push({
                prefix: prefix + branch,
                node: kids[i]
            });
            walk(nodes, kids[i].id, nextPrefix, lines);
        }
    }

    function makeLink(node, options) {
        var link = document.createElement('a');
        link.href = '#';
        link.textContent = node.title;
        link.setAttribute('data-node-id', node.id);
        if (options.currentId === node.id) {
            link.className = 'is-current';
            link.setAttribute('aria-current', 'page');
        }
        link.addEventListener('click', function (e) {
            e.preventDefault();
            if (options.onSelect) options.onSelect(node);
        });
        return link;
    }

    function renderMuseumTree(mount, museum, options) {
        if (!mount) return;
        options = options || {};
        mount.textContent = '';
        if (!museum || !museum.nodes || !museum.nodes.length) return;

        var root = null;
        for (var i = 0; i < museum.nodes.length; i++) {
            if (museum.nodes[i].id === museum.rootId) {
                root = museum.nodes[i];
                break;
            }
        }
        if (!root) return;

        var count = document.createElement('p');
        count.className = 'story-tree-count';
        count.textContent = '(' + museum.nodes.length + ')';
        mount.appendChild(count);

        var rootLine = document.createElement('p');
        rootLine.className = 'story-tree-root';
        rootLine.appendChild(makeLink(root, options));
        mount.appendChild(rootLine);

        var lines = [];
        walk(museum.nodes, root.id, '', lines);

        var pre = document.createElement('div');
        pre.className = 'story-tree-body';
        lines.forEach(function (line) {
            var row = document.createElement('div');
            row.className = 'story-tree-row';
            var gutter = document.createElement('span');
            gutter.className = 'story-tree-branch';
            gutter.textContent = line.prefix;
            row.appendChild(gutter);
            row.appendChild(makeLink(line.node, options));
            pre.appendChild(row);
        });
        mount.appendChild(pre);

        var current = mount.querySelector('.is-current');
        var pop = mount.parentNode;
        if (current && pop && !pop.hidden && pop.scrollHeight > pop.clientHeight + 4) {
            var rect = current.getBoundingClientRect();
            var box = pop.getBoundingClientRect();
            if (rect.top < box.top || rect.bottom > box.bottom) {
                pop.scrollTop += rect.top - box.top - 12;
            }
        }
    }

    global.renderMuseumTree = renderMuseumTree;
})(window);
