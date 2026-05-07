const { app, BrowserWindow, ipcMain } = require('electron')
const { exec, spawn } = require('child_process')
const { generateKeyPairSync } = require('crypto')
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')

let win
let setupDone = false

const OLLAMA_PATHS = [
  '/usr/local/bin/ollama',
  '/usr/bin/ollama',
  '/opt/homebrew/bin/ollama',
  path.join(os.homedir(), '.ollama/bin/ollama'),
  '/Applications/Ollama.app/Contents/MacOS/ollama'
]

function findOllama() {
  for (const p of OLLAMA_PATHS) {
    if (fs.existsSync(p)) return p
  }
  try {
    const { execSync } = require('child_process')
    const p = execSync('which ollama 2>/dev/null', { encoding: 'utf8' }).trim()
    if (p && fs.existsSync(p)) return p
  } catch (_) {}
  return null
}

// Generate the Ed25519 identity key Ollama needs for registry auth.
// Ollama should create this itself but sometimes hasn't finished when we pull.
function ensureOllamaKey() {
  const dir = path.join(os.homedir(), '.ollama')
  const keyPath = path.join(dir, 'id_ed25519')
  if (fs.existsSync(keyPath)) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 })
  } catch (_) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#faf9f7',
    show: false
  })

  win.loadFile('loading.html')
  win.once('ready-to-show', () => win.show())
  ipcMain.on('minimize', () => win.minimize())
  ipcMain.on('close', () => win.close())
}

function isOllamaRunning() {
  return new Promise(resolve => {
    const req = http.get('http://localhost:11434', res => resolve(true))
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => { req.destroy(); resolve(false) })
  })
}

function startOllama(ollamaPath) {
  return new Promise(resolve => {
    const proc = spawn(ollamaPath, ['serve'], { detached: true, stdio: 'ignore' })
    proc.on('error', () => {})
    proc.unref()
    setTimeout(resolve, 1000)
  })
}

function waitForOllama(maxWaitMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    function check() {
      isOllamaRunning().then(ok => {
        if (ok) return resolve()
        if (Date.now() - start > maxWaitMs) return reject(new Error('ollama did not start (timed out)'))
        setTimeout(check, 1500)
      })
    }
    check()
  })
}

function downloadOllama(onProgress) {
  return new Promise((resolve, reject) => {
    const platform = os.platform()
    const urls = {
      darwin: 'https://ollama.com/download/Ollama-darwin.zip',
      win32: 'https://ollama.com/download/OllamaSetup.exe',
      linux: 'https://ollama.com/download/ollama-linux-amd64'
    }
    const url = urls[platform]
    if (!url) return reject(new Error('unsupported platform'))

    const ext = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.zip' : ''
    const dest = path.join(os.tmpdir(), `ollama-installer${ext}`)

    function doGet(targetUrl, redirects) {
      if (redirects > 10) return reject(new Error('too many redirects'))
      const mod = targetUrl.startsWith('https') ? https : http
      mod.get(targetUrl, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          return doGet(res.headers.location, redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`download failed: HTTP ${res.statusCode}`))
        }
        const total = parseInt(res.headers['content-length'], 10) || 0
        let downloaded = 0
        const file = fs.createWriteStream(dest)
        res.on('data', chunk => {
          downloaded += chunk.length
          const pct = total ? Math.round((downloaded / total) * 100) : 0
          onProgress(pct, downloaded, total)
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve(dest)))
        file.on('error', reject)
      }).on('error', reject)
    }

    doGet(url, 0)
  })
}

function installOllama(installerPath) {
  return new Promise((resolve, reject) => {
    const platform = os.platform()
    if (platform === 'darwin') {
      // unzip only — don't open the GUI app, we'll start serve directly
      exec(`unzip -o "${installerPath}" -d /Applications && xattr -dr com.apple.quarantine "/Applications/Ollama.app"`, err => {
        err ? reject(err) : resolve()
      })
    } else if (platform === 'win32') {
      exec(`"${installerPath}" /S`, err => err ? reject(err) : setTimeout(resolve, 6000))
    } else {
      exec(`chmod +x "${installerPath}" && sudo mv "${installerPath}" /usr/local/bin/ollama`, err => {
        err ? reject(err) : resolve()
      })
    }
  })
}

function pullModel(onStatus, onProgress) {
  return new Promise((resolve, reject) => {
    onStatus('downloading ai model (first time only, ~4gb)...')
    const body = JSON.stringify({ name: 'llama3', stream: true })
    const req = http.request({
      hostname: 'localhost', port: 11434, path: '/api/pull', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let buf = ''
      res.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const data = JSON.parse(line)
            if (data.error) return reject(new Error(data.error))
            if (data.status) {
              onStatus(data.status.slice(0, 60))
              if (data.completed && data.total) {
                onProgress(Math.round((data.completed / data.total) * 100))
              }
            }
          } catch (_) {}
        }
      })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function sendStatus(msg, progress = null, mode = 'indeterminate') {
  if (win && win.webContents) {
    win.webContents.send('status', { msg, progress, mode })
  }
}

async function setup() {
  try {
    sendStatus('checking ollama...', null, 'indeterminate')

    let running = await isOllamaRunning()
    let ollamaPath = findOllama()

    if (!running) {
      if (!ollamaPath) {
        sendStatus('downloading ollama...', 0, 'download')
        const installer = await downloadOllama((pct, dl, total) => {
          const mb = (dl / 1024 / 1024).toFixed(1)
          const totalMb = total ? (total / 1024 / 1024).toFixed(1) : '?'
          sendStatus(`downloading ollama... ${mb}mb / ${totalMb}mb`, pct, 'download')
        })
        sendStatus('installing ollama...', 100, 'download')
        await installOllama(installer)
        ollamaPath = findOllama()
        if (!ollamaPath) throw new Error('ollama not found after install')
      }

      sendStatus('starting ollama...', null, 'indeterminate')
      await startOllama(ollamaPath)
      sendStatus('waiting for ollama...', null, 'indeterminate')
      await waitForOllama(30000)
    }

    if (!ollamaPath) throw new Error('ollama not found on this system')

    fs.mkdirSync(path.join(os.homedir(), '.ollama', 'models'), { recursive: true })
    ensureOllamaKey()

    sendStatus('checking model...', null, 'indeterminate')
    const modelCheck = await new Promise(resolve => {
      http.get('http://localhost:11434/api/tags', res => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', () => resolve(''))
    })

    if (!modelCheck.includes('llama3')) {
      // retry up to 3 times in case ollama is still initializing
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await pullModel(
            msg => sendStatus(msg, null, 'indeterminate'),
            pct => sendStatus(`downloading model... ${pct}%`, pct, 'download')
          )
          break
        } catch (err) {
          if (attempt < 2) {
            sendStatus('retrying model download...', null, 'indeterminate')
            await new Promise(r => setTimeout(r, 3000))
          } else {
            throw err
          }
        }
      }
    }

    sendStatus('ready', 101, 'done')
    setTimeout(() => win.loadFile('index.html'), 800)

  } catch (err) {
    sendStatus('something went wrong: ' + err.message, null, 'error')
  }
}

app.whenReady().then(() => {
  createWindow()
  win.webContents.on('did-finish-load', () => {
    if (!setupDone) {
      setupDone = true
      setup()
    }
  })
  ipcMain.on('retry-setup', () => {
    setupDone = false
    setup()
  })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
