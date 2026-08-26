declare module 'MANIFEST' {
	import { SSRManifest } from '@sveltejs/kit';

	export interface AssetEntry {
		/** path on disk, relative to the served directory */
		file: string;
		size: number;
		/** `mtimeMs` at adapt time, used to detect files changed before startup */
		mtime: number;
		/** content hash */
		etag: string;
		/** size of the gzip variant, if one was written */
		gz?: number;
		/** size of the brotli variant, if one was written */
		br?: number;
	}

	export const base: string;
	export const manifest: SSRManifest;
	export const assets: AssetEntry[];
	/** `[pathname, entry]` pairs for the paths kit prerendered */
	export const prerendered_assets: Array<[string, AssetEntry]>;
}

declare module 'SERVER' {
	export { Server } from '@sveltejs/kit';
}
