"""Visit every exhibit and check the actual rendered Zhihu link, locally or live."""
import argparse
import base64
import functools
import hashlib
import http.server
import json
import re
import threading
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', help='Omit to start a local static server')
    args = parser.parse_args()
    server = None
    origin = args.origin
    if not origin:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'dist')))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f'http://127.0.0.1:{server.server_port}'
    report = {'origin': origin, 'views': [], 'script_errors': [], 'image_requests_mocked': True}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='msedge', headless=True)
            for label, width, height in [('desktop', 1440, 1000), ('mobile', 390, 844)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                page = context.new_page()
                page.on('pageerror', lambda e: report['script_errors'].append(str(e)))
                # Link verification is independent of large R2 images and network speed.
                pixel = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc0AAAAASUVORK5CYII=')
                page.route('**/assets/images/exhibits/**', lambda route: route.fulfill(content_type='image/png', body=pixel))
                if not args.origin:
                    page.route('**/api/auth/**', lambda route: route.fulfill(json={'configured': True, 'authenticated': False}))
                response = page.goto(origin, wait_until='domcontentloaded', timeout=60000)
                assert response.status == 200
                page.wait_for_function('window.MUSEUM_PACK && window.ZHIHU_TOPICS && document.querySelector(".museum-card")')
                if args.origin and label == 'desktop':
                    for name in ['index.html', 'assets/js/app.js', 'assets/js/zhihu-topics.js']:
                        data = page.evaluate(r'''async name => {
                            const r = await fetch('/' + name, {cache: 'no-store'});
                            const bytes = new TextEncoder().encode((await r.text()).replace(/\r\n/g, '\n'));
                            const hash = await crypto.subtle.digest('SHA-256', bytes);
                            return {status: r.status, sha: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')};
                        }''', name)
                        expected = hashlib.sha256((ROOT / 'dist' / name).read_text(encoding='utf-8').encode()).hexdigest()
                        assert data['status'] == 200 and data['sha'] == expected, name
                    session = page.evaluate("fetch('/api/auth/session', {cache:'no-store'}).then(r => r.json())")
                    assert session['configured']
                    report['published_assets_verified'] = 3
                    report['oauth_configured'] = True
                museums = page.evaluate('MUSEUM_PACK.museums')
                seen, pages = set(), []
                for museum in museums:
                    page.locator(f'[data-museum="{museum["id"]}"]').click()
                    for node in museum['nodes']:
                        page.locator('#exhibit-toc').click()
                        page.locator(f'#exhibit-tree a[data-node-id="{node["id"]}"]').click()
                        assert page.locator('#view-exhibit').get_attribute('data-node-id') == node['id']
                        links = page.locator('#view-exhibit a[href*="zhihu.com/"]')
                        assert links.count() == 1, node['title']
                        href = links.get_attribute('href')
                        assert href == page.evaluate('(id) => ZHIHU_TOPICS[id][0].url', node['id'])
                        assert links.inner_text().strip()
                        assert links.get_attribute('target') == '_blank'
                        assert 'noopener' in links.get_attribute('rel')
                        url = urlsplit(href)
                        assert url.scheme == 'https' and url.netloc in ('www.zhihu.com', 'zhihu.com', 'zhuanlan.zhihu.com')
                        key = url.netloc.replace('www.', '') + re.sub(r'/answer/\d+$', '', url.path.rstrip('/'))
                        assert key not in seen, href
                        seen.add(key)
                        pages.append({'node_id': node['id'], 'url': href})
                    page.locator('#exhibit-home').click()
                assert len(pages) == len(seen) == 88
                report['views'].append({'viewport': label, 'pages': 88, 'links': 88, 'unique_destinations': 88})
                context.close()
            browser.close()
        assert not report['script_errors'], report['script_errors']
    finally:
        if server:
            server.shutdown()
    name = 'zhihu-links-live.json' if args.origin else 'zhihu-links-browser.json'
    (ROOT / 'reports' / name).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
