export function translationModelConsentMessage(model: { downloadBytes: number; downloadUrl: string }): string {
  const size = (model.downloadBytes / 1_000_000_000).toFixed(2);
  const host = new URL(model.downloadUrl).hostname;
  const source = host === 'huggingface.co' ? 'Hugging Face' : host;
  return `Caption Studio needs a one-time ${size} GB download from ${source} to translate captions. Mobile data charges may apply. Download speeds vary depending on device restrictions. I really tried to speed this up. Keep this screen open until it finishes. After download, translations run offline. Your video and audio stay on your phone.`;
}
