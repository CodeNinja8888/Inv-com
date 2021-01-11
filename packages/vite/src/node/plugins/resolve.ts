import fs from 'fs'
import path from 'path'
import { Plugin } from '../plugin'
import chalk from 'chalk'
import { FS_PREFIX, SUPPORTED_EXTS } from '../constants'
import {
  bareImportRE,
  createDebugger,
  deepImportRE,
  injectQuery,
  isExternalUrl,
  isObject,
  normalizePath,
  fsPathFromId,
  resolveFrom,
  isDataUrl
} from '../utils'
import { ResolvedConfig, ViteDevServer } from '..'
import slash from 'slash'
import { createFilter } from '@rollup/pluginutils'
import { PartialResolvedId } from 'rollup'
import isBuiltin from 'isbuiltin'
import { isCSSRequest } from './css'

const mainFields = ['module', 'main']

// special id for paths marked with browser: false
// https://github.com/defunctzombie/package-browser-field-spec#ignore-a-module
const browserExternalId = '__browser-external'

const isDebug = process.env.DEBUG
const debug = createDebugger('vite:resolve-details', {
  onlyWhenFocused: true
})

interface ResolveOptions {
  root: string
  isBuild: boolean
  /**
   * src code mode also attempts the following:
   * - resolving /xxx as URLs
   * - resolving bare imports from optimized deps
   */
  asSrc: boolean
  dedupe?: string[]
}

