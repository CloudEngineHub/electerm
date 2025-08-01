/**
 * terminal/sftp/serial class
 */

const proxySock = require('./socks')
const _ = require('lodash')
const generate = require('../common/uid')
const { resolve: pathResolve } = require('path')
const net = require('net')
const { exec } = require('child_process')
const log = require('../common/log')
const { algDefault, algAlt } = require('./ssh2-alg')
const sshTunnelFuncs = require('./ssh-tunnel')
const deepCopy = require('json-deep-copy')
const { TerminalBase } = require('./session-base')
const { commonExtends } = require('./session-common')
const globalState = require('./global-state')

const failMsg = 'All configured authentication methods failed'
const csFailMsg = 'no matching C->S cipher'

class TerminalSshBase extends TerminalBase {
  async remoteInitProcess () {
    this.adjustConnectionOrder()
    const {
      initOptions
    } = this
    const hasX11 = initOptions.x11 === true
    this.display = hasX11 ? await this.getDisplay() : undefined
    this.x11Cookie = hasX11 ? await this.getX11Cookie() : undefined
    return this.sshConnect()
  }

  reTryAltAlg () {
    log.log('retry with default ciphers/server hosts')
    this.doKill()
    this.connectOptions.algorithms = algAlt()
    this.altAlg = true
    return this.sshConnect()
  }

  getShellWindow (initOptions = this.initOptions) {
    return _.pick(initOptions, [
      'rows', 'cols', 'term'
    ])
  }

  adjustConnectionOrder () {
    const { initOptions } = this
    if (!initOptions.hasHopping || !initOptions.connectionHoppings || initOptions.connectionHoppings.length === 0) {
      return
    }

    const currentHostHopping = {
      host: initOptions.host,
      port: initOptions.port,
      username: initOptions.username,
      password: initOptions.password,
      privateKey: initOptions.privateKey,
      passphrase: initOptions.passphrase
    }

    const [firstHopping, ...restHoppings] = initOptions.connectionHoppings
    Object.assign(initOptions, firstHopping)
    initOptions.connectionHoppings = [...restHoppings, currentHostHopping]
  }

  onKeyboardEvent (options) {
    if (this.initOptions.interactiveValues) {
      return Promise.resolve(this.initOptions.interactiveValues.split('\n'))
    }
    const id = generate()
    this.ws?.s({
      id,
      action: 'session-interactive',
      ..._.pick(this.initOptions, [
        'interactiveValues',
        'tabId'
      ]),
      options
    })
    return new Promise((resolve, reject) => {
      this.ws?.once((arg) => {
        const { results } = arg
        if (_.isEmpty(results)) {
          return reject(new Error('User cancel'))
        }
        resolve(results)
      }, id)
    })
  }

  async getPrivateKeysInJumpServer (conn) {
    const r = await this.runCmd('ls ~/.ssh', conn)
      .catch(err => {
        log.error(err)
      })
    return r
      ? r.split('\n')
        .filter(d => d.endsWith('.pub'))
        .map(d => `~/.ssh/${d}`.replace('.pub', ''))
      : []
  }

  catPrivateKeyInJumpServer (conn, filePath) {
    return this.runCmd(`cat ${filePath}`, conn)
  }

  async readPrivateKeyInJumpServer (conn) {
    const { hoppingOptions } = this
    if (this.jumpSshKeys) {
      if (this.jumpSshKeys.length > 0) {
        const p = this.jumpSshKeys.shift()
        this.jumpPrivateKeyPathFrom = p
        hoppingOptions.privateKey = await this.catPrivateKeyInJumpServer(conn, p)
      } else if (this.jumpSshKeys.length === 0) {
        delete hoppingOptions.privateKey
        delete this.jumpSshKeys
        hoppingOptions.sshKeysDrain = true
      }
      return
    }
    if (hoppingOptions.sshKeysDrain || hoppingOptions.password || hoppingOptions.privateKey) {
      return null
    }
    const list = await this.getPrivateKeysInJumpServer(conn)
    if (list.length) {
      const p = list.shift()
      this.jumpPrivateKeyPathFrom = p
      hoppingOptions.privateKey = await this.catPrivateKeyInJumpServer(conn, p)
      this.jumpSshKeys = list
    }
  }

