"""Exercise the login interface with mock OAuth responses; no real authorization."""
import functools
import http.server
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(root/'dist')))
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
out = root/'reports/auth-preview'
out.mkdir(exist_ok=True)
report = {'mock_authorization': True, 'views': [], 'errors': []}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        for label, width, height in [('desktop', 1440, 1000), ('mobile', 390, 844)]:
            context = browser.new_context(viewport={'width': width, 'height': height})
            page = context.new_page()
            page.on('pageerror', lambda error: report['errors'].append(str(error)))
            state = {'logged_in': False}
            def api(route):
                if route.request.url.endswith('/session'):
                    body = {'configured': True, 'authenticated': state['logged_in'], 'user': {'name': '测试馆友', 'id': 'test', 'avatar': '', 'headline': '喜欢慢慢看故事', 'email': 'x***@example.com', 'phone': '138****5678'} if state['logged_in'] else None}
                elif route.request.url.endswith('/logout'):
                    state['logged_in'] = False
                    body = {'authenticated': False}
                else:
                    body = {'authorizationUrl': 'https://openapi.zhihu.com/authorize?app_id=851&state=mock'}
                route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
            page.route('**/api/auth/**', api)
            page.route('https://openapi.zhihu.com/**', lambda route: route.fulfill(status=200, content_type='text/html', body='<p>Mock authorization destination</p>'))
            page.goto(origin)
            page.locator('#zhihu-login').click()
            assert page.locator('#zhihu-auth-dialog').is_visible()
            assert page.locator('#zhihu-authorize').is_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out/f'{label}-login.png'))
            page.locator('#zhihu-authorize').click()
            page.wait_for_url('https://openapi.zhihu.com/**')
            state['logged_in'] = True
            page.goto(origin)
            page.locator('#zhihu-account').click()
            assert page.locator('#zhihu-name').inner_text() == '测试馆友'
            assert '138****5678' in page.locator('#zhihu-contact').inner_text()
            page.screenshot(path=str(out/f'{label}-account.png'))
            page.locator('#zhihu-logout').click()
            page.wait_for_function("!document.querySelector('#zhihu-login').hidden")
            assert page.locator('#zhihu-auth-status').inner_text().startswith('已退出')
            page.goto(origin+'/?auth_error=state_invalid')
            assert page.locator('#zhihu-auth-dialog').is_visible()
            assert '未通过' in page.locator('#zhihu-auth-status').inner_text()
            assert 'auth_error' not in page.url
            report['views'].append({'viewport': label, 'login': True, 'account': True, 'logout': True, 'error': True})
            context.close()
        browser.close()
    assert not report['errors'], report['errors']
finally:
    server.shutdown()
(root/'reports/auth-ui-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
