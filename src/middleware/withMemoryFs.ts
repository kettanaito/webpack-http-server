import * as path from 'path'
import type { RequestHandler } from 'express'
import type { IFs } from 'memfs'

export function withMemoryFs(
  fs: IFs
): RequestHandler<{ id: string; assetPath: string }> {
  return (req, res, next) => {
    const filePath = path.join(
      'compilation',
      req.params.id,
      'dist',
      req.params.assetPath
    )

    if (!fs.existsSync(filePath)) {
      // Execute the next middleware because the consumer
      // may attach custom router to the compilation URL,
      // serving assets from the compilation route that were
      // not originally present in the compilation.
      return next()
    }

    const stream = fs.createReadStream(filePath, 'utf8')
    stream
      .pipe(res)
      .once('error', console.error)
      .on('end', () => res.end())
  }
}
