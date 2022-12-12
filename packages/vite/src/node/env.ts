import fs from 'node:fs'
import { parse } from 'dotenv'
import { expand } from 'dotenv-expand'
import { arraify, lookupFile } from './utils'
import type { UserConfig } from './config'

export function loadEnv(
  mode: string,
  envDir: string,
  prefixes: string | string[] = 'VITE_',
): Record<string, string> {
  if (mode === 'local') {
    throw new Error(
      `"local" cannot be used as a mode name because it conflicts with ` +
        `the .local postfix for .env files.`,
    )
  }
  prefixes = arraify(prefixes)
  const env: Record<string, string> = {}
  const envFiles = [
    /** default file */ `.env`,
    /** local file */ `.env.local`,
    /** mode file */ `.env.${mode}`,
    /** mode local file */ `.env.${mode}.local`,
  ]

  const parsed = Object.fromEntries(
    envFiles.flatMap((file) => {
      const path = lookupFile(envDir, [file], {
        pathOnly: true,
        rootDir: envDir,
      })
      if (!path) return []
      return Object.entries(parse(fs.readFileSync(path)))
    }),
  )

  // test NODE_ENV override before expand as otherwise process.env.NODE_ENV would override this
  if (parsed.NODE_ENV && process.env.VITE_USER_NODE_ENV === undefined) {
    process.env.VITE_USER_NODE_ENV = parsed.NODE_ENV
  }

  try {
    // let environment variables use each other
    expand({ parsed })
  } catch (e) {
    // custom error handling until https://github.com/motdotla/dotenv-expand/issues/65 is fixed upstream
    // check for message "TypeError: Cannot read properties of undefined (reading 'split')"
    if (e.message.includes('split')) {
      throw new Error(
        'dotenv-expand failed to expand env vars. Maybe you need to escape `$`?',
      )
    }
    throw e
  }

  // only keys that start with prefix are exposed to client
  for (const [key, value] of Object.entries(parsed)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value
    }
  }

  // check if there are actual env variables starting with VITE_*
  // these are typically provided inline and should be prioritized
  for (const key in process.env) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = process.env[key] as string
    }
  }

  return env
}

export function resolveEnvPrefix({
  envPrefix = 'VITE_',
}: UserConfig): string[] {
  envPrefix = arraify(envPrefix)
  if (envPrefix.some((prefix) => prefix === '')) {
    throw new Error(
      `envPrefix option contains value '', which could lead unexpected exposure of sensitive information.`,
    )
  }
  return envPrefix
}
