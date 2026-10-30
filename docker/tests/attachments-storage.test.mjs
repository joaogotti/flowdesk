import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, ...options })
}
const docker = (args, options) => run('docker', args, options)
const compose = ['compose', '--env-file', join(root, '.env.example'), '--project-directory', root, '-p', 'flowdesk-attachments-config-test']
const configOptions = { env: { ...process.env, DB_PASSWORD: 'isolated-config-test-only' } }

test('Compose keeps independent persistent data volumes and the backend bind mount', () => {
  const after = JSON.parse(docker([...compose, '-f', 'docker-compose.yml', 'config', '--format', 'json'], configOptions))
  const database = after.services.postgres.volumes.find(v => v.target === '/var/lib/postgresql/data')
  assert.equal(database.type, 'volume'); assert.equal(database.source, 'postgres_data')
  const mount = after.services.backend.volumes.find(v => v.target === '/var/www/html/storage/app/attachments')
  assert.equal(mount.type, 'volume')
  assert.equal(mount.source, 'attachments_data')
  assert.equal(Boolean(mount.read_only), false)
  assert.ok(after.volumes.attachments_data)
  assert.notEqual(after.volumes.attachments_data.name, after.volumes.postgres_data.name)
  assert.ok(after.services.backend.volumes.some(v => v.type === 'bind' && v.source === join(root, 'backend') && v.target === '/var/www/html'))
})

test('Git ignores attachment data without tracking or creating a real attachment', () => {
  for (const name of ['tickets/1/probe.pdf', 'verification/probe.txt', '.staging/probe.png']) {
    const path = 'backend/storage/app/attachments/' + name
    assert.equal(run('git', ['check-ignore', path]).trim(), path)
  }
  assert.equal(run('git', ['ls-files', '--', 'backend/storage/app/attachments']).trim(), '')
})

test('Private volume survives container replacement with correct PHP limits and no public HTTP access', {
  skip: process.env.FLOWDESK_RUN_DOCKER_TESTS !== '1', timeout: 300000,
}, () => {
  const guard = randomBytes(8).toString('hex'), prefix = 'flowdesk-attachments-test-' + guard
  const volume = prefix + '-data', image = prefix + ':local'
  const containers = new Set()
  let volumeCreated = false, imageCreated = false
  mkdirSync(join(root, '.tmp'), { recursive: true })
  const scratch = mkdtempSync(join(root, '.tmp', 'attachments-infra-'))
  assert.ok(existsSync(join(root, 'backend/vendor/autoload.php')), 'Local Composer dependencies are required; this test never installs them.')
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'backend']).split('\0').filter(Boolean)
  assert.ok(files.every(p => p.startsWith('backend/') && !/(^|\/)\.env$|\.(dump|sql|log)$/.test(p)))
  writeFileSync(join(scratch, 'files.txt'), files.join('\n') + '\n')
  run('tar', ['-cf', join(scratch, 'backend.tar'), '-T', join(scratch, 'files.txt')])
  const vendorArchive = process.env.FLOWDESK_TEST_VENDOR_ARCHIVE ? resolve(process.env.FLOWDESK_TEST_VENDOR_ARCHIVE) : join(scratch, 'vendor.tar')
  if (!process.env.FLOWDESK_TEST_VENDOR_ARCHIVE) run('tar', ['-cf', vendorArchive, '-C', 'backend/vendor', '.'])
  const vendorEntries = run('tar', ['-tf', vendorArchive]).split(/\r?\n/)
  assert.ok(vendorEntries.includes('./autoload.php') || vendorEntries.includes('autoload.php'), 'Vendor archive must contain autoload.php at its root.')
  function start(name) {
    assert.ok(name.startsWith(prefix))
    docker(['run', '-d', '--name', name, '--network', 'none', '-v', volume + ':/var/www/html/storage/app/attachments',
      '-e', 'APP_ENV=testing', '-e', 'APP_KEY=base64:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
      '-e', 'DB_CONNECTION=sqlite', '-e', 'DB_DATABASE=:memory:', '-e', 'DB_URL=',
      '-e', 'CACHE_STORE=array', '-e', 'SESSION_DRIVER=array', '-e', 'LOG_CHANNEL=stderr',
      '-e', 'FLOWDESK_ATTACHMENT_INFRA_TEST=' + guard, image, 'sleep', 'infinity'])
    containers.add(name)
    docker(['cp', join(scratch, 'backend.tar'), name + ':/tmp/backend.tar'])
    docker(['cp', vendorArchive, name + ':/tmp/vendor.tar'])
    docker(['exec', name, 'tar', '-xf', '/tmp/backend.tar', '--strip-components=1', '-C', '/var/www/html', 'backend'])
    docker(['exec', name, 'mkdir', '-p', '/var/www/html/vendor'])
    docker(['exec', name, 'tar', '-xf', '/tmp/vendor.tar', '-C', '/var/www/html/vendor'])
  }
  try {
    docker(['build', '--pull=false', '-t', image, '-f', 'docker/backend.dockerfile', '.'])
    imageCreated = true
    docker(['volume', 'create', volume]); volumeCreated = true
    const first = prefix + '-first', second = prefix + '-second'
    start(first)
    const written = JSON.parse(docker(['exec', first, 'php', 'tests/Support/attachment-storage-probe.php', 'write']))
    assert.equal(written.root_mode, '700'); assert.equal(written.file_mode, '600'); assert.equal(written.directory_mode, '700')
    assert.equal(written.temporary_urls, false)
    assert.equal(written.upload_max_filesize, '5M'); assert.equal(written.post_max_size, '8M'); assert.equal(written.max_file_uploads, '1')
    docker(['rm', '-f', first]); containers.delete(first)
    start(second)
    const restored = JSON.parse(docker(['exec', second, 'php', 'tests/Support/attachment-storage-probe.php', 'read']))
    assert.deepEqual({ ...restored, urls: [] }, { ...written, urls: [] })
    docker(['exec', second, 'php', 'artisan', 'storage:link'])
    docker(['exec', '-d', second, 'php', 'artisan', 'serve', '--host=127.0.0.1', '--port=8000'])
    let ready = false
    for (let i = 0; i < 40; i++) {
      const probe = spawnSync('docker', ['exec', second, 'php', '-r', "exit(@file_get_contents('http://127.0.0.1:8000/api/health') === false ? 1 : 0);"], { timeout: 5000 })
      if (probe.status === 0) { ready = true; break }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    assert.equal(ready, true)
    for (const url of restored.urls) {
      const code = `<?php $context=stream_context_create(['http'=>['ignore_errors'=>true,'timeout'=>3]]); $body=file_get_contents(${JSON.stringify('http://127.0.0.1:8000' + url)},false,$context); preg_match('/HTTP\\/\\S+ (\\d+)/',$http_response_header[0],$match); echo json_encode(['status'=>(int)$match[1],'leaked'=>str_contains($body,'isolated-${guard}')]);`
      const response = JSON.parse(docker(['exec', '-i', second, 'php'], { input: code }))
      assert.ok([403, 404].includes(response.status), `${url}: ${response.status}`)
      assert.equal(response.leaked, false)
    }
  } finally {
    for (const name of containers) docker(['rm', '-f', name])
    if (volumeCreated) docker(['volume', 'rm', volume])
    if (imageCreated) docker(['image', 'rm', image])
  }
})
