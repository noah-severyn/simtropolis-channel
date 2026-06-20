#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { styleText } from 'node:util';
import { Glob } from 'glob';
import ora from 'ora';
import { parseAllDocuments } from 'yaml';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';
import { urlToFileId } from '../actions/fetch/util.js';

const endpoint = 'https://community.simtropolis.com/stex/files-api.php';
const srcPath = fileURLToPath(new URL('../src/yaml/', import.meta.url));

function normalizeSc4pacVersion(version) {
	return String(version).trim().replace(/-\d+$/, '');
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getStexIdFromPackage(pkg) {
	let websites = [
		pkg.info?.website,
		...(pkg.info?.websites ?? []),
	].filter(Boolean);
	for (let website of websites) {
		try {
			let parsed = new URL(website);
			if (!parsed.hostname.includes('simtropolis.com')) continue;
			let id = urlToFileId(parsed.href);
			if (Number.isFinite(id)) {
				return { id, website: parsed.href };
			}
		} catch {
			// Ignore malformed urls.
		}
	}
	return null;
}

async function readLocalPackages() {
	let packages = [];
	const glob = new Glob('**/*.yaml', {
		cwd: srcPath,
		nodir: true,
		absolute: true,
	});
	for await (const file of glob) {
		let contents = String(await fs.promises.readFile(file));
		for (let doc of parseAllDocuments(contents)) {
			let pkg = doc.toJSON();
			if (!pkg || pkg.assetId) continue;
			if (!pkg.group || !pkg.name || !pkg.version || !pkg.info) continue;
			let stex = getStexIdFromPackage(pkg);
			if (!stex) continue;
			packages.push({
				id: stex.id,
				website: stex.website,
				group: pkg.group,
				name: pkg.name,
				version: String(pkg.version),
				normalizedVersion: normalizeSc4pacVersion(pkg.version),
				file,
			});
		}
	}
	return packages;
}

async function fetchAllStexFiles(apiKey) {
	const allFiles = [];
	const limit = 1000;
	let offset = 0;
	while (true) {
		const url = new URL(endpoint);
		url.searchParams.set('key', apiKey);
		url.searchParams.set('mode', 'submitted');
		url.searchParams.set('days', '-1');
		url.searchParams.set('sc4only', 'true');
		url.searchParams.set('offset', String(offset));
		url.searchParams.set('limit', String(limit));

		let res = await fetch(url);
		if (res.status === 404) {
			break;
		}
		if (res.status >= 400) {
			throw new Error(`STEX API returned ${res.status}`);
		}
		let batch = await res.json();
		if (!Array.isArray(batch) || batch.length === 0) {
			break;
		}
		allFiles.push(...batch);
		if (batch.length < limit) {
			break;
		}
		offset += limit;
		await sleep(1500);
	}
	return allFiles;
}

async function run(argv) {
	const apiKey = process.env.STEX_API_KEY;
	if (!apiKey) {
		console.error(styleText('red', 'Error: STEX_API_KEY environment variable is not set'));
		console.log('Please add your STEX API key to your .env file');
		process.exit(1);
	}

	const scanSpinner = ora('Scanning local package metadata...').start();
	let packages = await readLocalPackages();
	scanSpinner.succeed(`Scanned ${styleText('cyan', packages.length.toString())} packages with Simtropolis URLs`);

	const fetchSpinner = ora('Fetching STEX versions...').start();
	let stexFiles = await fetchAllStexFiles(apiKey);
	let stexById = new Map(stexFiles.map(file => [Number(file.id), file]));
	fetchSpinner.succeed(`Fetched ${styleText('cyan', stexFiles.length.toString())} STEX uploads`);

	let mismatches = [];
	let missing = [];
	for (const pkg of packages) {
		let stex = stexById.get(pkg.id);
		if (!stex) {
			missing.push(pkg);
			continue;
		}
		let stexVersion = String(stex.release ?? '').trim();
		if (pkg.normalizedVersion !== stexVersion) {
			mismatches.push({
				...pkg,
				stexVersion,
				stexTitle: stex.title,
			});
		}
	}

	console.log();
	console.log(styleText('bold', 'Version mismatch report'));
	console.log(`Mismatches: ${styleText('yellow', mismatches.length.toString())}`);
	console.log(`Missing on STEX API: ${styleText('yellow', missing.length.toString())}`);

	if (mismatches.length > 0) {
		console.log();
		for (const row of mismatches.sort((a, b) => `${a.group}:${a.name}`.localeCompare(`${b.group}:${b.name}`))) {
			console.log(`- ${row.group}:${row.name}`);
			console.log(`  sc4pac: ${row.version} (normalized: ${row.normalizedVersion})`);
			console.log(`  STEX:   ${row.stexVersion}`);
			console.log(`  URL:    ${row.website}`);
		}
	}

	if (argv.showMissing && missing.length > 0) {
		console.log();
		console.log(styleText('bold', 'Packages missing on STEX API'));
		for (const row of missing.sort((a, b) => `${a.group}:${a.name}`.localeCompare(`${b.group}:${b.name}`))) {
			console.log(`- ${row.group}:${row.name} (${row.website})`);
		}
	}

}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const isNpm = !!process.env.npm_lifecycle_event;
	const scriptName = isNpm ?
		`npm run ${process.env.npm_lifecycle_event} --` :
		'list-version-mismatches.js';

	const { argv } = yargs(hideBin(process.argv))
		.scriptName(scriptName)
		.usage('Usage: $0 [options]')
		.example('$0', 'List packages where STEX and sc4pac versions differ')
		.option('show-missing', {
			type: 'boolean',
			default: false,
			description: 'Show package URLs not found via STEX API',
		})
		.version(false)
		.group(['show-missing'], 'Options:')
		.group(['help'], 'Info:')
		.help();

	await run(argv);
}
