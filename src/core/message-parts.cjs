'use strict';

// A URL bubble must stay byte-for-byte copyable. Never add reply suffixes to it.
function extractLinks(content) {
  const seen = new Set();
  for (const match of String(content).matchAll(/https?:\/\/[^\s\u200b-\u200f<>"'，。；！？、（）【】]+/giu)) {
    const value = match[0].replace(/[.,;!?)\]}]+$/u, '');
    try {
      const url = new URL(value);
      if (url.hostname && !url.username && !url.password && value.length <= 4096) seen.add(value);
    } catch {}
  }
  return [...seen].slice(0, 10);
}

function officialImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['pddpic.com', 'yangkeduo.com', 'pinduoduo.com', 'pddugc.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  } catch { return false; }
}

function validateImages(value = []) {
  if (!Array.isArray(value) || value.length > 5) throw new TypeError('最多可附加 5 张图片');
  const seen = new Set();
  return value.map(image => {
    if (!image || typeof image !== 'object' || !/^[a-f0-9]{64}$/.test(image.id || '') || seen.has(image.id) ||
      !officialImageUrl(image.url) || image.url.length > 4096 || typeof image.shopId !== 'string' || !image.shopId || image.shopId.length > 512 ||
      typeof image.name !== 'string' || !image.name || image.name.length > 255 || !['image/png','image/jpeg'].includes(image.mime) ||
      !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > 5 * 1024 * 1024 ||
      !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 20000 || image.height > 20000 ||
      !Number.isFinite(image.uploadedAt) || image.uploadedAt <= 0) throw new TypeError('图片信息不完整，请重新选择并上传');
    seen.add(image.id);
    return Object.fromEntries(['id','name','url','shopId','mime','bytes','width','height','uploadedAt'].map(key => [key, image[key]]));
  });
}

function messageParts(content, images = [], separateLinks = false) {
  const parts = separateLinks ? extractLinks(content).filter(url => url !== content.trim()).map(content => ({ kind: 'link', content })) : [];
  for (const image of validateImages(images)) parts.push({ kind: 'image', content: image.url, image });
  return parts;
}

module.exports = { extractLinks, officialImageUrl, validateImages, messageParts };
