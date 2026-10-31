import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

// Executa os módulos reais com transporte isolado, sem gravar no backend.
export function runtime(fetch) {
  const context = vm.createContext({
    URL, URLSearchParams, Headers, Blob, File, FormData, TextDecoder, AbortController, AbortSignal, fetch,
    document: { cookie: 'XSRF-TOKEN=csrf%20test' },
  })
  const modules = new Map()
  const loading = new Map()
  async function load(url) {
    if (modules.has(url.href)) return modules.get(url.href)
    if (loading.has(url.href)) return loading.get(url.href)
    const promise = createModule(url)
    loading.set(url.href, promise)
    return promise
  }
  async function createModule(url) {
    const source = await readFile(url, 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    })
    const module = new vm.SourceTextModule(outputText, {
      context,
      identifier: url.href,
      initializeImportMeta(meta) { meta.env = { VITE_API_URL: 'http://localhost:8000/api' } },
    })
    modules.set(url.href, module)
    return module
  }
  return async (path) => {
    const module = await load(new URL(`../../src/${path}.ts`, import.meta.url))
    if (module.status === 'unlinked') await module.link((specifier, parent) => load(new URL(`${specifier}.ts`, parent.identifier)))
    if (module.status !== 'evaluated') await module.evaluate()
    return module.namespace
  }
}
