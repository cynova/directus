const { execSync } = require('child_process');
const { writeFileSync, mkdirSync } = require('fs');
const path = require('path/posix');

const lernaListResult = execSync('npx lerna list --scope directus --include-dependencies --json');

const list = JSON.parse(String(lernaListResult));
const apiPackageJSON = require(path.resolve(__dirname, '../api/package.json'));

const packageJSON = {
	name: 'directus-project',
	version: '1.0.0',
	description: 'Directus Project',
	dependencies: apiPackageJSON.optionalDependencies,
};

mkdirSync('dist');

list.forEach((package) => {
	const tarName = String(
		execSync(`npm pack ${package.location}`, { cwd: path.resolve(__dirname, '..', 'dist') })
	).trim();
	packageJSON.dependencies[package.name] = `file:${tarName}`;
});

writeFileSync(path.resolve(__dirname, '../dist/package.json'), JSON.stringify(packageJSON, null, 4));
