import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkZhihuLinks, validateZhihuLinks } from '../scripts/validate-zhihu-links.mjs';
import { ROOT } from '../scripts/build-cloudflare.mjs';

test('all 88 museum pages have one distinct Zhihu destination', async () => {
  assert.deepEqual(await checkZhihuLinks(ROOT), { pages: 88, links: 88, unique_destinations: 88 });
});

test('rejects missing, extra, duplicate and disguised duplicate links', () => {
  const pack = { museums: [{ nodes: [{ id: 'a' }, { id: 'b' }] }] };
  const entry = url => ({ title: 'Related reading', url });
  const valid = () => ({ a: [entry('https://zhuanlan.zhihu.com/p/1')], b: [entry('https://www.zhihu.com/question/2/answer/3')] });
  assert.equal(validateZhihuLinks(pack, valid()).links, 2);
  for (const mutate of [
    t => { t.a = []; },
    t => { t.a.push(entry('https://zhuanlan.zhihu.com/p/5')); },
    t => { t.b = [entry('https://zhuanlan.zhihu.com/p/1/?utm_source=test#top')]; },
    t => { t.a = [entry('https://zhihu.com/question/2/answer/4')]; },
    t => { t.a = [entry('https://www.zhihu.com/answer/3')]; },
    t => { t.a = [entry('https://www.zhihu.com.evil.example/question/5')]; },
    t => { t.a = [entry('https://www.zhihu.com/search?q=museum')]; },
    t => { t.unknown = t.a; },
  ]) {
    const topics = valid(); mutate(topics);
    assert.throws(() => validateZhihuLinks(pack, topics));
  }
});
