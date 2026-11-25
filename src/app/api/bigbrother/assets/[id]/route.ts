import { ApiError, route } from '@/lib/api';
import { readAsset } from '@/lib/bigbrother/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { id: string };

/**
 * Serve one uploaded image.
 *
 * The route is authenticated and scoped to the caller's own assets, so an asset
 * URL from another account returns 404 rather than the image.
 */
export const GET = route<Params>({ permission: null }, async ({ params, user }) => {
  const asset = await readAsset(user.id, params.id);
  if (!asset.buffer.length) throw new ApiError('Image not found.', 404, 'asset_not_found');
  return new Response(new Uint8Array(asset.buffer), {
    status: 200,
    headers: {
      'Content-Type': asset.mime,
      'Content-Length': String(asset.buffer.length),
      'Cache-Control': 'private, max-age=300',
      'Content-Disposition': `inline; filename="${asset.filename.replace(/[^\w.-]+/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
