#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import ora from 'ora';
import { hideBin } from 'yargs/helpers';
import { Minimatch } from 'minimatch';
import yargs from 'yargs/yargs';
import { styleText } from 'node:util';
import traverse from './traverse-yaml.js';
import fetchFromStex from '../actions/fetch/fetch.js';

const { argv } = yargs(hideBin(process.argv));
const channel = path.resolve(import.meta.dirname, '../dist/channel');
const contents = JSON.parse(fs.readFileSync(path.join(channel, 'sc4pac-channel-contents.json')));

// If glob patterns were specified for what packages we need to refresh, filter
// them out.
let packages = (contents.packages ?? [])
	.map(pkg => `${pkg.group}:${pkg.name}`);
let matches = argv._.map(pattern => new Minimatch(pattern));
if (matches.length > 0) {
	packages = packages.filter(pkg => {
		return matches.some(mm => mm.match(pkg));
	});
}

if (packages.length === 0) {
	console.log(styleText('yellow', 'No packages matched current pattern(s).'));
	process.exit(0);
}

// Build up an index of local image urls per package.
const spinner = ora('Building up package image index').start();
const imagesByPackage = {};
const websiteByPackage = {};
const target = new Set(packages);
await traverse('**/*.yaml', (pkg) => {
	if (pkg.assetId) return;
	let id = `${pkg.group}:${pkg.name}`;
	if (!target.has(id)) return;
	imagesByPackage[id] = pkg.info?.images ?? [];
	websiteByPackage[id] = [pkg.info.website, ...(pkg.info.websites ?? [])].filter(Boolean);
});
spinner.succeed('Package image index built');

// Query STEX once per matched package and collect latest image urls.
const fetchSpinner = ora('Fetching image urls from STEX').start();
const remoteImagesByPackage = {};
const skipped = [];
for (let pkg of packages) {
	let website = websiteByPackage[pkg];
	if (!website) {
		skipped.push(pkg);
		continue;
	}
	let { uploads = [] } = await fetchFromStex({
		id: website,
		raw: true,
	});
	let images = uploads[0]?.images ?? [];
	if (images.length > 0) {
		remoteImagesByPackage[pkg] = images;
	}
}
fetchSpinner.succeed('Fetched remote image urls');

function arraysEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// Compute the packages with changed image urls.
const changed = [];
for (let pkg of packages) {
	let local = imagesByPackage[pkg] ?? [];
	let remote = remoteImagesByPackage[pkg];
	if (!remote) continue;
	if (arraysEqual(local, remote)) continue;
	changed.push({
		pkg,
		before: local.length,
		after: remote.length,
	});
}

console.log();
console.log(styleText('bold', 'Image URL fetch report'));
console.log(`Matched packages: ${packages.length}`);
console.log(`Packages with remote images: ${Object.keys(remoteImagesByPackage).length}`);
console.log(`Packages with changed images: ${changed.length}`);
if (skipped.length > 0) {
	console.log(styleText('yellow', `Skipped without parseable Simtropolis URL: ${skipped.length}`));
}
for (let row of changed.sort((a, b) => a.pkg.localeCompare(b.pkg))) {
	console.log(`- ${row.pkg} (${row.before} -> ${row.after} images)`);
}

// If the --force flag was specified, then we will actually update the images.
// It is advised not to do this before you created a commit so that you can
// see what changed.
if (argv.force || argv.f) {
	await traverse('**/*.yaml', (pkg) => {
		if (pkg.assetId) return;
		let id = `${pkg.group}:${pkg.name}`;
		let images = remoteImagesByPackage[id];
		if (!(images?.length > 0)) return;
		pkg.info ??= {};
		pkg.info.images = images;
		return pkg;
	});
} else {
	console.log(styleText('yellow', 'Preview only. Re-run with --force to write info.images updates.'));
}
