declare module 'MANIFEST' {
	import { SSRManifest } from '@sveltejs/kit';

	export interface AssetEntry {
		/** path on disk, relative to the served directory until `create_asset_map` resolves it */
		file: string;
		size: number;
		/** content hash */
		etag: string;
		/** size and content hash of the gzip variant, if one was written */
		gz?: [number, string];
		/** size and content hash of the brotli variant, if one was written */
		br?: [number, string];
	}

	export interface AssetTable {
		entries: Array<[string, AssetEntry]>;
		/** `[alias, key]` pairs, e.g. `['/about', '/about.html']` */
		aliases: string[][];
	}

	export const base: string;
	export const manifest: SSRManifest;
	export const prerendered: Set<string>;
	export const assets: AssetTable;
	export const prerendered_assets: AssetTable;
}

declare module 'SERVER' {
	export { Server } from '@sveltejs/kit';
}
