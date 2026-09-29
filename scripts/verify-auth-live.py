"""Verify deployed assets and OAuth initiation in Edge, without granting Zhihu consent."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'.cloudflare/build-manifest.json').read_text(encoding='utf-8'))
origin='https://museum.chipai.cc'
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    response=page.goto(origin,wait_until='networkidle',timeout=60000)
    assert response.status==200
    assert page.locator('#zhihu-login').is_visible()
    session=page.evaluate("async () => { const r=await fetch('/api/auth/session',{cache:'no-store'}); return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')}; }")
    assert session['status']==200 and session['body']['configured'] and not session['body']['authenticated']
    assert session['cache']=='no-store'
    images=page.evaluate("""async items => {
      const result=[];
      for(let start=0;start<items.length;start+=6){
        result.push(...await Promise.all(items.slice(start,start+6).map(async item=>{
          const r=await fetch('/'+item.source);
          const data=await r.arrayBuffer();
          const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
          return {source:item.source,status:r.status,hash,expected:item.hash,type:r.headers.get('content-type')};
        })));
      }
      return result;
    }""",manifest['r2_images'])
    assert all(row['status']==200 and row['hash']==row['expected'] and row['type']=='image/png' for row in images)
    start=page.evaluate("async () => {const r=await fetch('/api/auth/zhihu/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({returnTo:'/'})});return {status:r.status,body:await r.json()};}")
    assert start['status']==200
    from urllib.parse import urlparse,parse_qs
    target=urlparse(start['body']['authorizationUrl']);query=parse_qs(target.query)
    assert target.hostname=='openapi.zhihu.com' and query['app_id']==['851']
    assert query['redirect_uri']==[origin+'/zhihu-callback'] and len(query['state'][0])==64
    cookies=context.cookies(origin)
    flow=next(c for c in cookies if c['name']=='__Host-museum_oauth')
    assert flow['httpOnly'] and flow['secure'] and flow['sameSite']=='Lax'
    invalid=page.evaluate("async () => {const r=await fetch('/zhihu-callback?authorization_code=invalid'); return r.url;}")
    assert 'state_invalid' in invalid
    page.locator('#zhihu-login').click()
    page.screenshot(path=str(root/'reports/auth-preview/live-login.png'))
    assert not errors,errors
    report={'origin':origin,'homepage_status':response.status,'r2_images_sha256_verified':len(images),'anonymous_session_endpoint':True,'oauth_start':True,'app_id':'851','callback':origin+'/zhihu-callback','cookie_flags_verified':True,'invalid_callback_rejected':True,'real_user_consent_verified':False,'script_errors':errors}
    (root/'reports/auth-live-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))
    browser.close()