  retryJump () {
    return this.doSshConnect(
      undefined,
      this.nextConn,
      this.hoppingOptions,
      !this.isLast
    )
      .then(() => {
        this.jumpHostFrom = this.initHoppingOptions.host
        this.jumpPortFrom = this.initHoppingOptions.port
        return this.nextConn
      })
      .catch(err => {
        log.error('error when do jump connect', err, this.nextHost, this.nextPort)
        if (err.message.includes('passphrase')) {
          const options = {
            name: `passphase for ${this.jumpHostFrom}/${this.jumpPrivateKeyPathFrom}`,
            instructions: [''],
            prompts: [{
              echo: false,
              prompt: 'passphase'
            }]
          }
          return this.onKeyboardEvent(options)
            .then(data => {
              if (data && data[0]) {
                this.hoppingOptions.passphrase = data[0]
                this.jumpSshKeys && this.jumpSshKeys.unshift(this.jumpPrivateKeyPathFrom)
              }
              return this.jumpConnect(true)
            })
            .catch(e => {
              log.error('errored get passphrase for', this.jumpHostFrom, this.jumpPrivateKeyPathFrom, e)
              return this.jumpConnect(true)
            })
        } else if (
          !this.jumpSshKeys &&
          !this.hoppingOptions.password &&
          !this.hoppingOptions.privateKey &&
          err.message.includes(failMsg)
        ) {
          const options = {
            name: `password for ${this.hoppingOptions.username}@${this.initHoppingOptions.host}`,
            instructions: [''],
            prompts: [{
              echo: false,
              prompt: 'password'
            }]
          }
          return this.onKeyboardEvent(options)
            .then(data => {
              if (data && data[0]) {
                this.hoppingOptions.password = data[0]
                return this.jumpConnect(true)
              } else if (data && data[0] === '') {
                throw err
              }
            })
            .catch(err => {
              log.error('errored get password for', err)
              throw err
            })
        } else if (
          this.jumpSshKeys
        ) {
          return this.jumpConnect(true)
        } else {
          throw err
        }
      })
  }

  async jumpConnect (reBuildSock = false) {
    if (reBuildSock) {
      this.hoppingOptions.sock.end()
      this.hoppingOptions.sock = await this.forwardOut(this.conn, this.initHoppingOptions)
    }
    await this.readPrivateKeyInJumpServer(this.conn)
    return this.retryJump()
  }

  forwardOut (conn, hopping) {
    return new Promise((resolve, reject) => {
      conn.forwardOut('localhost', 0, hopping.host, hopping.port, async (err, stream) => {
        if (err) {
          log.error(`forwardOut to ${hopping.host}:${hopping.port} error: ` + err)
          this.endConns()
          return reject(err)
        }
        resolve(stream)
      })
    })
  }

  async jump () {
    const sock = await this.forwardOut(this.conn, this.initHoppingOptions)
    const hopping = deepCopy(this.initHoppingOptions)
    delete hopping.host
    delete hopping.port
    this.nextHost = hopping.host
    this.nextPort = hopping.port
    this.hoppingOptions = {
      sock,
      ...hopping
    }
    const { Client } = require('@electerm/ssh2')
    this.nextConn = new Client()
    await this.jumpConnect()
    return this.nextConn
  }

  async hopping (connectionHoppings) {
    this.conns = []
    this.jumpHostFrom = this.initOptions.host
    this.jumpPortFrom = this.initOptions.port
    const len = connectionHoppings.length
    for (let i = 0; i < len; i++) {
      const hopping = connectionHoppings[i]
      this.conns.push(this.conn)
      this.initHoppingOptions = {
        ...hopping,
        ...this.getShareOptions()
      }
      this.isLast = i === len - 1
      const conn = await this.jump()
      if (conn) {
        this.conn = conn
      }
    }
  }

  endConns () {
    this.conn && this.conn.end && this.conn.end()
    while (this.conns && this.conns.length) {
      const conn = this.conns.shift()
      conn && conn.end()
    }
  }

