import express, { Router } from 'express';
import path from 'path';
import { AppExtensionType, Extension, ExtensionType } from '@directus/shared/types';
import {
	ensureExtensionDirs,
	generateExtensionsEntry,
	getLocalExtensions,
	getPackageExtensions,
	resolvePackage,
} from '@directus/shared/utils/node';
import {
	API_EXTENSION_PACKAGE_TYPES,
	API_EXTENSION_TYPES,
	APP_EXTENSION_TYPES,
	APP_SHARED_DEPS,
	EXTENSION_PACKAGE_TYPES,
	EXTENSION_TYPES,
} from '@directus/shared/constants';
import getDatabase from './database';
import emitter from './emitter';
import env from './env';
import * as exceptions from './exceptions';
import logger from './logger';
import { HookConfig, EndpointConfig } from './types';
import fse from 'fs-extra';
import { getSchema } from './utils/get-schema';

import * as services from './services';
import { schedule, ScheduledTask, validate } from 'node-cron';
import { rollup } from 'rollup';
// @TODO Remove this once a new version of @rollup/plugin-virtual has been released
// @ts-expect-error
import virtual from '@rollup/plugin-virtual';
import alias from '@rollup/plugin-alias';
import { Url } from './utils/url';
import getModuleDefault from './utils/get-module-default';
import chokidar from 'chokidar';

let extensions: Extension[] = [];
let extensionBundles: Partial<Record<AppExtensionType, string>> = {};

export async function initializeExtensions(): Promise<void> {
	try {
		await ensureExtensionDirs(env.EXTENSIONS_PATH, env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES);
		extensions = await getExtensions();
	} catch (err: any) {
		logger.warn(`Couldn't load extensions`);
		logger.warn(err);
	}

	if (env.SERVE_APP) {
		extensionBundles = await generateExtensionBundles();
	}

	const loadedExtensions = listExtensions();
	if (loadedExtensions.length > 0) {
		logger.info(`Loaded extensions: ${loadedExtensions.join(', ')}`);
	}
}

export function listExtensions(type?: ExtensionType): string[] {
	if (type === undefined) {
		return extensions.map((extension) => extension.name);
	} else {
		return extensions.filter((extension) => extension.type === type).map((extension) => extension.name);
	}
}

export function getAppExtensionSource(type: AppExtensionType): string | undefined {
	return extensionBundles[type];
}

export function registerExtensionEndpoints(router: Router): void {
	const endpoints = extensions.filter((extension) => extension.type === 'endpoint');
	registerEndpoints(endpoints, router);
}

export function registerExtensionHooks(): void {
	const hooks = extensions.filter((extension) => extension.type === 'hook');
	registerHooks(hooks);
}

async function getExtensions(): Promise<Extension[]> {
	const packageExtensions = await getPackageExtensions(
		'.',
		env.SERVE_APP ? EXTENSION_PACKAGE_TYPES : API_EXTENSION_PACKAGE_TYPES
	);
	const localExtensions = await getLocalExtensions(
		env.EXTENSIONS_PATH,
		env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES
	);

	return [...packageExtensions, ...localExtensions];
}

async function generateExtensionBundles() {
	const sharedDepsMapping = await getSharedDepsMapping(APP_SHARED_DEPS);
	const internalImports = Object.entries(sharedDepsMapping).map(([name, path]) => ({
		find: name,
		replacement: path,
	}));

	const bundles: Partial<Record<AppExtensionType, string>> = {};

	for (const extensionType of APP_EXTENSION_TYPES) {
		const entry = generateExtensionsEntry(extensionType, extensions);

		const bundle = await rollup({
			input: 'entry',
			external: Object.values(sharedDepsMapping),
			makeAbsoluteExternalsRelative: false,
			plugins: [virtual({ entry }), alias({ entries: internalImports })],
		});
		const { output } = await bundle.generate({ format: 'es', compact: true });

		bundles[extensionType] = output[0].code;

		await bundle.close();
	}

	return bundles;
}

