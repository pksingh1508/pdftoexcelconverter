import { CONFIG } from './config.js';

/** Remove long ruling strokes from an OCR-only copy; the source PDF is untouched. */
export function removeTableLines(canvas, scale) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { width, height, data } = image;
  const dark = new Uint8Array(width * height);
  const mask = new Uint8Array(dark.length);
  for (let i = 0; i < dark.length; i++) dark[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 < CONFIG.OCR_LINE_THRESHOLD ? 1 : 0;
  const minimum = Math.round(CONFIG.OCR_LINE_MIN_POINTS * scale);
  const allowedGap = Math.max(1, Math.round(CONFIG.OCR_LINE_GAP_POINTS * scale));
  function scan(lines, length, position) {
    for (let line = 0; line < lines; line++) {
      let start = -1, last = -1;
      const finish = () => {
        if (start >= 0 && last - start + 1 >= minimum) {
          for (let at = start; at <= last; at++) mask[position(line, at)] = 1;
        }
        start = last = -1;
      };
      for (let at = 0; at < length; at++) {
        if (dark[position(line, at)]) { if (start < 0) start = at; last = at; }
        else if (start >= 0 && at - last > allowedGap) finish();
      }
      finish();
    }
  }
  scan(height, width, (row, col) => row * width + col);
  scan(width, height, (col, row) => row * width + col);
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return mask.reduce((sum, value) => sum + value, 0);
}