  async onInitSshReady () {
    const {
      initOptions,
      isTest,
      shellOpts,
      shellWindow
    } = this
    if (
      initOptions.connectionHoppings?.length
    ) {
      await this.hopping(initOptions.connectionHoppings)
    }
    if (isTest) {
      this.endConns()
      return
    } else if (initOptions.enableSsh === false) {
      globalState.setSession(this.pid, this)
      return this
    }
    const { sshTunnels = [] } = initOptions
    const sshTunnelResults = []
    for (const sshTunnel of sshTunnels) {
      if (
        sshTunnel &&
        sshTunnel.sshTunnel &&
        sshTunnel.sshTunnelLocalPort
      ) {
        const result = await sshTunnelFuncs[sshTunnel.sshTunnel]({
          ...sshTunnel,
          conn: this.conn
        })
          .then(r => {
            return {
              sshTunnel
            }
          })
          .catch(err => {
            log.error('error when do sshTunnel', err)
            return {
              error: err.message,
              sshTunnel
            }
          })
        sshTunnelResults.push(result)
      }
    }
    if (!this.ws) {
      this.sshTunnelResults = sshTunnelResults
    } else {
      this.ws?.s({
        update: {
          sshTunnelResults
        },
        action: 'ssh-tunnel-result',
        tabId: this.initOptions.srcTabId
      })
    }
    return new Promise((resolve, reject) => {
      this.conn.shell(
        shellWindow,
        shellOpts,
        (err, channel) => {
          if (err) {
            return reject(err)
          }
          this.channel = channel
          globalState.setSession(this.pid, this)
          resolve(this)
        }
      )
    })
  }

  shell (conn, shellWindow, shellOpts) {
    return new Promise((resolve, reject) => {
      conn.shell(
        shellWindow,
        shellOpts,
        (err, channel) => {
          if (err) {
            return reject(err)
          }
          resolve(channel)
        }
      )
    })
  }

  getSSHKeys () {
    const { sshKeysPath } = process.env
    try {
      return require('fs')
        .readdirSync(sshKeysPath)
        .filter(file => file.endsWith('.pub'))
        .map(file => pathResolve(sshKeysPath, file.replace('.pub', '')))
    } catch (e) {
      log.error(e)
      return []
    }
  }

  getPrivateKey (connectOptions) {
    if (this.sshKeys) {
      if (this.sshKeys.length > 0) {
        const p = this.sshKeys.shift()
        this.privateKeyPath = p
        connectOptions.privateKey = require('fs').readFileSync(p, 'utf8')
      } else if (this.sshKeys.length === 0) {
        this.connectOptions.passphrase = this.initOptions.passphrase
        delete this.connectOptions.privateKey
        delete this.sshKeys
      }
      return
    }
    const list = this.getSSHKeys()
    if (list.length) {
      const p = list.shift()
      this.privateKeyPath = p
      connectOptions.privateKey = require('fs').readFileSync(p, 'utf8')
      this.sshKeys = list
    }
  }

  doSshConnect = (
    info,
    conn = this.conn,
    connectOptions = this.connectOptions,
    skipX11 = false
  ) => {
    const {
      initOptions
    } = this
    if (info && info.socket) {
      delete connectOptions.host
      delete connectOptions.port
      connectOptions.sock = info.socket
    }
    return new Promise((resolve, reject) => {
      conn.on('keyboard-interactive', async (
        name,
        instructions,
        instructionsLang,
        prompts,
        finish
      ) => {
        if (initOptions.ignoreKeyboardInteractive) {
          return finish(
            (prompts || []).map((n, i) => {
              return i ? '' : (connectOptions.password || '')
            })
          )
        }
        const options = {
          name,
          instructions,
          instructionsLang,
          prompts
        }
        this.onKeyboardEvent(options)
          .then(finish)
          .catch(reject)
      })
      if (!skipX11) {
        conn.on('x11', (inf, accept) => {
          let start = 0
          const maxRetry = 100
          const portStart = 6000
          const maxPort = portStart + maxRetry
          const retry = () => {
            if (start >= maxPort) {
              return
            }
            const xserversock = new net.Socket()
            let xclientsock
            xserversock
              .on('connect', function () {
                xclientsock = accept()
                xclientsock.pipe(xserversock).pipe(xclientsock)
              })
              .on('error', (e) => {
                log.error(e)
                xserversock.destroy()
                start = start === maxRetry ? portStart : start + 1
                retry()
              })
              .on('close', () => {
                xserversock.destroy()
                xclientsock && xclientsock.destroy()
              })
            if (start < portStart) {
              const addr = (this.display || '').includes('/tmp')
                ? this.display
                : `/tmp/.X11-unix/X${start}`
              xserversock.connect(addr)
            } else {
              xserversock.connect(start, 'localhost')
            }
          }
          retry()
        })
      }
      conn
        .on('ready', () => resolve(true))
        .on('error', err => {
          reject(err)
        })
        .connect(connectOptions)
    })
  }

