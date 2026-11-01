/**
 * Split a concatenated MJPEG byte stream (ffmpeg image2pipe) into individual JPEG images by
 * scanning for SOI (FFD8) / EOI (FFD9) markers.
 */
export class MjpegSplitter {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = 12 * 1024 * 1024) {}

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        break;
      }
      const end = this.buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        if (this.buf.length > this.maxFrameBytes) this.buf = Buffer.alloc(0);
        break;
      }
      frames.push(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
    return frames;
  }
}

/** Read width/height from a baseline or progressive JPEG header without decoding pixels. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = jpeg[i + 1]!;
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
