import * as fs from 'fs'
import * as path from 'path'
import type { Server } from 'http'
import { invariant } from 'outvariant'
import * as crypto from 'crypto'
import * as express from 'express'
import * as webpack from 'webpack'
import { render } from 'mustache'
import { IFs, createFsFromVolume, Volume } from 'memfs'
import { useMemoryFs } from './middleware/useMemoryFs'

export interface ServerOptions {
  before?(app: express.Application): void
  webpackConfig?: Omit<webpack.Configuration, 'entry'>
}

export interface CompilationResult {
  id: string
  previewUrl: string
  stats: webpack.Stats
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
    this.app.use('/compilation/:id/:assetPath', useMemoryFs(this.fs))

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

  public async listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(0, '127.0.0.1', resolve)
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
  ): Promise<CompilationResult> {
    const compilationId = crypto.createHash('md5').digest('hex')

    const config: webpack.Configuration = {
      ...(this.options.webpackConfig || {}),
      mode: 'development',
      entry: {
        main: entries,
      },
      output: {
        path: path.resolve('compilation', compilationId, 'dist'),
      },
    }

    const compiler = webpack(config)

    // Compile assets to memory so that the preview could
    // serve those assets from memory also.
    compiler.outputFileSystem = this.fs

    return new Promise((resolve) => {
      compiler.watch({ poll: 1000 }, (error, stats) => {
        if (error || stats.hasErrors()) {
          console.error('Compiled with errors:', error || stats.toJson().errors)
          return
        }

        this.handleIncrementalBuild(compilationId, {
          entries,
          stats,
          options,
        })

        const previewUrl = new URL(
          `/compilation/${compilationId}`,
          this.serverUrl
        ).href

        resolve({
          id: compilationId,
          previewUrl,
          stats,
        })
      })
    })
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
      ? fs.readFileSync(compilation.options.markup, 'utf8')
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