  getShareOptions () {
    const { initOptions } = this
    const all = {
      tryKeyboard: true,
      readyTimeout: initOptions.readyTimeout,
      keepaliveCountMax: initOptions.keepaliveCountMax,
      keepaliveInterval: initOptions.keepaliveInterval,
      algorithms: algDefault()
    }
    if (initOptions.serverHostKey && initOptions.serverHostKey.length) {
      all.algorithms.serverHostKey = deepCopy(initOptions.serverHostKey)
    }
    if (initOptions.cipher && initOptions.cipher.length) {
      all.algorithms.cipher = deepCopy(initOptions.cipher)
    }
    return all
  }

  buildConnectOptions () {
    const { initOptions } = this
    const connectOptions = Object.assign(
      this.getShareOptions(),
      {
        agent: process.env.SSH_AUTH_SOCK
      },
      _.pick(initOptions, [
        'host',
        'port',
        'username',
        'password',
        'privateKey',
        'passphrase'
      ])
    )
    if (initOptions.debug) {
      connectOptions.debug = log.log
    }
    if (!connectOptions.password) {
      delete connectOptions.password
    }
    if (!connectOptions.passphrase) {
      delete connectOptions.passphrase
    }
    return connectOptions
  }

  buildShellOpts () {
    const { initOptions } = this
    let x11
    if (initOptions.x11 === true) {
      x11 = {
        cookie: this.x11Cookie
      }
    }
    const shellOpts = {
      x11
    }
    shellOpts.env = this.getEnv(initOptions)
    return shellOpts
  }

  getUserName (connectOptions) {
    const options = {
      name: 'username',
      instructions: [''],
      prompts: [{
        echo: false,
        prompt: ''
      }]
    }
    return this.onKeyboardEvent(options)
      .then(data => {
        const username = data ? data[0] : ''
        if (username) {
          this.connectOptions.username = data[0]
        }
        return this.sshConnect()
      })
      .catch(e => {
        log.error('errored get username for', e)
        return this.nextTry(e)
      })
  }

