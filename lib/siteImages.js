const { createHash } = require('node:crypto');
const sharp = require('sharp');
const blob = require('@vercel/blob');
const { SiteError } = require('./siteService');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_ID = /^[a-f0-9]{64}$/;
const imagePath = id => `tool-site/icons/${id}.webp`;

async function prepareImage(data) {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new SiteError(413, 'image_size', '上传图片须小于 2 MB');
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new SiteError(400, 'image', '图片内容无效，请重新选择');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.toString('base64') !== data) throw new SiteError(400, 'image', '图片内容无效，请重新选择');
  if (buffer.length > MAX_IMAGE_BYTES) throw new SiteError(413, 'image_size', '上传图片须小于 2 MB');
  // Check bytes before invoking a decoder: SVG/XML and other active formats never enter it.
  const png = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  const webp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const gif = ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6));
  if (!png && !jpeg && !webp && !gif) throw new SiteError(415, 'image_type', '请选择 JPG、PNG、WebP 或 GIF 图片');
  try {
    const image = sharp(buffer, { limitInputPixels: 40_000_000, failOn: 'warning', animated: false });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width > 10000 || metadata.height > 10000) throw new Error();
    // Re-encode actual pixels, remove metadata/trailing payloads and retain the first animation frame.
    return await image.rotate().resize(256, 256, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch {
    throw new SiteError(400, 'image', '图片无法读取或尺寸过大，请换一张图片');
  }
}

async function upload(data) {
  const buffer = await prepareImage(data);
  const id = createHash('sha256').update(buffer).digest('hex');
  await blob.put(imagePath(id), buffer, { access: 'private', contentType: 'image/webp', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000 });
  return { image: `/api/site/image?id=${id}` };
}

async function read(id) {
  if (typeof id !== 'string' || !IMAGE_ID.test(id)) throw new SiteError(404, 'not_found', '图片不存在');
  const result = await blob.get(imagePath(id), { access: 'private', useCache: false });
  if (!result) throw new SiteError(404, 'not_found', '图片不存在');
  if (result.statusCode !== 200 || !result.stream) throw new Error('Image read failed');
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

module.exports = { upload, read, prepareImage, MAX_IMAGE_BYTES };
