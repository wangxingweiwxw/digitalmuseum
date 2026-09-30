"""Public production smoke test; never creates sessions or reads real-user notes."""
import hashlib
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://museum.chipai.cc'

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    report = {'origin': ORIGIN, 'real_user_notes_accessed': False, 'views': [], 'script_errors': []}
    for label, width, height in [('desktop', 1440, 1000), ('mobile', 390, 844)]:
        context = browser.new_context(viewport={'width': width, 'height': height})
        page = context.new_page()
        page.on('pageerror', lambda error: report['script_errors'].append(str(error)))
        response = page.goto(ORIGIN, wait_until='networkidle', timeout=60000)
        assert response.status == 200
        expect(page.locator('#home-library')).to_be_visible()
        session = page.evaluate("async () => (await fetch('/api/auth/session', {cache:'no-store'})).json()")
        assert session['configured'] and not session['authenticated']
        if label == 'desktop':
            files = ['index.html', 'assets/js/app.js', 'assets/js/auth.js', 'assets/js/library.js', 'assets/css/library.css']
            for name in files:
                content = page.evaluate("async name => { const r=await fetch('/'+name+'?library-check='+Date.now(),{cache:'no-store'}); if(!r.ok)throw Error(r.status); return r.text(); }", name)
                assert content.replace('\r\n', '\n') == (ROOT / 'dist' / name).read_text(encoding='utf-8'), name
            report['published_files_match_local'] = files
        page.locator('#home-library').click()
        expect(page.locator('#zhihu-auth-dialog')).to_be_visible()
        page.locator('#zhihu-auth-close').click()
        page.locator('[data-museum="sichuan"]').click()
        expect(page.locator('#exhibit-image')).to_be_visible(timeout=60000)
        page.wait_for_function("document.querySelector('#exhibit-image').complete && document.querySelector('#exhibit-image').naturalWidth > 0", timeout=60000)
        node = page.locator('#view-exhibit').get_attribute('data-node-id')
        checks = page.evaluate("""async node => {
            const paths=['/api/library', '/api/library/'+node];
            const result=[];
            for(const path of paths){
                for(const method of ['GET','PATCH']){
                    const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:method==='PATCH'?JSON.stringify({favorite:true}):undefined,cache:'no-store'});
                    result.push({status:r.status,cache:r.headers.get('cache-control'),body:await r.json()});
                }
            }
            return result;
        }""", node)
        assert all(x['status'] == 401 and 'no-store' in x['cache'] and x['body']['error'] == 'login_required' for x in checks)
        page.locator('#exhibit-note').click()
        expect(page.locator('#zhihu-auth-dialog')).to_be_visible()
        page.locator('#zhihu-auth-close').click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(ROOT / 'reports/library-preview' / f'{label}-live.png'), full_page=True)
        report['views'].append({'viewport': label, 'oauth_configured': True, 'library_requires_login': True, 'note_requires_login': True, 'private_api_401_no_store': True, 'r2_image_loaded': True})
        context.close()
    browser.close()
    assert not report['script_errors'], report['script_errors']
    (ROOT / 'reports/library-live-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True))
