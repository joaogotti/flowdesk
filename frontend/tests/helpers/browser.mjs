import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

export const browserExecutable = [
  process.env.FLOWDESK_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path))

// Navegador isolado: o transporte é interceptado antes da aplicação iniciar.
export async function openBrowser(script) {
  const profile = await mkdtemp(join(tmpdir(), 'flowdesk-comments-browser-'))
  let server, browser, socket
  const pending = new Map()
  let sequence = 0
  const errors = []
  async function close() {
    socket?.close()
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve))
      browser.kill()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
    }
    await server?.close()
    const target = resolve(profile)
    if (target.startsWith(resolve(tmpdir()) + sep) && target.includes('flowdesk-comments-browser-')) {
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
  try {
    server = await createServer({
      root: fileURLToPath(new URL('../../', import.meta.url)),
      cacheDir: join(profile, 'vite-cache'),
      envFile: false,
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://flowdesk.test/api') },
      server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
    })
    await server.listen()
    browser = spawn(browserExecutable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(Error('Chrome não iniciou em 15 segundos')), 15000)
      browser.once('error', error => { clearTimeout(timer); reject(error) })
      browser.stderr.on('data', chunk => {
        output += chunk
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
    })
    const port = new URL(endpoint).port
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const request = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) request.reject(Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params)
    }
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 15000)
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const wait = async expression => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      throw Error(`Condição não satisfeita: ${expression}\n${JSON.stringify(await evaluate('({posts:window.commentTest?.posts, gets:window.commentTest?.gets, text:document.body.innerText.slice(-2200)})'))}`)
    }
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: script })
    const baseUrl = server.resolvedUrls.local[0]
    return { send, evaluate, wait, errors, close, baseUrl }
  } catch (error) { await close(); throw error }
}