async function getSharedDepsMapping(deps: string[]) {
	const appDir = await fse.readdir(path.join(resolvePackage('@directus/app'), 'dist'));

	const depsMapping: Record<string, string> = {};
	for (const dep of deps) {
		const depName = appDir.find((file) => dep.replace(/\//g, '_') === file.substring(0, file.indexOf('.')));

		if (depName) {
			const depUrl = new Url(env.PUBLIC_URL).addPath('admin', depName);

			depsMapping[dep] = depUrl.toString({ rootRelative: true });
		} else {
			logger.warn(`Couldn't find shared extension dependency "${dep}"`);
		}
	}

	return depsMapping;
}

function registerHooks(hooks: Extension[]) {
	const registeredHooks: [string, () => void][] = [];
	const registeredCronTasks: ScheduledTask[] = [];

	for (const hook of hooks) {
		try {
			registerHook(hook);
			if (process.env.NODE_ENV === 'development' && hook.source) {
				const watcher = chokidar.watch(path.resolve(hook.path, hook.source));
				watcher.on('change', () => {
					try {
						registerHook(hook);
						logger.info(`Reloaded hook "${hook.name}"`);
					} catch (error: any) {
						logger.warn(`Couldn't reload hook "${hook.name}"`);
						logger.warn(error);
					}
				});
			}
		} catch (error: any) {
			logger.warn(`Couldn't register hook "${hook.name}"`);
			logger.warn(error);
		}
	}

	function registerHook(hook: Extension) {
		const hookPath = path.resolve(
			hook.path,
			(process.env.NODE_ENV === 'development' ? hook.source : hook.entrypoint) || ''
		);
		delete require.cache[require.resolve(hookPath)];
		const hookInstance: HookConfig | { default: HookConfig } = require(hookPath);

		const register = getModuleDefault(hookInstance);

		const events = register({ services, exceptions, env, database: getDatabase(), logger, getSchema });

		let item;
		while ((item = registeredHooks.pop())) {
			emitter.off(item[0], item[1]);
		}
		while ((item = registeredCronTasks.pop())) {
			item.destroy();
		}

		for (const [event, handler] of Object.entries(events)) {
			if (event.startsWith('cron(')) {
				const cron = event.match(/\(([^)]+)\)/)?.[1];

				if (!cron || validate(cron) === false) {
					logger.warn(`Couldn't register cron hook. Provided cron is invalid: ${cron}`);
				} else {
					const task = schedule(cron, handler);
					registeredCronTasks.push(task);
				}
			} else {
				emitter.on(event, handler);
				registeredHooks.push([event, handler]);
			}
		}
	}
}

const scopedRouters: { [key: string]: Router } = {};
function registerScopedRouter(scope: string, router: Router, scopedRouter: Router) {
	if (!scopedRouters[scope]) {
		router.use(scope, (req, res, next) => {
			scopedRouters[scope](req, res, next);
		});
	}
	scopedRouters[scope] = scopedRouter;
}

function registerEndpoints(endpoints: Extension[], router: Router) {
	for (const endpoint of endpoints) {
		try {
			registerEndpoint(endpoint);
			if (process.env.NODE_ENV === 'development' && endpoint.source) {
				const watcher = chokidar.watch(path.resolve(endpoint.path, endpoint.source));
				watcher.on('change', () => {
					try {
						registerEndpoint(endpoint);
						logger.info(`Reloaded endpoint "${endpoint.name}"`);
					} catch (error: any) {
						logger.warn(`Couldn't reload endpoint "${endpoint.name}"`);
						logger.warn(error);
					}
				});
			}
		} catch (error: any) {
			logger.warn(`Couldn't register endpoint "${endpoint.name}"`);
			logger.warn(error);
		}
	}

	function registerEndpoint(endpoint: Extension) {
		const endpointPath = path.resolve(
			endpoint.path,
			(process.env.NODE_ENV === 'development' ? endpoint.source : endpoint.entrypoint) || ''
		);
		delete require.cache[require.resolve(endpointPath)];
		const endpointInstance: EndpointConfig | { default: EndpointConfig } = require(endpointPath);

		const mod = getModuleDefault(endpointInstance);

		const register = typeof mod === 'function' ? mod : mod.handler;
		const pathName = typeof mod === 'function' ? endpoint.name : mod.id;

		const scopedRouter = express.Router();
		registerScopedRouter(`/${pathName}`, router, scopedRouter);

		register(scopedRouter, { services, exceptions, env, database: getDatabase(), logger, getSchema });
	}
}
