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
			const client_dir = `${out}/client${base}`;
			const prerendered_dir = `${out}/prerendered${base}`;

			builder.log.minor('Copying assets');
			const client_files = builder.writeClient(client_dir);
			const prerendered_files = builder.writePrerendered(prerendered_dir);

			builder.log.minor(precompress ? 'Compressing and hashing assets' : 'Hashing assets');
			const [client_compressed, prerendered_compressed] = precompress
				? await Promise.all([builder.compress(client_dir), builder.compress(prerendered_dir)])
				: [[], []];

			const assets = await measure_files(client_dir, client_files, client_compressed);
			const prerendered_assets = create_prerendered_table(
				base,
				await measure_files(prerendered_dir, prerendered_files, prerendered_compressed),
				builder.prerendered.paths
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
 * Content hash of a file
 * @param {string} file
 */
async function hash(file) {
	const sha = createHash('sha256');

	for await (const chunk of fs.createReadStream(file)) sha.update(chunk);

	return sha.digest('base64url');
}

/**
 * Dotfiles are not served, with the customary exception of `.well-known`.
 * Keep in sync with the copy in `src/static.js`
 * @param {string} file
 */
function is_hidden(file) {
	return file.split('/').some((segment) => segment[0] === '.') && !file.startsWith('.well-known/');
}

/**
 * Size, mtime and content hash of every servable file, plus the sizes of the
 * compressed variants where `builder.compress` wrote them, sorted by path
 * @param {string} root
 * @param {string[]} files
 * @param {string[]} compressed
 * @returns {Promise<import('MANIFEST').AssetEntry[]>}
 */
async function measure_files(root, files, compressed) {
	const variants = new Set(compressed);

	const entries = await Promise.all(
		files
			.filter((file) => !is_hidden(file))
			.map(async (file) => {
				const abs = join(root, file);
				const { size, mtimeMs: mtime } = fs.statSync(abs);

				/** @type {import('MANIFEST').AssetEntry} */
				const entry = { file, size, mtime, etag: await hash(abs) };

				// `builder.compress` writes a `.gz` and a `.br` variant of every file it returns
				if (variants.has(file)) {
					entry.gz = fs.statSync(`${abs}.gz`).size;
					entry.br = fs.statSync(`${abs}.br`).size;
				}

				return entry;
			})
	);

	return entries.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/**
 * Keys the measured files by the exact paths kit prerendered, so a lookup
 * hit is precisely a prerendered page, asset or redirect and every other
 * pathname (including the non-canonical trailing-slash form) misses
 * @param {string} base
 * @param {import('MANIFEST').AssetEntry[]} measured
 * @param {string[]} paths
 * @returns {Array<[string, import('MANIFEST').AssetEntry]>}
 */
function create_prerendered_table(base, measured, paths) {
	const by_file = new Map(measured.map((entry) => [entry.file, entry]));

	/** @type {Array<[string, import('MANIFEST').AssetEntry]>} */
	const entries = [];

	for (const path of paths) {
		// invert `output_filename` in kit's prerenderer
		const file = path.slice(base.length + 1) || 'index.html';
		const entry =
			by_file.get(file) ?? by_file.get(file + (file.endsWith('/') ? 'index.html' : '.html'));
		if (entry) entries.push([path, entry]);
	}

	return entries.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** @param {string} str */
function posixify(str) {
	return str.replace(/\\/g, '/');
}