export function resolvePlugin({
  root,
  isBuild,
  asSrc,
  dedupe
}: ResolveOptions): Plugin {
  let config: ResolvedConfig | undefined
  let server: ViteDevServer | undefined

  return {
    name: 'vite:resolve',

    configureServer(_server) {
      server = _server
    },

    configResolved(_config) {
      config = _config
    },

    resolveId(id, importer) {
      if (id === browserExternalId) {
        return id
      }

      // fast path for commonjs proxy modules
      if (/\?commonjs/.test(id) || id === 'commonjsHelpers.js') {
        return
      }

      let res

      // explicit fs paths that starts with /@fs/*
      if (asSrc && id.startsWith(FS_PREFIX)) {
        const fsPath = fsPathFromId(id)
        res = tryFsResolve(fsPath, false)
        isDebug && debug(`[@fs] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
        // always return here even if res doesn't exist since /@fs/ is explicit
        // if the file doesn't exist it should be a 404
        return res || fsPath
      }

      // URL
      // /foo -> /fs-root/foo
      if (asSrc && id.startsWith('/')) {
        const fsPath = path.resolve(root, id.slice(1))
        if ((res = tryFsResolve(fsPath))) {
          isDebug && debug(`[url] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
          return res
        }
      }

      // relative
      if (id.startsWith('.')) {
        const basedir = importer ? path.dirname(importer) : process.cwd()
        let fsPath = path.resolve(basedir, id)
        // handle browser field mapping for relative imports
        const pkg = importer && idToPkgMap.get(importer)
        if (pkg && isObject(pkg.data.browser)) {
          const pkgRelativePath = './' + slash(path.relative(pkg.dir, fsPath))
          const browserMappedPath = mapWithBrowserField(
            pkgRelativePath,
            pkg.data.browser
          )
          if (browserMappedPath) {
            fsPath = path.resolve(pkg.dir, browserMappedPath)
          } else {
            return browserExternalId
          }
        }
        if ((res = tryFsResolve(fsPath))) {
          isDebug && debug(`[relative] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
          if (pkg) {
            idToPkgMap.set(res, pkg)
            return {
              id: res,
              moduleSideEffects: pkg.hasSideEffects(res)
            }
          }
          return res
        }
      }

      // absolute fs paths
      if (path.isAbsolute(id) && (res = tryFsResolve(id))) {
        isDebug && debug(`[fs] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
        return res
      }

      // external
      if (isExternalUrl(id)) {
        return {
          id,
          external: true
        }
      }

      // data uri: pass through (this only happens during build and will be
      // handled by dedicated plugin)
      if (isDataUrl(id)) {
        return null
      }

      // bare package imports, perform node resolve
      if (bareImportRE.test(id)) {
        if (asSrc && server && (res = tryOptimizedResolve(id, server))) {
          return res
        }

        if (
          (res = tryNodeResolve(
            id,
            importer ? path.dirname(importer) : root,
            isBuild,
            dedupe,
            root,
            server
          ))
        ) {
          return res
        }

        // node built-ins.
        // externalize if building for SSR, otherwise redirect to empty module
        if (isBuiltin(id)) {
          if (isBuild && config && config.build.ssr) {
            return {
              id,
              external: true
            }
          } else {
            this.warn(
              `externalized node built-in "${id}" to empty module. ` +
                `(imported by: ${chalk.white.dim(importer)})`
            )
            return browserExternalId
          }
        }
      }

      isDebug && debug(`[fallthrough] ${chalk.dim(id)}`)
    },

    load(id) {
      if (id === browserExternalId) {
        return `export default {}`
      }
    }
  }
}

function tryFsResolve(fsPath: string, tryIndex = true): string | undefined {
  const [file, q] = fsPath.split(`?`, 2)
  const query = q ? `?${q}` : ``
  let res: string | undefined
  if ((res = tryResolveFile(file, query, tryIndex))) {
    return res
  }
  for (const ext of SUPPORTED_EXTS) {
    if ((res = tryResolveFile(file + ext, query, tryIndex))) {
      return res
    }
  }
}

function tryResolveFile(
  file: string,
  query: string,
  tryIndex: boolean
): string | undefined {
  if (fs.existsSync(file)) {
    const isDir = fs.statSync(file).isDirectory()
    if (isDir) {
      if (tryIndex) {
        const index = tryFsResolve(file + '/index', false)
        if (index) return normalizePath(index) + query
      }
      const pkgPath = file + '/package.json'
      if (fs.existsSync(pkgPath)) {
        // path points to a node package
        const pkg = loadPackageData(pkgPath)
        return resolvePackageEntry(file, pkg)
      }
    } else {
      return normalizePath(file) + query
    }
  }
}

export const idToPkgMap = new Map<string, PackageData>()

export function tryNodeResolve(
  id: string,
  basedir: string,
  isBuild = true,
  dedupe?: string[],
  dedupeRoot?: string,
  server?: ViteDevServer
): PartialResolvedId | undefined {
  const deepMatch = id.match(deepImportRE)
  const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : id

  if (dedupe && dedupeRoot && dedupe.includes(pkgId)) {
    basedir = dedupeRoot
  }

  const pkg = resolvePackageData(pkgId, basedir)

  if (!pkg) {
    return
  }

  // prevent deep imports to optimized deps.
  if (
    deepMatch &&
    server &&
    server.optimizeDepsMetadata &&
    pkg.data.name in server.optimizeDepsMetadata.map &&
    !isCSSRequest(id) &&
    !server.config.assetsInclude(id)
  ) {
    throw new Error(
      chalk.yellow(
        `Deep import "${chalk.cyan(
          id
        )}" should be avoided because dependency "${chalk.cyan(
          pkg.data.name
        )}" has been pre-optimized. Prefer importing directly from the module entry:\n\n` +
          `${chalk.green(`import { ... } from "${pkg.data.name}"`)}\n\n` +
          `If the used import is not exported from the package's main entry ` +
          `and can only be attained via deep import, you can explicitly add ` +
          `the deep import path to "optimizeDeps.include" in vite.config.js.`
      )
    )
  }

  let resolved = deepMatch
    ? resolveDeepImport(id, pkg)
    : resolvePackageEntry(id, pkg)
  if (!resolved) {
    return
  }
  // link id to pkg for browser field mapping check
  idToPkgMap.set(resolved, pkg)
  if (isBuild) {
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    return {
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved)
    }
  } else {
    // During serve, inject a version query to npm deps so that the browser
    // can cache it without revalidation. Make sure to apply this only to
    // files actually inside node_modules so that locally linked packages
    // in monorepos are not cached this way.
    if (resolved.includes('node_modules')) {
      const versionHash = server?.optimizeDepsMetadata?.hash
      if (versionHash) {
        resolved = injectQuery(resolved, `v=${versionHash}`)
      }
    }
    return { id: resolved }
  }
}

function tryOptimizedResolve(
  rawId: string,
  server: ViteDevServer
): string | undefined {
  const cacheDir = server.config.optimizeCacheDir
  const depData = server.optimizeDepsMetadata
  if (cacheDir && depData) {
    const [id, q] = rawId.split(`?`, 2)
    const query = q ? `?${q}` : ``
    const filePath = depData.map[id]
    if (filePath) {
      return normalizePath(path.resolve(cacheDir, filePath)) + query
    }
  }
}

export interface PackageData {
  dir: string
  hasSideEffects: (id: string) => boolean
  resolvedImports: Record<string, string | undefined>
  data: {
    [field: string]: any
    version: string
    main: string
    module: string
    browser: string | Record<string, string | false>
    exports: string | Record<string, any> | string[]
    dependencies: Record<string, string>
  }
}

const packageCache = new Map<string, PackageData>()

export function resolvePackageData(
  id: string,
  basedir: string
): PackageData | undefined {
  const cacheKey = id + basedir
  if (packageCache.has(cacheKey)) {
    return packageCache.get(cacheKey)
  }
  try {
    const pkgPath = resolveFrom(`${id}/package.json`, basedir)
    return loadPackageData(pkgPath, cacheKey)
  } catch (e) {
    isDebug && debug(`${chalk.red(`[failed loading package.json]`)} ${id}`)
  }
}

function loadPackageData(pkgPath: string, cacheKey = pkgPath) {
  const data = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const pkgDir = path.dirname(pkgPath)
  const { sideEffects } = data
  let hasSideEffects
  if (typeof sideEffects === 'boolean') {
    hasSideEffects = () => sideEffects
  } else if (Array.isArray(sideEffects)) {
    hasSideEffects = createFilter(sideEffects, null, { resolve: pkgDir })
  } else {
    hasSideEffects = () => true
  }

  const pkg = {
    dir: pkgDir,
    data,
    hasSideEffects,
    resolvedImports: {}
  }
  packageCache.set(cacheKey, pkg)
  return pkg
}

export function resolvePackageEntry(
  id: string,
  { resolvedImports, dir, data }: PackageData
): string | undefined {
  if (resolvedImports['.']) {
    return resolvedImports['.']
  }

  let entryPoint: string | undefined

  // resolve exports field with highest priority
  // https://nodejs.org/api/packages.html#packages_package_entry_points
  const { exports: exportsField } = data
  if (exportsField) {
    entryPoint = resolveConditionalExports(exportsField, '.')
  }

  if (!entryPoint) {
    // check browser field
    // https://github.com/defunctzombie/package-browser-field-spec
    const browserEntry =
      typeof data.browser === 'string'
        ? data.browser
        : isObject(data.browser) && data.browser['.']
    if (browserEntry) {
      // check if the package also has a "module" field.
      if (typeof data.module === 'string' && data.module !== browserEntry) {
        // if both are present, we may have a problem: some package points both
        // to ESM, with "module" targeting Node.js, while some packages points
        // "module" to browser ESM and "browser" to UMD.
        // the heuristics here is to actually read the browser entry when
        // possible and check for hints of UMD. If it is UMD, prefer "module"
        // instead; Otherwise, assume it's ESM and use it.
        const resolvedBrowserEntry = tryFsResolve(
          path.resolve(dir, browserEntry)
        )
        if (resolvedBrowserEntry) {
          const content = fs.readFileSync(resolvedBrowserEntry, 'utf-8')
          if (
            (/typeof exports\s*==/.test(content) &&
              /typeof module\s*==/.test(content)) ||
            /module\.exports\s*=/.test(content)
          ) {
            // likely UMD or CJS(!!! e.g. firebase 7.x), prefer module
            entryPoint = data.module
          }
        }
      } else {
        entryPoint = browserEntry
      }
    }
  }

  if (!entryPoint) {
    for (const field of mainFields) {
      if (typeof data[field] === 'string') {
        entryPoint = data[field]
        break
      }
    }
  }

  entryPoint = entryPoint || 'index.js'

  // resolve object browser field in package.json
  const { browser: browserField } = data
  if (isObject(browserField)) {
    entryPoint = mapWithBrowserField(entryPoint, browserField) || entryPoint
  }

  entryPoint = path.resolve(dir, entryPoint)
  const resolvedEntryPont = tryFsResolve(entryPoint)

  if (resolvedEntryPont) {
    isDebug &&
      debug(
        `[package entry] ${chalk.cyan(id)} -> ${chalk.dim(resolvedEntryPont)}`
      )
    resolvedImports['.'] = resolvedEntryPont
    return resolvedEntryPont
  } else {
    throw new Error(
      `Failed to resolve entry for package "${id}". ` +
        `The package may have incorrect main/module/exports specified in its package.json.`
    )
  }
}

function resolveDeepImport(
  id: string,
  { resolvedImports, dir, data }: PackageData
): string | undefined {
  id = '.' + id.slice(data.name.length)
  if (resolvedImports[id]) {
    return resolvedImports[id]
  }

  let relativeId: string | undefined = id
  const { exports: exportsField, browser: browserField } = data

  // map relative based on exports data
  if (exportsField) {
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      relativeId = resolveConditionalExports(exportsField, relativeId)
    } else {
      // not exposed
      relativeId = undefined
    }
    if (!relativeId) {
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, 'package.json')}.`
      )
    }
  } else if (isObject(browserField)) {
    const mapped = mapWithBrowserField(relativeId, browserField)
    if (mapped) {
      relativeId = mapped
    } else {
      return (resolvedImports[id] = browserExternalId)
    }
  }

  if (relativeId) {
    const resolved = tryFsResolve(path.resolve(dir, relativeId), !exportsField)
    if (resolved) {
      isDebug &&
        debug(`[node/deep-import] ${chalk.cyan(id)} -> ${chalk.dim(resolved)}`)
      return (resolvedImports[id] = resolved)
    }
  }
}

const ENV_KEYS = [
  'esmodules',
  'import',
  'module',
  'require',
  'browser',
  'node',
  'default'
]

// https://nodejs.org/api/packages.html
// TODO: subpath imports & subpath patterns
function resolveConditionalExports(exp: any, id: string): string | undefined {
  if (typeof exp === 'string') {
    return exp
  } else if (isObject(exp)) {
    let isFileListing: boolean | undefined
    let fallback: string | undefined
    for (const key in exp) {
      if (isFileListing === undefined) {
        isFileListing = key[0] === '.'
      }
      if (isFileListing) {
        if (key === id) {
          return resolveConditionalExports(exp[key], id)
        } else if (key.endsWith('/') && id.startsWith(key)) {
          // mapped directory
          const replacement = resolveConditionalExports(exp[key], id)
          return replacement && id.replace(key, replacement)
        }
      } else if (ENV_KEYS.includes(key)) {
        // https://github.com/vitejs/vite/issues/1418
        // respect env key order
        // but intentionally de-prioritize "require" and "default" keys
        if (key === 'require' || key === 'default') {
          if (!fallback) fallback = key
        } else {
          return resolveConditionalExports(exp[key], id)
        }
      }
      if (fallback) {
        return resolveConditionalExports(exp[key], id)
      }
    }
  } else if (Array.isArray(exp)) {
    for (let i = 0; i < exp.length; i++) {
      const res = resolveConditionalExports(exp[i], id)
      if (res) return res
    }
  }
}

/**
 * given a relative path in pkg dir,
 * return a relative path in pkg dir,
 * mapped with the "map" object
 */
function mapWithBrowserField(
  relativePathInPkgDir: string,
  map: Record<string, string | false>
) {
  const normalized = normalize(relativePathInPkgDir)
  const foundEntry = Object.entries(map).find(
    ([from]) => normalize(from) === normalized
  )
  if (!foundEntry) {
    return relativePathInPkgDir
  }
  return foundEntry[1]
}

function normalize(file: string) {
  return path.posix.normalize(path.extname(file) ? file : file + '.js')
}
