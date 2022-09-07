import * as path from 'path'
import type { RequestHandler } from 'express'
import type { IFs } from 'memfs'

export function useMemoryFs(
  fs: IFs
): RequestHandler<{ id: string; assetPath: string }> {
  return (req, res) => {
    const filePath = path.join(
      'compilation',
      req.params.id,
      'dist',
      req.params.assetPath
    )

    if (!fs.existsSync(filePath)) {
      return res.status(404)
    }

    const stream = fs.createReadStream(filePath, 'utf8')
    stream
      .pipe(res)
      .once('error', console.error)
      .on('end', () => res.end())
  }
}
