const { execSync } = require('child_process');
const { writeFileSync } = require('fs');

const lernaListResult = execSync('npx lerna list --scope directus --include-dependencies --json');

const list = JSON.parse(String(lernaListResult));
const apiPackageJSON = require('./api/package.json');

const packageJSON = {
	name: 'directus-project',
	version: '1.0.0',
	description: 'Directus Project',
	dependencies: apiPackageJSON.optionalDependencies,
};

list.forEach((package) => {
	const tarName = String(execSync(`npm pack ${package.location}`)).trim();
	packageJSON.dependencies[package.name] = `file:${tarName}`;
});

writeFileSync('./package.json', JSON.stringify(packageJSON, null, 4));
