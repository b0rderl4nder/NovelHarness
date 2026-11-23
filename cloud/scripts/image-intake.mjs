export async function checkPickedImages(files, limits, measure = async (file) => {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}) {
  for (const file of files) {
    try {
      if (file.type === 'image/jpeg' || file.type === 'image/png') {
        const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
        const png = file.type === 'image/png';
        const signature = png ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
        if (!signature.every((byte, index) => header[index] === byte)) return 'IMAGE_TYPE_MISMATCH';
        if (png && header.length === 24) {
          const view = new DataView(header.buffer);
          const width = view.getUint32(16), height = view.getUint32(20);
          if (Math.max(width, height) > limits?.maxImageDimension) return 'IMAGE_DIMENSION_TOO_LARGE';
          if (width * height > limits?.maxImagePixels) return 'IMAGE_TOO_MANY_PIXELS';
        }
      }
      const { width, height } = await measure(file);
      if (!(width > 0 && height > 0)) return 'INVALID_IMAGE';
      if (Math.max(width, height) > limits?.maxImageDimension) return 'IMAGE_DIMENSION_TOO_LARGE';
      if (width * height > limits?.maxImagePixels) return 'IMAGE_TOO_MANY_PIXELS';
    } catch {
      return 'INVALID_IMAGE';
    }
  }
  return null;
}
