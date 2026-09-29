"""Browser regression checks with controlled image delays, failures and timeouts."""
import asyncio
import functools
import http.server
import json
import threading
from pathlib import Path
from urllib.parse import unquote, urlsplit
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/page-transitions'
OUT.mkdir(parents=True, exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


async def main():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'dist')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    report = {'views': [], 'script_errors': []}
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='msedge', headless=True)
            for label, width, height in [('desktop', 1440, 1000), ('mobile', 390, 844)]:
                context = await browser.new_context(viewport={'width': width, 'height': height}, has_touch=label == 'mobile')
                page = await context.new_page()
                page.on('pageerror', lambda error: report['script_errors'].append(str(error)))
                await page.route('**/api/auth/session', lambda route: route.fulfill(json={'configured': True, 'authenticated': False}))
                holds, failures, requests = {}, set(), []

                async def images(route):
                    path = unquote(urlsplit(route.request.url).path)
                    requests.append(path)
                    if path in holds:
                        await holds[path].wait()
                    if path in failures:
                        await route.fulfill(status=503, body='Temporary failure')
                    else:
                        await route.fulfill(content_type='image/png', body=(ROOT / path.lstrip('/')).read_bytes())

                await page.route('**/assets/images/exhibits/**', images)
                await page.goto(f'http://127.0.0.1:{server.server_port}')
                nodes = await page.evaluate('''() => {
                    const m = MUSEUM_PACK.museums.find(m => m.id === 'sichuan');
                    const result = [];
                    function walk(id) {
                        result.push(m.nodes.find(n => n.id === id));
                        m.nodes.filter(n => n.parentId === id).forEach(n => walk(n.id));
                    }
                    walk(m.rootId); return result;
                }''')
                paths = ['/' + n['image'].removeprefix('./') for n in nodes]
                frame = page.locator('#exhibit-frame')
                loading = page.locator('#exhibit-loading')

                async def ready(index):
                    await expect(frame).to_have_attribute('aria-busy', 'false')
                    await expect(loading).to_be_hidden()
                    await expect(page.locator('#exhibit-image')).to_have_attribute('alt', nodes[index]['title'])

                async def select(index):
                    await page.locator('#exhibit-toc').click()
                    await page.locator(f'#exhibit-tree a[data-node-id="{nodes[index]["id"]}"]').click()

                holds[paths[0]] = asyncio.Event()
                holds[paths[1]] = asyncio.Event()
                await page.locator('[data-museum="sichuan"]').click()
                await expect(loading).to_be_visible()
                await expect(frame).to_have_attribute('aria-busy', 'true')
                await page.screenshot(path=str(OUT / f'{label}-first-load.png'))
                holds[paths[0]].set()
                await ready(0)
                await page.wait_for_timeout(350)
                await page.locator('#exhibit-next').click()
                await expect(loading).to_be_visible()
                assert nodes[1]['title'] in await loading.inner_text()
                assert await page.locator('#exhibit-image').get_attribute('alt') == nodes[0]['title']
                assert await page.locator('#exhibit-beacons').evaluate('(el) => el.inert')
                await page.wait_for_timeout(250)
                assert await page.locator('#exhibit-image').evaluate('(el) => getComputedStyle(el).filter') == 'blur(10px)'
                await page.screenshot(path=str(OUT / f'{label}-loading.png'))
                holds[paths[1]].set()
                await ready(1)
                await page.wait_for_timeout(350)
                await page.screenshot(path=str(OUT / f'{label}-ready.png'))

                # Cached backward navigation and next-page prefetch.
                await page.locator('#exhibit-back').click()
                await ready(0)
                assert requests.count(paths[0]) == 1
                assert paths[1] in requests

                # A delayed tree jump must not overwrite a later fast selection.
                holds[paths[7]] = asyncio.Event()
                await select(7)
                await expect(loading).to_be_visible()
                await select(4)
                await ready(4)
                holds[paths[7]].set()
                await page.wait_for_timeout(400)
                await ready(4)

                # Failure offers a functioning retry, rather than leaving stale artwork.
                failures.add(paths[9])
                await select(9)
                await expect(page.locator('#exhibit-retry')).to_be_visible()
                assert '暂时未能载入' in await loading.inner_text()
                await page.screenshot(path=str(OUT / f'{label}-error.png'))
                failures.remove(paths[9])
                await page.locator('#exhibit-retry').click()
                await ready(9)

                # Going home invalidates outstanding display work.
                holds[paths[6]] = asyncio.Event()
                await select(6)
                await expect(loading).to_be_visible()
                await page.locator('#exhibit-home').click()
                await page.locator('[data-museum="hunan"]').click()
                await expect(loading).to_be_hidden()
                other_title = await page.locator('#exhibit-image').get_attribute('alt')
                holds[paths[6]].set()
                await page.wait_for_timeout(200)
                await expect(page.locator('#exhibit-image')).to_have_attribute('alt', other_title)

                # Swipes still navigate both axes; reduce-motion disables reveal/spin.
                await page.emulate_media(reduced_motion='reduce')
                before = await page.locator('#view-exhibit').get_attribute('data-node-id')
                await page.locator('#exhibit-stage').evaluate('''el => {
                    for (const [type, x, y] of [['pointerdown',200,250], ['pointermove',100,250], ['pointerup',100,250]])
                        el.dispatchEvent(new PointerEvent(type, {bubbles:true,pointerId:1,isPrimary:true,clientX:x,clientY:y,button:0}));
                }''')
                await page.wait_for_function('(id) => document.querySelector("#view-exhibit").dataset.nodeId !== id', arg=before)
                await expect(loading).to_be_hidden()
                assert await page.locator('#exhibit-image').evaluate('(el) => getComputedStyle(el).animationName') == 'none'
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                await page.wait_for_timeout(300)
                await page.locator('#exhibit-stage').evaluate('''el => {
                    for (const [type, y] of [['pointerdown',200], ['pointermove',300], ['pointerup',300]])
                        el.dispatchEvent(new PointerEvent(type, {bubbles:true,pointerId:1,isPrimary:true,clientX:150,clientY:y,button:0}));
                }''')
                await expect(page.locator('#view-exhibit')).to_have_attribute('data-node-id', before)

                # Controlled clock covers the slow-network hint and 25-second deadline.
                await page.locator('#exhibit-home').click()
                await page.clock.install()
                other = await page.evaluate("MUSEUM_PACK.museums.find(m => m.id === 'henan')")
                other_root = next(n for n in other['nodes'] if n['id'] == other['rootId'])
                slow_path = '/' + other_root['image'].removeprefix('./')
                holds[slow_path] = asyncio.Event()
                await page.locator('[data-museum="henan"]').click()
                await expect(loading).to_be_visible()
                await page.clock.fast_forward(4100)
                assert '网络有些慢' in await loading.inner_text()
                await page.clock.fast_forward(21000)
                await expect(page.locator('#exhibit-retry')).to_be_visible()
                holds[slow_path].set()
                await page.wait_for_timeout(200)
                await expect(page.locator('#exhibit-retry')).to_be_visible()
                for event in holds.values():
                    event.set()
                report['views'].append({'viewport': label, 'cold_load': True, 'slow_load': True, 'cached_back': True, 'stale_request_ignored': True, 'failure_retry': True, 'swipes': True, 'reduced_motion': True, 'timeout': True})
                await context.close()
            await browser.close()
        assert not report['script_errors'], report['script_errors']
    finally:
        server.shutdown()
    (ROOT / 'reports/page-transition-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    asyncio.run(main())
