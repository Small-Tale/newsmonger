import { cacheArticleImage, cacheFavicon } from './cache.js';

/** Resolves an article URL to a cached lead image, or null. */
export type ImageFetcher = (articleUrl: string) => Promise<{ hash: string; sourceUrl: string } | null>;

/** Resolves an origin to a cached favicon, or null (NEWS-169). */
export type FaviconFetcher = (origin: string) => Promise<{ hash: string; sourceUrl: string } | null>;

/** The real fetcher, bound to a data directory. */
export function createImageFetcher(dataDir: string): ImageFetcher {
  return (articleUrl) => cacheArticleImage(articleUrl, dataDir);
}

/** The real favicon fetcher, bound to a data directory. */
export function createFaviconFetcher(dataDir: string): FaviconFetcher {
  return (origin) => cacheFavicon(origin, dataDir);
}

export {
  cachedImagePath,
  cacheImageUrl,
  isValidHash,
  liveImageHashes,
  pruneImageCache,
  sniffImageType,
} from './cache.js';
export { originOf } from './favicon.js';
