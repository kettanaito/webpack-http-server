import * as fs from 'fs'
import * as path from 'path'
import type { Server } from 'http'
import { invariant } from 'outvariant'
import * as crypto from 'crypto'
import * as express from 'express'
import * as webpack from 'webpack'
import { render } from 'mustache'
import { IFs, createFsFromVolume, Volume } from 'memfs'
import { withMemoryFs } from './middleware/withMemoryFs'

export interface ServerOptions {
  before?(app: express.Application): void
  webpackConfig?: Omit<webpack.Configuration, 'entry'>
}

export interface CompilationResult {
  id: string
  previewUrl: string
  stats: webpack.Stats
  use(routes: (router: express.Router) => void): void
}

export interface CompilationOptions {
  markup?: string
}

export interface CompilationRecord {
  entries: string[]
  stats: webpack.Stats
  options: CompilationOptions
}

export class WebpackHttpServer {
  private app: express.Express
  private server: Server
  private compilations: Map<string, CompilationRecord>
  private fs: IFs

  constructor(private readonly options: ServerOptions = {}) {
    this.fs = createFsFromVolume(new Volume())
    this.compilations = new Map()
    this.app = express()
    this.app.use(express.json())

    this.options.before?.(this.app)

    // Prevent Express from responding with cached 304 responses.
    this.app.set('etag', false)

    /**
     * Preview route for a single compilation.
     */
    this.app.get('/compilation/:id', async (req, res) => {
      const { id } = req.params

      if (!this.compilations.has(id)) {
        return res.status(404).send('Compilation not found')
      }

      const html = await this.renderPreview(id)
      return res.send(html)
    })

    /**
     * Serve compilation assets from the memory FS.
     */
    this.app.use('/compilation/:id/:assetPath', withMemoryFs(this.fs))

    /**
     * Handle a new compilation request.
     */
    this.app.post('/compilation', async (req, res) => {
      const { entry, markup } = req.body
      const entries = Array.prototype.concat([], entry)

      if (!entries.every((entry) => path.isAbsolute(entry))) {
        return res.status(400).send('Entry path must be absolute.')
      }

      const result = await this.compile(entries, {
        markup,
      })

      return res.json({
        previewUrl: result.previewUrl,
      })
    })
  }

  public get serverUrl(): string {
    invariant(
      this.server,
      'Cannot retrieve server address: server is not running'
    )
    const address = this.server.address()

    if (typeof address === 'string') {
      return address
    }

    return `http://127.0.0.1:${address.port}`
  }

  public async listen(
    port: number = 0,
    hostname: string = '127.0.0.1'
  ): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, hostname, resolve)
    })
  }

  public async close(): Promise<void> {
    this.compilations.clear()

    invariant(this.server, 'Failed to close server: no server running')

    return new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          return reject(error)
        }
        resolve()
      })
    })
  }

  public async compile(
    entries: Array<string>,
    options: CompilationOptions = {}
  ): Promise<Compilation> {
    const resolvedEntries =
      entries.length === 0 ? [require.resolve('../empty-entry.js')] : entries

    const compilation = new Compilation({
      app: this.app,
      serverUrl: this.serverUrl,
      fs: this.fs,
    })

    const webpackConfig: webpack.Configuration = {
      ...(this.options.webpackConfig || {}),
      mode: 'development',
      entry: {
        main: resolvedEntries,
      },
      output: {
        path: path.resolve('compilation', compilation.id, 'dist'),
      },
    }

    await compilation.compile(webpackConfig).then((stats) => {
      this.handleIncrementalBuild(compilation.id, {
        entries: resolvedEntries,
        stats,
        options,
      })
    })

    return compilation
  }

  private handleIncrementalBuild(
    compilationId: string,
    record: CompilationRecord
  ): void {
    this.compilations.set(compilationId, record)
  }

  private async renderPreview(compilationId: string): Promise<string> {
    invariant(
      this.compilations.has(compilationId),
      'Failed to render preview for compilation "%s": compilation not found',
      compilationId
    )

    const compilation = this.compilations.get(compilationId)
    const entries = compilation.stats.compilation.entries
      .get('main')
      .dependencies.map((dependency) => {
        return (dependency as any).request
      })
    const { chunks } = compilation.stats.compilation
    const assets: Array<string> = []

    for (const chunk of chunks) {
      for (const filename of chunk.files) {
        assets.push(`/compilation/${compilationId}/${filename}`)
      }
    }

    const customTemplate = compilation.options.markup
      ? fs.existsSync(compilation.options.markup)
        ? fs.readFileSync(compilation.options.markup, 'utf8')
        : compilation.options.markup
      : ''

    const template = `
<html>
  <head>
    <title>Preview</title>
  </head>
  <body>
    <h2>Preview</h2>
    {{#entries}}
      <li><a href="vscode://file{{ . }}">{{ . }}</a></li>
    {{/entries}}

    ${customTemplate}

    {{#assets}}
      <script type="application/javascript" src="{{ . }}"></script>
    {{/assets}}
  </body>
</html
    `

    return render(template, {
      entries,
      assets,
    })
  }
}

export interface CompilationConstructOptions {
  app: express.Application
  serverUrl: string
  fs?: IFs
}

export class Compilation {
  public id: string
  public previewUrl: string
  public previewRoute: string
  public stats?: webpack.Stats

  static createPreviewRoute(compilationId: string): string {
    return `/compilation/${compilationId}/`
  }

  static createPreviewUrl(compilationId: string, serverUrl: string | URL): URL {
    return new URL(Compilation.createPreviewRoute(compilationId), serverUrl)
  }

  constructor(private options: CompilationConstructOptions) {
    this.id = crypto.randomBytes(16).toString('hex')
    this.previewRoute = Compilation.createPreviewRoute(this.id)
    this.previewUrl = Compilation.createPreviewUrl(
      this.id,
      this.options.serverUrl
    ).href
  }

  public async compile(
    webpackConfig?: webpack.Configuration
  ): Promise<webpack.Stats> {
    const compiler = webpack(webpackConfig)

    if (this.options.fs) {
      // Support compiling assets to memory.
      // This way they can be served from the memory later on.
      compiler.outputFileSystem = this.options.fs
    }

    return new Promise((resolve, reject) => {
      compiler.watch({ poll: 1000 }, (error, stats) => {
        if (error || stats.hasErrors()) {
          const resolvedErrors = error || stats.toJson().errors
          console.error('Compiled with errors:', resolvedErrors)
          return reject(resolvedErrors)
        }

        this.stats = stats
        resolve(stats)
      })
    })
  }

  public use(routes: (router: express.Router) => void): void {
    const router = express.Router()
    routes(router)
    this.options.app.use(this.previewRoute, router)

    /**
     * @todo Keep track of the appended routes to clean them up
     * in the dispose method in the future.
     */
  }
}
