declare module 'node-7z' {
  import { EventEmitter } from 'events';

  interface ExtractOptions {
    $progress?: boolean;
    recursive?: boolean;
    [key: string]: any;
  }

  interface SevenStream extends EventEmitter {
    on(event: 'data', listener: (data: any) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'progress', listener: (progress: { percent?: number }) => void): this;
  }

  function extractFull(archivePath: string, outputDir: string, options?: ExtractOptions): SevenStream;

  export default { extractFull };
  export { extractFull };
}
