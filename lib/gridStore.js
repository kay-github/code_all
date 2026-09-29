const { get, put, del, BlobPreconditionFailedError } = require('@vercel/blob');

// The store is private. Every read bypasses the Blob CDN so a just-written
// account or revision is visible to the next Vercel Function invocation.
async function read(pathname) {
  const result = await get(pathname, { access: 'private', useCache: false });
  if (!result) return null;
  if (result.statusCode !== 200 || !result.stream) throw new Error('Blob read failed');
  return { value: await new Response(result.stream).json(), etag: result.blob.etag };
}

async function write(pathname, value, etag = null) {
  const options = {
    access: 'private',
    contentType: 'application/json',
    cacheControlMaxAge: 60,
    allowOverwrite: etag !== null,
  };
  if (etag !== null) options.ifMatch = etag;
  return put(pathname, JSON.stringify(value), options);
}

async function remove(pathname, etag) {
  await del(pathname, { ifMatch: etag });
}

function isConflict(error) {
  return error instanceof BlobPreconditionFailedError || error?.code === 'conflict';
}

module.exports = { read, write, remove, isConflict };
