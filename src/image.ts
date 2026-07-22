export type ImageFileInfo = {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
};

const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 16_777_216;

function invalidImage(): never {
  throw new Error("The selected file is not a supported PNG, JPEG, or WebP image.");
}

function checked(info: ImageFileInfo) {
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1) invalidImage();
  if (info.width > MAX_IMAGE_DIMENSION || info.height > MAX_IMAGE_DIMENSION || info.width * info.height > MAX_IMAGE_PIXELS) {
    throw new Error("Choose an image no larger than 16 megapixels or 8192 pixels on either side.");
  }
  return info;
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  if (offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint16BigEndian(bytes: Uint8Array, offset: number) {
  if (offset + 2 > bytes.length) invalidImage();
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint24LittleEndian(bytes: Uint8Array, offset: number) {
  if (offset + 3 > bytes.length) invalidImage();
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32BigEndian(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) invalidImage();
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function uint32LittleEndian(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) invalidImage();
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function inspectPng(bytes: Uint8Array): ImageFileInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (bytes.length < 24 || uint32BigEndian(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") invalidImage();
  return checked({ mime: "image/png", width: uint32BigEndian(bytes, 16), height: uint32BigEndian(bytes, 20) });
}

function isJpegStartOfFrame(marker: number) {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function inspectJpeg(bytes: Uint8Array): ImageFileInfo | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const length = uint16BigEndian(bytes, offset);
    if (length < 2 || offset + length > bytes.length) invalidImage();
    if (isJpegStartOfFrame(marker)) {
      if (length < 7) invalidImage();
      return checked({
        mime: "image/jpeg",
        width: uint16BigEndian(bytes, offset + 5),
        height: uint16BigEndian(bytes, offset + 3),
      });
    }
    offset += length;
  }
  invalidImage();
}

function inspectWebp(bytes: Uint8Array): ImageFileInfo | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = uint32LittleEndian(bytes, offset + 4);
    const data = offset + 8;
    if (data + length > bytes.length) invalidImage();
    if (type === "VP8X") {
      if (length < 10) invalidImage();
      return checked({
        mime: "image/webp",
        width: uint24LittleEndian(bytes, data + 4) + 1,
        height: uint24LittleEndian(bytes, data + 7) + 1,
      });
    }
    if (type === "VP8L") {
      if (length < 5 || bytes[data] !== 0x2f) invalidImage();
      const bits = uint32LittleEndian(bytes, data + 1);
      return checked({
        mime: "image/webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      });
    }
    if (type === "VP8 ") {
      if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) invalidImage();
      return checked({
        mime: "image/webp",
        width: (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff,
        height: (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff,
      });
    }
    offset = data + length + (length % 2);
  }
  invalidImage();
}

export function inspectImageFile(bytes: Uint8Array): ImageFileInfo {
  return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes) ?? invalidImage();
}
