// # patch-metadata.js
import * as dot from 'dot-prop';

// This function takes the main package metadata as generated from the STEX, and 
// then applies the user-defined metadata as a patch to it. Note that it's 
// possible that the user has specified multiple packages.
export default function patchMetadata(metadata, patch) {

	// If nothing needs to be patched, just return the package as is.
	if (!patch) {
		return [metadata.package];
	}

	// We first have to figure out what the "main package" of the user-defined 
	// metadata is, because the parsed dependencies and variants from the api 
	// should only be applied to the main package.
	let main = findMainPackage(patch);
	return [patch]
		.flat()
		.map(patch => applyPatch(metadata.package, patch, {
			main: patch === main,
		}))
		.map(pkg => fill(pkg, metadata));

}

// # applyPatch(apiPackage, usePackage, opts)
// Completes the user-defined metadata with the information found in the stex 
// and returns it.
function applyPatch(apiPackage, userPackage, opts = {}) {
	apiPackage = { ...apiPackage };
	userPackage = { ...userPackage };
	if (Object.hasOwn(userPackage, 'main')) {
		delete userPackage.main;
	}

	// If this is not the main package, we *never* patch the variants or 
	// dependencies.
	if (!opts.main) {
		delete apiPackage.variants;
		delete apiPackage.dependencies;
	}
	return {
		...apiPackage,
		...userPackage,
		info: {
			...apiPackage.info,
			...userPackage.info,
		},
	};
}

// # fill(value)
// The function that recursively loops the given object and interpolates any 
// variables used in the text.
function fill(value, metadata) {
	if (typeof value === 'string') {
		return interpolate(value, metadata);
	} else if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			value[i] = fill(value[i], metadata);
		}
		return value;
	} else if (value !== null && typeof value === 'object') {
		for (let key of Object.keys(value)) {
			value[key] = fill(value[key], metadata);
		}
		return value;
	} else {
		return value;
	}
}

// # interpolate(str)
function interpolate(str, metadata) {
	let tokens = lex(str);
	return tokens.map(token => {
		if (token.type === 'literal') {
			return token.value;
		} else if (token.type === 'interpolation') {
			let path = token.value.replaceAll(/\.(\d+)/g, '[$1]');
			let value = dot.getProperty(metadata, path);
			return value ?? '';
		} else {
			return '';
		}
	}).join('');
}

// # lex(input)
function lex(input) {
	const regex = /\$\{\{(.*?)\}\}/g;
	let result = [];
	let lastIndex = 0;

	let match;
	while ((match = regex.exec(input)) !== null) {
		if (match.index > lastIndex) {
			result.push({
				type: 'literal',
				value: input.slice(lastIndex, match.index),
			});
		}
		result.push({
			type: 'interpolation',
			value: match[1].trim(),
		});
		lastIndex = regex.lastIndex;
	}

	// Add any remaining literal text
	if (lastIndex < input.length) {
		result.push({
			type: 'literal',
			value: input.slice(lastIndex),
		});
	}

	return result;
}

// # findMainPackage(patch)
// Finds the main package to patch
function findMainPackage(patch) {

	// In case there's only 1 patch, obviously this is the main patch object.
	if (!Array.isArray(patch)) {
		return patch;
	} else if (patch.length === 1) {
		return patch[0];
	}

	// At this point we know that there are multiple packages to patch. In order 
	// to find the "main" package, we have several strategies. If a package has 
	// no specific name given, then this is the main package. Otherwise it can 
	// also be labeled as "main".
	return (
		patch.find(pkg => !Object.hasOwn(pkg, 'name')) ||
		patch.find(pkg => pkg.main === true)
	);

}
