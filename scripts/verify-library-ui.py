"""Desktop/mobile UI checks using mock accounts; no real-user data is touched."""
import functools
import http.server
import json
import threading
from pathlib import Path
from urllib.parse import urlsplit, quote
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/library-preview'
OUT.mkdir(parents=True, exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'dist')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {'mock_accounts': True, 'views': [], 'script_errors': []}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='msedge', headless=True)
            for label, width, height in [('desktop', 1440, 1000), ('mobile', 390, 844)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                page = context.new_page()
                page.on('pageerror', lambda error: report['script_errors'].append(str(error)))
                state = {'user': None, 'fail_save': False}
                records = {}

                def api(route):
                    path = urlsplit(route.request.url).path
                    if path.startswith('/api/auth/'):
                        if path.endswith('/logout'):
                            state['user'] = None
                        user = state['user']
                        route.fulfill(json={'configured': True, 'authenticated': bool(user), 'user': {'id': user, 'name': user, 'avatar': '', 'headline': '', 'email': '', 'phone': ''} if user else None})
                        return
                    if not state['user']:
                        route.fulfill(status=401, json={'error': 'login_required'})
                        return
                    if route.request.headers.get('x-museum-user') != quote(state['user']):
                        route.fulfill(status=409, json={'error': 'account_changed'})
                        return
                    db = records.setdefault(state['user'], {})
                    if path == '/api/library':
                        route.fulfill(json={'items': [dict(item, hasNote=bool(item['note']), notePreview=item['note'][:100]) for item in db.values() if item['favorite'] or item['note']]})
                        return
                    node = path.split('/')[-1]
                    item = db.setdefault(node, {'nodeId': node, 'favorite': False, 'note': '', 'noteVersion': 0, 'updatedAt': None})
                    if route.request.method == 'PATCH':
                        patch = route.request.post_data_json
                        if state['fail_save']:
                            route.fulfill(status=503, json={'error': 'temporarily_unavailable'})
                            return
                        if 'note' in patch:
                            if patch['noteVersion'] != item['noteVersion']:
                                route.fulfill(status=409, json={'error': 'note_conflict'})
                                return
                            item.update(note=patch['note'], noteVersion=item['noteVersion'] + 1)
                        else:
                            item['favorite'] = patch['favorite']
                    route.fulfill(json=item)

                page.route('**/api/**', api)
                page.route('**/assets/images/exhibits/**', lambda route: route.fulfill(content_type='image/jpeg', body=(ROOT / 'assets/images/logo.jpg').read_bytes()))
                page.goto(f'http://127.0.0.1:{server.server_port}')
                page.locator('[data-museum="sichuan"]').click()
                node = page.locator('#view-exhibit').get_attribute('data-node-id')
                page.locator('#exhibit-favorite').click()
                expect(page.locator('#zhihu-auth-dialog')).to_be_visible()
                assert '#museum/sichuan/' in page.url
                page.locator('#zhihu-auth-close').click()
                state['user'] = '测试馆友 A'
                page.evaluate('MuseumAuth.refresh()')
                expect(page.locator('#exhibit-favorite')).to_be_enabled()
                page.locator('#exhibit-favorite').click()
                expect(page.locator('#exhibit-favorite')).to_have_attribute('aria-pressed', 'true')
                page.screenshot(path=str(OUT / f'{label}-favorite.png'))
                page.locator('#exhibit-note').click()
                expect(page.locator('#note-text')).to_be_enabled()
                note = '这件展品让我想到小时候的故事。\n<script>window.privateLeak=true</script>'
                page.locator('#note-text').fill(note)
                page.locator('#note-save').click()
                expect(page.locator('#note-status')).to_have_text('已保存，仅你自己可见。')
                page.screenshot(path=str(OUT / f'{label}-note.png'))
                page.locator('#note-close').click()
                page.reload()
                expect(page.locator('#exhibit-favorite')).to_have_attribute('aria-pressed', 'true')
                page.locator('#exhibit-library').click()
                expect(page.locator('.library-item')).to_have_count(1)
                assert page.evaluate('window.privateLeak') is None
                page.screenshot(path=str(OUT / f'{label}-library.png'))
                page.get_by_role('button', name='取消收藏', exact=True).click()
                expect(page.locator('.library-item')).to_have_count(0)
                page.locator('#library-notes').click()
                expect(page.locator('.library-item')).to_have_count(1)
                page.get_by_role('button', name='编辑笔记', exact=True).click()
                expect(page.locator('#note-text')).to_have_value(note)
                state['fail_save'] = True
                page.locator('#note-text').fill('离线修改，不能丢失')
                page.locator('#note-save').click()
                expect(page.locator('#note-status')).to_contain_text('暂时无法同步')
                expect(page.locator('#note-text')).to_have_value('离线修改，不能丢失')
                state['fail_save'] = False
                records[state['user']][node].update(note='另一设备的修改', noteVersion=2)
                page.locator('#note-save').click()
                expect(page.locator('#note-status')).to_contain_text('另一处更新')
                expect(page.locator('#note-text')).to_have_value('离线修改，不能丢失')
                page.once('dialog', lambda dialog: dialog.dismiss())
                page.locator('#note-close').click()
                expect(page.locator('#note-dialog')).to_be_visible()
                page.once('dialog', lambda dialog: dialog.accept())
                page.locator('#note-reload').click()
                expect(page.locator('#note-text')).to_have_value('另一设备的修改')
                page.once('dialog', lambda dialog: dialog.accept())
                page.locator('#note-delete').click()
                expect(page.locator('#note-status')).to_have_text('笔记已删除。')
                page.locator('#note-text').fill('仅 A 可见')
                page.locator('#note-save').click()
                expect(page.locator('#note-status')).to_have_text('已保存，仅你自己可见。')
                # Another tab changes the cookie while this editor still holds A's draft.
                page.locator('#note-text').fill('不能误存到 B 的草稿')
                state['user'] = '测试馆友 B'
                page.locator('#note-save').click()
                expect(page.locator('#note-dialog')).to_be_hidden()
                assert page.locator('#note-text').input_value() == ''
                page.locator('#exhibit-library').click()
                expect(page.locator('.library-item')).to_have_count(0)
                page.locator('#library-close').click()
                state['user'] = '测试馆友 A'
                page.evaluate('MuseumAuth.refresh()')
                page.locator('#exhibit-note').click()
                expect(page.locator('#note-text')).to_have_value('仅 A 可见')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert page.evaluate('localStorage.length') == 0
                report['views'].append({'viewport': label, 'login_prompt': True, 'favorite': True, 'unfavorite_preserves_note': True, 'note_save_delete': True, 'reload_persistence': True, 'error_preserves_draft': True, 'conflict': True, 'unsaved_confirmation': True, 'account_change_clears_private_ui': True, 'html_rendered_as_text': True})
                context.close()
            browser.close()
        assert not report['script_errors'], report['script_errors']
    finally:
        server.shutdown()
    (ROOT / 'reports/library-ui-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
