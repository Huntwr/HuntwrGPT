const { app, BrowserWindow, ipcMain } = require('electron')
const { exec, spawn } = require('child_process')
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')

let win
let setupDone = false

// common places ollama gets installed
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
  return null
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
    proc.unref()
    setTimeout(resolve, 3000)
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
    const file = fs.createWriteStream(dest)

    https.get(url, res => {
      const total = parseInt(res.headers['content-length'], 10)
      let downloaded = 0
      res.on('data', chunk => {
        downloaded += chunk.length
        const pct = Math.round((downloaded / total) * 100)
        onProgress(pct, downloaded, total)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve(dest)))
    }).on('error', reject)
  })
}

function installOllama(installerPath) {
  return new Promise((resolve, reject) => {
    const platform = os.platform()
    if (platform === 'darwin') {
      exec(`unzip -o "${installerPath}" -d /Applications && xattr -dr com.apple.quarantine /Applications/Ollama.app`, err => {
        if (err) return reject(err)
        exec('open /Applications/Ollama.app', () => setTimeout(resolve, 4000))
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

function pullModel(ollamaPath, onStatus, onProgress) {
  return new Promise((resolve, reject) => {
    onStatus('downloading ai model (first time only, ~4gb)...')
    const proc = spawn(ollamaPath, ['pull', 'llama3'])
    proc.stdout.on('data', d => {
      const line = d.toString().trim()
      const match = line.match(/(\d+)%/)
      if (match) onProgress(parseInt(match[1]))
      onStatus(line.slice(0, 60))
    })
    proc.stderr.on('data', d => {
      const line = d.toString().trim()
      const match = line.match(/(\d+)%/)
      if (match) onProgress(parseInt(match[1]))
      onStatus(line.slice(0, 60))
    })
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('pull failed')))
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

    const running = await isOllamaRunning()
    let ollamaPath = findOllama()

    if (!running) {
      if (!ollamaPath) {
        sendStatus('downloading ollama...', 0, 'download')
        const installer = await downloadOllama((pct, dl, total) => {
          const mb = (dl / 1024 / 1024).toFixed(1)
          const totalMb = (total / 1024 / 1024).toFixed(1)
          sendStatus(`downloading ollama... ${mb}mb / ${totalMb}mb`, pct, 'download')
        })
        sendStatus('installing ollama...', 100, 'download')
        await installOllama(installer)
        ollamaPath = findOllama()
      }

      if (!ollamaPath) throw new Error('ollama not found after install')

      sendStatus('starting ollama...', null, 'indeterminate')
      await startOllama(ollamaPath)
    }

    if (!ollamaPath) throw new Error('ollama not found on this system')

    sendStatus('checking model...', null, 'indeterminate')
    const modelCheck = await new Promise(resolve => {
      exec(`"${ollamaPath}" list`, (err, stdout) => resolve(stdout || ''))
    })

    if (!modelCheck.includes('llama3')) {
      await pullModel(
        ollamaPath,
        msg => sendStatus(msg, null, 'indeterminate'),
        pct => sendStatus(`downloading model... ${pct}%`, pct, 'download')
      )
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
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })