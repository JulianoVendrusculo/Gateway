import { toDataURL } from 'qrcode';

/** Imagem PNG (data URL) do QR Code a partir do copia-e-cola — gerada sob demanda, nunca persistida. */
export function pixQrCodeDataUrl(copyPaste: string): Promise<string> {
  return toDataURL(copyPaste, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
}
