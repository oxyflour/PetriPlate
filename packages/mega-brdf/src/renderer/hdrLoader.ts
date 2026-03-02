export type HDRTextureData = {
  width: number;
  height: number;
  data: Uint8Array;
};

type HDRHeader = {
  width: number;
  height: number;
  xPositive: boolean;
  yNegative: boolean;
  dataOffset: number;
};

function readLine(bytes: Uint8Array, start: number): { line: string; next: number } {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0x0a) {
    end += 1;
  }
  const line = new TextDecoder("ascii").decode(bytes.subarray(start, end)).trim();
  return { line, next: Math.min(end + 1, bytes.length) };
}

function parseHeader(bytes: Uint8Array): HDRHeader {
  let offset = 0;
  const first = readLine(bytes, offset);
  offset = first.next;
  if (!first.line.startsWith("#?")) {
    throw new Error("Invalid HDR header signature.");
  }

  let format = "";
  while (offset < bytes.length) {
    const { line, next } = readLine(bytes, offset);
    offset = next;
    if (line.length === 0) {
      break;
    }
    if (line.startsWith("FORMAT=")) {
      format = line.slice("FORMAT=".length);
    }
  }

  if (format !== "32-bit_rle_rgbe") {
    throw new Error(`Unsupported HDR format: ${format || "unknown"}.`);
  }

  const resolution = readLine(bytes, offset);
  offset = resolution.next;
  const match = resolution.line.match(/^([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)$/);
  if (!match) {
    throw new Error(`Invalid HDR resolution line: ${resolution.line}`);
  }

  return {
    yNegative: match[1] === "-",
    height: Number.parseInt(match[2], 10),
    xPositive: match[3] === "+",
    width: Number.parseInt(match[4], 10),
    dataOffset: offset
  };
}

function decodeLegacyRgbe(
  source: Uint8Array,
  width: number,
  height: number,
  startOffset: number,
  xPositive: boolean,
  yNegative: boolean
): Uint8Array {
  const expectedBytes = width * height * 4;
  const end = startOffset + expectedBytes;
  if (end > source.length) {
    throw new Error("HDR pixel payload is truncated.");
  }
  const raw = source.subarray(startOffset, end);
  const data = new Uint8Array(expectedBytes);
  for (let y = 0; y < height; y += 1) {
    const dstY = yNegative ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const dstX = xPositive ? x : width - 1 - x;
      const srcOffset = (y * width + x) * 4;
      const dstOffset = (dstY * width + dstX) * 4;
      data[dstOffset] = raw[srcOffset];
      data[dstOffset + 1] = raw[srcOffset + 1];
      data[dstOffset + 2] = raw[srcOffset + 2];
      data[dstOffset + 3] = raw[srcOffset + 3];
    }
  }
  return data;
}

function decodeRleRgbe(
  source: Uint8Array,
  width: number,
  height: number,
  startOffset: number,
  xPositive: boolean,
  yNegative: boolean
): Uint8Array {
  if (width < 8 || width > 0x7fff) {
    return decodeLegacyRgbe(
      source,
      width,
      height,
      startOffset,
      xPositive,
      yNegative
    );
  }

  let offset = startOffset;
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    if (offset + 4 > source.length) {
      throw new Error("HDR scanline header is truncated.");
    }

    const a = source[offset];
    const b = source[offset + 1];
    const c = source[offset + 2];
    const d = source[offset + 3];
    offset += 4;

    if (a !== 2 || b !== 2 || (c & 0x80) !== 0 || ((c << 8) | d) !== width) {
      return decodeLegacyRgbe(
        source,
        width,
        height,
        startOffset,
        xPositive,
        yNegative
      );
    }

    const scanline = new Uint8Array(width * 4);
    for (let channel = 0; channel < 4; channel += 1) {
      let cursor = channel * width;
      const end = cursor + width;
      while (cursor < end) {
        if (offset >= source.length) {
          throw new Error("HDR scanline payload is truncated.");
        }
        const count = source[offset];
        offset += 1;

        if (count > 128) {
          const runLength = count - 128;
          if (runLength === 0 || cursor + runLength > end || offset >= source.length) {
            throw new Error("HDR run-length block is invalid.");
          }
          const value = source[offset];
          offset += 1;
          scanline.fill(value, cursor, cursor + runLength);
          cursor += runLength;
        } else {
          const runLength = count;
          if (
            runLength === 0 ||
            cursor + runLength > end ||
            offset + runLength > source.length
          ) {
            throw new Error("HDR literal block is invalid.");
          }
          scanline.set(source.subarray(offset, offset + runLength), cursor);
          offset += runLength;
          cursor += runLength;
        }
      }
    }

    const dstY = yNegative ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const dstX = xPositive ? x : width - 1 - x;
      const dstOffset = (dstY * width + dstX) * 4;
      data[dstOffset] = scanline[x];
      data[dstOffset + 1] = scanline[x + width];
      data[dstOffset + 2] = scanline[x + width * 2];
      data[dstOffset + 3] = scanline[x + width * 3];
    }
  }

  return data;
}

export async function loadHDRTextureData(url: string): Promise<HDRTextureData> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch HDRI (${response.status}).`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const header = parseHeader(bytes);
  const data = decodeRleRgbe(
    bytes,
    header.width,
    header.height,
    header.dataOffset,
    header.xPositive,
    header.yNegative
  );

  return {
    width: header.width,
    height: header.height,
    data
  };
}

export function packTextureRows(
  data: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number
): { data: Uint8Array; bytesPerRow: number } {
  const rowBytes = width * bytesPerPixel;
  const aligned = Math.ceil(rowBytes / 256) * 256;
  if (aligned === rowBytes) {
    return { data, bytesPerRow: rowBytes };
  }

  const packed = new Uint8Array(aligned * height);
  for (let row = 0; row < height; row += 1) {
    const srcStart = row * rowBytes;
    const dstStart = row * aligned;
    packed.set(data.subarray(srcStart, srcStart + rowBytes), dstStart);
  }
  return { data: packed, bytesPerRow: aligned };
}
