import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseData(text) {
  return JSON.parse(text.slice(text.indexOf('=') + 1).trim().replace(/;$/, ''));
}

// Treat tracking URLs, alternate answer URLs and answers to one question as duplicates.
export function destinationKeys(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Invalid Zhihu URL');
  const pathname = url.pathname.replace(/\/+$/, '');
  let match;
  if (url.hostname === 'zhuanlan.zhihu.com' && (match = pathname.match(/^\/p\/(\d+)$/))) {
    return ['article:' + match[1]];
  }
  if (['zhihu.com', 'www.zhihu.com'].includes(url.hostname)) {
    if ((match = pathname.match(/^\/question\/(\d+)(?:\/answer\/(\d+))?$/))) {
      return ['question:' + match[1], ...(match[2] ? ['answer:' + match[2]] : [])];
    }
    if ((match = pathname.match(/^\/answer\/(\d+)$/))) return ['answer:' + match[1]];
  }
  throw new Error('Expected a Zhihu article, question or answer URL');
}

export function validateZhihuLinks(pack, topics) {
  const seen = new Map();
  const pages = new Set();
  for (const museum of pack.museums) {
    for (const node of museum.nodes) {
      if (!node.id || pages.has(node.id)) throw new Error('Missing or duplicate page id');
      pages.add(node.id);
      const items = topics[node.id];
      if (!Array.isArray(items) || items.length !== 1) throw new Error(`${node.id}: expected exactly one Zhihu link`);
      if (!items[0].title?.trim()) throw new Error(`${node.id}: missing Zhihu title`);
      const keys = destinationKeys(items[0].url);
      for (const key of keys) {
        if (seen.has(key)) throw new Error(`Duplicate Zhihu destination: ${node.id} and ${seen.get(key)} (${key})`);
        seen.set(key, node.id);
      }
    }
  }
  for (const id of Object.keys(topics)) {
    if (!pages.has(id)) throw new Error(`Zhihu links for unknown page: ${id}`);
  }
  return { pages: pages.size, links: pages.size, unique_destinations: pages.size };
}

export async function checkZhihuLinks(root) {
  const [pack, topics] = await Promise.all(['museum-data.js', 'zhihu-topics.js'].map(name => readFile(path.join(root, 'assets/js', name), 'utf8').then(parseData)));
  return validateZhihuLinks(pack, topics);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkZhihuLinks(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))));
}
