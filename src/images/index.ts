import { cacheArticleImage } from './cache.js';

/** Resolves an article URL to a cached lead image, or null. */
export type ImageFetcher = (articleUrl: string) => Promise<{ hash: string; sourceUrl: string } | null>;

/** The real fetcher, bound to a data directory. */
export function createImageFetcher(dataDir: string): ImageFetcher {
  return (articleUrl) => cacheArticleImage(articleUrl, dataDir);
}

export { cachedImagePath, isValidHash, liveImageHashes, pruneImageCache, sniffImageType } from './cache.js';