  async sshConnect () {
    const { initOptions } = this
    const { Client } = require('@electerm/ssh2')
    this.conn = new Client()
    this.connectOptions = this.connectOptions || this.buildConnectOptions()
    const {
      connectOptions
    } = this
    if (!connectOptions.username) {
      return this.getUserName(connectOptions)
    }
    if (
      this.sshKeys ||
      (!connectOptions.privateKey && !connectOptions.password)
    ) {
      this.getPrivateKey(this.connectOptions)
    }
    this.shellWindow = this.shellWindow || this.getShellWindow()
    this.shellOpts = this.shellOpts || this.buildShellOpts()
    const info = initOptions.proxy
      ? await proxySock({
        readyTimeout: initOptions.readyTimeout,
        host: initOptions.host,
        port: initOptions.port,
        proxy: initOptions.proxy
      })
      : undefined
    const skipX11 = !!initOptions.connectionHoppings?.length
    await this.doSshConnect(
      info,
      undefined,
      undefined,
      skipX11
    ).catch(err => {
      log.error('error when do sshConnect', err, this.privateKeyPath)
      if (
        err.message.includes(csFailMsg) &&
        !this.altAlg
      ) {
        return this.reTryAltAlg()
      } else if (err.message.includes('passphrase')) {
        const options = {
          name: `passphase for ${this.privateKeyPath || 'privateKey'}`,
          instructions: [''],
          prompts: [{
            echo: false,
            prompt: 'passphase'
          }]
        }
        return this.onKeyboardEvent(options)
          .then(data => {
            const pass = data ? data[0] : ''
            if (pass) {
              this.connectOptions.passphrase = data[0]
              this.sshKeys && this.sshKeys.unshift(this.privateKeyPath)
            }
            return this.nextTry(err, !!pass)
          })
          .catch(e => {
            log.error('errored get passphrase for', this.privateKeyPath, e)
            return this.nextTry(err)
          })
      } else if (
        this.sshKeys &&
        err.message.includes(failMsg)
      ) {
        return this.nextTry(err)
      } else if (
        err.message.includes(failMsg)
      ) {
        const options = {
          name: `password for ${this.initOptions.username}@${this.initOptions.host}`,
          instructions: [''],
          prompts: [{
            echo: false,
            prompt: 'password'
          }]
        }
        return this.onKeyboardEvent(options)
          .then(data => {
            if (data && data[0]) {
              this.connectOptions.password = data[0]
              return this.sshConnect()
            } else if (data && data[0] === '') {
              throw err
            }
          })
          .catch(err => {
            log.error('errored get password for', err)
            throw err
          })
      }
      return this.nextTry(err)
    })
    return this.onInitSshReady()
  }

  nextTry (err, forceRetry = false) {
    if (
      this.sshKeys || forceRetry
    ) {
      log.log('retry with next ssh key')
      if (this.conn) {
        this.conn.end()
      }
      return this.sshConnect()
    } else {
      throw err
    }
  }

  resize (cols, rows) {
    this.channel?.setWindow(rows, cols)
  }

  on (event, cb) {
    this.channel.on(event, cb)
    this.channel.stderr.on(event, cb)
  }

  write (data) {
    try {
      this.channel.write(data)
      // this.writeLog(data)
    } catch (e) {
      log.error(e)
    }
  }

  kill () {
    this.initOptions = null
    this.connectOptions = null
    this.alg = null
    this.shellWindow = null
    this.shellOpts = null
    this.conn = null
    this.sshKeys = null
    this.privateKeyPath = null
    this.display = null
    this.x11Cookie = null
    this.conns = null
    this.jumpSshKeys = null
    this.jumpPrivateKeyPathFrom = null
    this.hoppingOptions = null
    this.initHoppingOptions = null
    this.nextConn = null
    this.doKill()
  }

  doKill () {
    if (this.sessionLogger) {
      this.sessionLogger.destroy()
    }
    this.channel && this.channel.end()
    delete this.channel
    this.onEndConn()
    // Clean up any remaining connection
    if (this.conn) {
      this.conn.end()
      this.conn = null
    }
  }

  getLocalEnv () {
    return {
      env: process.env
    }
  }

  getDisplay () {
    return new Promise((resolve) => {
      exec('echo $DISPLAY', this.getLocalEnv(), (err, out, e) => {
        if (err || e) {
          resolve('')
        } else {
          resolve((out || '').trim())
        }
      })
    })
  }

  getX11Cookie () {
    return new Promise((resolve) => {
      exec('xauth list :0', this.getLocalEnv(), (err, out, e) => {
        if (err || e) {
          resolve('')
        } else {
          const s = out || ''
          const reg = /MIT-MAGIC-COOKIE-1 +([\d\w]{1,38})/
          const arr = s.match(reg)
          resolve(
            arr ? arr[1] || '' : ''
          )
        }
      })
    })
  }

  init () {
    return this.remoteInitProcess()
  }
}

const TerminalSsh = commonExtends(TerminalSshBase)

exports.session = function (initOptions, ws) {
  return (new TerminalSsh(initOptions, ws)).init()
}

/**
 * test ssh connection
 * @param {object} options
 */
exports.test = (options) => {
  return (new TerminalSsh(options, undefined, true))
    .init()
    .then(() => true)
    .catch((err) => {
      log.error('test ssh error', err)
      return false
    })
}
