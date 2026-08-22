import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const files = fileURLToPath(new URL('./files', import.meta.url).href);

/** @param {string} str */
function escape_regex(str) {
	// TODO replace with `RegExp.escape(str)` when we require Node >= 24
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @type {typeof import('./index.js').default} */
export default function (opts = {}) {
	const { out = 'build', precompress = true, envPrefix = '' } = opts;

	return {
		name: '@sveltejs/adapter-node',
		async adapt(builder) {
			const tmp = builder.getBuildDirectory('adapter-node');

			fs.rmSync(out, { force: true, recursive: true });
			fs.rmSync(tmp, { force: true, recursive: true });
			fs.mkdirSync(tmp, { recursive: true });

			const base = builder.config.paths.base;

			builder.log.minor('Copying assets');
			const client_files = builder.writeClient(`${out}/client${base}`);
			const prerendered_files = builder.writePrerendered(`${out}/prerendered${base}`);

			/** @type {string[][]} */
			let compressed = [[], []];

			if (precompress) {
				builder.log.minor('Compressing assets');
				compressed = await Promise.all([
					builder.compress(`${out}/client${base}`),
					builder.compress(`${out}/prerendered${base}`)
				]);
			}

			builder.log.minor('Hashing assets');
			const assets = await create_asset_table(
				`${out}/client${base}`,
				base,
				client_files,
				compressed[0]
			);
			const prerendered_assets = await create_asset_table(
				`${out}/prerendered${base}`,
				base,
				prerendered_files,
				compressed[1]
			);

			builder.log.minor('Building server');

			const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
			const server = builder.getServerDirectory();

			// Copy the prebuilt entrypoints into the build directory so that the
			// adapter's own bundled dependencies resolve correctly, then bundle them
			// together with the app's server code. Bundling everything in a single
			// pass means shared modules (e.g. `SvelteKitError` from `@sveltejs/kit`)
			// aren't duplicated. See https://github.com/sveltejs/kit/issues/15755
			const entries = posixify(`${tmp}/entries`);
			builder.copy(files, entries);

			const dir_id = `${entries}/dir.js`;

			fs.writeFileSync(
				`${server}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});`,
					`export const base = ${JSON.stringify(base)};`,
					`export const assets = ${JSON.stringify(assets)};`,
					`export const prerendered_assets = ${JSON.stringify(prerendered_assets)};`
				].join('\n\n')
			);

			/** @type {Record<string, string>} */
			const input = {
				index: `${entries}/index.js`,
				env: `${entries}/env.js`,
				handler: `${entries}/handler.js`
			};

			if (builder.hasServerInstrumentationFile()) {
				input['instrumentation.server'] = `${server}/instrumentation.server.js`;
			}

			// we bundle the Vite output so that deployments only need
			// their production dependencies. Anything in devDependencies
			// will get included in the bundled code
			const bundle = await rolldown({
				input,
				external: [
					// dependencies could have deep exports, so we need a regex
					...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`)),
					// `@opentelemetry/api` is an optional peer dependency of `@sveltejs/kit`,
					// so it's not in `pkg.dependencies` and wouldn't be matched by the regex above.
					// It must stay external so that `instrumentation.server.js` and the SvelteKit
					// runtime share a single instance — see https://github.com/sveltejs/kit/issues/16288
					/^@opentelemetry\/api(\/.*)?$/
				],
				platform: 'node',
				resolve: {
					conditionNames: ['node']
				},
				experimental: {
					nativeMagicString: true
				},
				plugins: [
					{
						// resolve the app's server and manifest, generated above
						name: 'adapter-node-resolve-app',
						resolveId(id) {
							if (id === 'SERVER') return `${server}/index.js`;
							if (id === 'MANIFEST') return `${server}/manifest.js`;
						}
					},
					{
						// replace build-time constants in the adapter's own entrypoints
						// only, so that identifiers in the app or its dependencies aren't
						// accidentally replaced
						name: 'adapter-node-replace-constants',
						transform: {
							filter: { id: new RegExp(escape_regex(entries)) },
							handler(_code, _id, { magicString }) {
								if (!magicString) throw new Error('experimental.nativeMagicString is not enabled');
								magicString
									.replace(/\bENV_PREFIX\b/g, JSON.stringify(envPrefix))
									.replace(
										/\bORIGIN\b/g,
										JSON.stringify(builder.config.paths.origin) || 'undefined'
									);
								return {
									code: magicString,
									map: magicString.generateMap().toString()
								};
							}
						}
					}
				]
			});

			await bundle.write({
				dir: out,
				format: 'esm',
				sourcemap: true,
				codeSplitting: {
					groups: [
						{
							name: 'dir',
							test: dir_id
						}
					]
				},
				chunkFileNames(chunk) {
					if (chunk.name === 'dir') return '[name].js';
					return 'server/chunks/[name]-[hash].js';
				}
			});

			if (builder.hasServerInstrumentationFile()) {
				builder.instrument({
					entrypoint: `${out}/index.js`,
					instrumentation: `${out}/instrumentation.server.js`,
					module: {
						exports: ['path', 'host', 'port', 'server']
					}
				});
			}
		},

		supports: {
			read: () => true,
			instrumentation: () => true
		}
	};
}

/**
 * Size and content hash, from a single pass over the file
 * @param {string} file
 * @returns {Promise<[number, string]>}
 */
async function measure(file) {
	const hash = createHash('sha256');
	let size = 0;

	for await (const chunk of fs.createReadStream(file)) {
		hash.update(chunk);
		size += chunk.length;
	}

	return [size, hash.digest('base64url')];
}

/**
 * Dotfiles are not served, with the customary exception of `.well-known`
 * @param {string} file
 */
function is_hidden(file) {
	return file.split('/').some((segment) => segment[0] === '.') && !file.startsWith('.well-known/');
}

/**
 * Records everything needed to serve the written files: exact URL keys
 * (plus `foo.html`/`foo/index.html` aliases), sizes, content-hash ETags,
 * and which compressed variants exist
 * @param {string} root
 * @param {string} base
 * @param {string[]} files
 * @param {string[]} compressed
 * @returns {Promise<import('MANIFEST').AssetTable>}
 */
async function create_asset_table(root, base, files, compressed) {
	const variants = new Set(compressed);

	const entries = await Promise.all(
		files
			.filter((file) => !is_hidden(file))
			.map(async (file) => {
				const [size, etag] = await measure(join(root, file));

				/** @type {import('MANIFEST').AssetEntry} */
				const entry = { file, size, etag };

				// `builder.compress` writes a `.gz` and a `.br` variant of every file it returns
				if (variants.has(file)) {
					entry.gz = await measure(join(root, `${file}.gz`));
					entry.br = await measure(join(root, `${file}.br`));
				}

				return /** @type {[string, import('MANIFEST').AssetEntry]} */ ([`${base}/${file}`, entry]);
			})
	);

	entries.sort(([a], [b]) => (a < b ? -1 : 1));

	const keys = new Set(entries.map(([key]) => key));

	/** @type {string[][]} */
	const aliases = [];

	/**
	 * @param {string} alias
	 * @param {string} key
	 */
	function alias(alias, key) {
		if (!keys.has(alias)) {
			keys.add(alias);
			aliases.push([alias, key]);
		}
	}

	// `/foo` and `/foo/` resolve to `foo.html`, unless a `foo/index.html` exists,
	// in which case `foo.html` wins (matching the resolution order sirv used)
	for (const [key, entry] of entries) {
		if (!entry.file.endsWith('.html')) continue;
		if (entry.file === 'index.html' || entry.file.endsWith('/index.html')) continue;
		alias(key.slice(0, -5), key);
		alias(key.slice(0, -5) + '/', key);
	}

	for (const [key, entry] of entries) {
		if (entry.file !== 'index.html' && !entry.file.endsWith('/index.html')) continue;
		const with_slash = key.slice(0, -'index.html'.length);
		if (with_slash.length > 1) alias(with_slash.slice(0, -1), key);
		alias(with_slash, key);
	}

	return { entries, aliases };
}

/** @param {string} str */
function posixify(str) {
	return str.replace(/\\/g, '/');
}
