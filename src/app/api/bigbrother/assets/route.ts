import { ApiError, ok, rateLimit, route, searchParams } from '@/lib/api';
import { deleteAsset, listAssets, MAX_ASSET_BYTES, saveAsset } from '@/lib/bigbrother/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route({ permission: null }, async ({ user }) => {
  return ok({ assets: await listAssets(user.id) });
});

/**
 * Upload one instructional image. Multipart, not JSON: the bytes are checked by
 * magic number, written 0600 outside public/, and never returned by name alone.
 */
export const POST = route({ permission: null }, async ({ req, user }) => {
  rateLimit(`bb-asset:${user.id}`, 20, 60_000);

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    throw new ApiError('Upload the image as multipart/form-data.', 415, 'multipart_required');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError('The upload could not be parsed.', 400, 'bad_upload');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new ApiError('Attach an image in the "file" field.', 400, 'file_required');
  }
  if (file.size > MAX_ASSET_BYTES) {
    throw new ApiError(
      `The image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ASSET_BYTES / 1024 / 1024} MB.`,
      413,
      'asset_too_large',
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const asset = await saveAsset(user.id, { filename: file.name || 'image', buffer });
  return ok({ asset });
});

export const DELETE = route({ permission: null }, async ({ req, user }) => {
  const id = searchParams(req).get('id');
  if (!id) throw new ApiError('An asset id is required.', 400, 'asset_required');
  await deleteAsset(user.id, id);
  return ok({ deleted: id });
});
