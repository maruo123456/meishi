// 撮った写真の縮小（向きを直し、長い辺 3000px 以下の JPEG にする）

// 写真を読み込む。createImageBitmap の向きの指定が使えない環境では <img> で読む
// （<img> は iOS 13.4 以降、写真の向きの情報（EXIF）どおりに表示する）
async function decode(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close && bitmap.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('写真を読み込めませんでした'));
        img.src = url;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
}

export async function resizePhoto(file, maxSide = 3000, quality = 0.85) {
  const image = await decode(file);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(image.source, 0, 0, w, h);
  image.done();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  canvas.width = canvas.height = 0;  // iPhone のメモリをすぐ空ける
  if (!blob) throw new Error('写真を変換できませんでした');
  return blob;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
