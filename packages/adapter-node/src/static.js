import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** @import { AssetEntry } from 'MANIFEST' */

/**
 * @typedef {{
 *   file: string,
 *   size: number,
 *   etag: string,
 *   type?: string,
 *   gz?: number,
 *   br?: number
 * }} Asset
 */

/**
 * Splits `req.url` into a decoded pathname and the search string.
 * Decoding follows kit's router: reserved characters such as `%2F` stay
 * encoded. An undecodable pathname is returned as-is, so it misses the
 * asset table and falls through to SvelteKit's 400
 * @param {import('node:http').IncomingMessage} req
 */
function split_url(req) {
	let pathname = /** @type {string} */ (req.url);
	let search = '';

	const query_index = pathname.indexOf('?');
	if (query_index !== -1) {
		search = pathname.slice(query_index);
		pathname = pathname.slice(0, query_index);
	}

	if (pathname.includes('%')) {
		try {
			pathname = pathname.split('%25').map(decodeURI).join('%25');
		} catch {
			// invalid URI
		}
	}

	return { pathname, search };
}

/**
 * Relative reference from `from` to `to`, which must differ only by a trailing slash.
 * Keep in sync with the copy in `packages/kit/src/utils/url.js`
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function relative_pathname(from, to) {
	const segment = to.replace(/\/$/, '').split('/').at(-1);

	return from.endsWith('/') ? `../${segment}` : `${segment}/`;
}

/**
 * Content hash of a file, read in chunks so large assets are not buffered whole
 * @param {string} file
 */
function hash(file) {
	const sha = createHash('sha256');
	const chunk = Buffer.allocUnsafe(65536);
	const fd = fs.openSync(file, 'r');

	try {
		let read;
		while ((read = fs.readSync(fd, chunk)) > 0) sha.update(chunk.subarray(0, read));
	} finally {
		fs.closeSync(fd);
	}

	return sha.digest('base64url');
}

/**
 * Dotfiles are not served, with the customary exception of `.well-known`.
 * Keep in sync with the copy in `index.js`
 * @param {string} file
 */
function is_hidden(file) {
	return file.split('/').some((segment) => segment[0] === '.') && !file.startsWith('.well-known/');
}

/**
 * Files in `dir` as posix paths relative to it
 * @param {string} dir
 */
function* list(dir) {
	for (const dirent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!dirent.isFile()) continue;

		const file = path
			.relative(dir, path.join(dirent.parentPath, dirent.name))
			.replaceAll(path.sep, '/');
		if (!is_hidden(file)) yield file;
	}
}

/**
 * Parses `Accept-Encoding` and picks the preferred variant that exists
 * @param {string | undefined} header
 * @param {Asset} asset
 * @returns {'br' | 'gzip' | undefined}
 */
function negotiate(header, asset) {
	if (!header) return;

	/** @type {Map<string, number>} */
	const weights = new Map();

	for (const part of header.toLowerCase().split(',')) {
		const [coding, ...params] = part.split(';');
		let weight = 1;

		for (const param of params) {
			const [name, value] = param.split('=');
			if (name.trim() === 'q') weight = parseFloat(value) || 0;
		}

		weights.set(coding.trim(), weight);
	}

	const wildcard = weights.get('*') ?? 0;

	/** @type {'br' | 'gzip' | undefined} */
	let best;
	let best_weight = 0;

	if (asset.br) {
		best_weight = weights.get('br') ?? wildcard;
		if (best_weight > 0) best = 'br';
	}

	if (asset.gz && (weights.get('gzip') ?? wildcard) > best_weight) best = 'gzip';

	return best;
}

/**
 * Whether an `If-None-Match` value matches `etag`, using weak comparison
 * @param {string | undefined} header
 * @param {string} etag
 */
function etag_matches(header, etag) {
	if (!header) return false;
	if (header.trim() === '*') return true;

	return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

/**
 * Serves the files recorded in the manifest at adapt time, checked against
 * the disk at startup so that deployments which modify the build output
 * (adding runtime configuration, say) still work: a file whose size or
 * mtime changed since adapt is rehashed, one that disappeared is dropped and,
 * when `discover` is set, files that were added are picked up. Everything
 * else keeps the metadata the build computed, so requests are a map lookup
 * and a stream.
 *
 * @param {string} dir
 * @param {Array<[string, AssetEntry]>} table `[pathname, entry]` pairs
 * @param {{
 *   mime_types: Record<string, string>,
 *   discover?: string,
 *   immutable_prefix?: string,
 *   redirect_trailing_slash?: boolean
 * }} opts `discover` is the pathname prefix under which every file in `dir` is served
 * @returns {import('./handler.js').Middleware}
 */
export function serve_static(
	dir,
	table,
	{ mime_types, discover, immutable_prefix, redirect_trailing_slash }
) {
	/** @type {Map<string, Asset>} */
	const files = new Map();

	/**
	 * @param {string} key
	 * @param {string} file
	 * @param {number} size
	 * @param {string} etag
	 * @param {Pick<AssetEntry, 'gz' | 'br'>} [variants]
	 */
	function add(key, file, size, etag, { gz, br } = {}) {
		let type = mime_types[file.slice(file.lastIndexOf('.'))];
		if (type === 'text/html') type += ';charset=utf-8';

		files.set(key, { file: path.join(dir, file), size, etag, type, gz, br });
	}

	for (const [key, entry] of table) {
		const file = path.join(dir, entry.file);
		const stats = fs.statSync(file, { throwIfNoEntry: false });
		if (!stats) continue;

		if (stats.size === entry.size && stats.mtimeMs === entry.mtime) {
			add(key, entry.file, stats.size, entry.etag, entry);
		} else {
			// replaced since adapt, so any compressed variants next to it are stale too
			add(key, entry.file, stats.size, hash(file));
		}
	}

	if (discover !== undefined && fs.existsSync(dir)) {
		for (const file of list(dir)) {
			const key = `${discover}/${file}`;
			if (files.has(key)) continue;

			const abs = path.join(dir, file);

			// skip the compressed variants `builder.compress` writes next to their originals
			if (
				/\.(gz|br)$/.test(file) &&
				(files.has(key.slice(0, -3)) || fs.existsSync(abs.slice(0, -3)))
			) {
				continue;
			}

			add(key, file, fs.statSync(abs).size, hash(abs));
		}
	}

	/**
	 * @param {string} alias
	 * @param {string} key
	 */
	function alias(alias, key) {
		if (!files.has(alias)) files.set(alias, /** @type {Asset} */ (files.get(key)));
	}

	if (discover !== undefined) {
		const keys = [...files.keys()];

		// `/foo` and `/foo/` resolve to `foo.html`, unless a `foo/index.html` exists,
		// in which case `foo.html` wins (matching the resolution order sirv used)
		for (const key of keys) {
			if (!key.endsWith('.html') || key.endsWith('/index.html')) continue;
			alias(key.slice(0, -5), key);
			alias(key.slice(0, -5) + '/', key);
		}

		for (const key of keys) {
			if (!key.endsWith('/index.html')) continue;
			const with_slash = key.slice(0, -'index.html'.length);
			if (with_slash.length > 1) alias(with_slash.slice(0, -1), key);
			alias(with_slash, key);
		}
	}

	return (req, res, next) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') return next();

		const { pathname, search } = split_url(req);

		const asset = files.get(pathname);
		if (!asset) {
			if (redirect_trailing_slash) {
				// redirect to the canonical path when only the trailing slash differs
				const inverted = pathname.at(-1) === '/' ? pathname.slice(0, -1) : pathname + '/';
				if (files.has(inverted)) {
					const location = relative_pathname(pathname, inverted) + search;
					res.writeHead(308, { location }).end();
					return;
				}
			}
			return next();
		}

		let file = asset.file;
		let size = asset.size;
		let etag = `"${asset.etag}"`;

		const encoding = negotiate(req.headers['accept-encoding'], asset);
		if (encoding === 'br') {
			size = /** @type {number} */ (asset.br);
			file += '.br';
			etag = `"${asset.etag}.br"`;
		} else if (encoding === 'gzip') {
			size = /** @type {number} */ (asset.gz);
			file += '.gz';
			etag = `"${asset.etag}.gz"`;
		}

		/** @type {Record<string, string | number>} */
		const headers = { etag };

		if (asset.br || asset.gz) headers.vary = 'Accept-Encoding';

		if (immutable_prefix && pathname.startsWith(immutable_prefix)) {
			headers['cache-control'] = 'public,max-age=31536000,immutable';
		}

		if (etag_matches(req.headers['if-none-match'], etag)) {
			res.writeHead(304, headers).end();
			return;
		}

		headers['content-length'] = size;
		headers['accept-ranges'] = 'bytes';
		if (asset.type) headers['content-type'] = asset.type;
		if (encoding) headers['content-encoding'] = encoding;

		/** @type {{ start?: number, end?: number }} */
		const range = {};
		let status = 200;

		// a stale `If-Range` validator means the client's partial copy is of an older
		// representation, so it gets the whole current one
		const if_range = req.headers['if-range'];
		if (req.headers.range && (!if_range || if_range === etag)) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);

			if (match && (match[1] || match[2])) {
				let start = match[1] ? parseInt(match[1], 10) : NaN;
				let end = match[2] ? parseInt(match[2], 10) : size - 1;

				if (isNaN(start)) {
					// suffix range: the last `match[2]` bytes
					start = Math.max(size - end, 0);
					end = size - 1;
				} else {
					end = Math.min(end, size - 1);
				}

				if (start >= size || start > end) {
					res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
					return;
				}

				status = 206;
				headers['content-range'] = `bytes ${start}-${end}/${size}`;
				headers['content-length'] = end - start + 1;
				range.start = start;
				range.end = end;
			}
		}

		res.writeHead(status, headers);

		if (req.method === 'HEAD') {
			res.end();
			return;
		}

		// headers are already sent, so all we can do is drop the connection
		fs.createReadStream(file, range)
			.on('error', () => res.destroy())
			.pipe(res);
	};
}
