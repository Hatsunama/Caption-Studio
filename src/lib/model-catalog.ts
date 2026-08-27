export type TranscriptionModel = {
  id: 'fast' | 'balanced' | 'accurate';
  label: string;
  description: string;
  fileName: string;
  downloadUrl: string;
  downloadBytes: number;
  sha256: string;
};

const MODEL_REVISION = 'c521a4b02f422512d734391fdf08bb08c0862f68';
const MODEL_ROOT = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}`;

export const LEGACY_ENGLISH_MODEL_FILES = [
  'ggml-tiny.en-q5_1.bin',
  'ggml-base.en-q5_1.bin',
  'ggml-small.en-q5_1.bin',
] as const;

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
  {
    id: 'fast',
    label: 'Fast',
    description: 'Tiny multilingual, best for quick drafts and lower-memory phones.',
    fileName: 'ggml-tiny-q5_1.bin',
    downloadUrl: `${MODEL_ROOT}/ggml-tiny-q5_1.bin`,
    downloadBytes: 32_152_673,
    sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Base multilingual, the default quality/speed choice.',
    fileName: 'ggml-base-q5_1.bin',
    downloadUrl: `${MODEL_ROOT}/ggml-base-q5_1.bin`,
    downloadBytes: 59_707_625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  },
  {
    id: 'accurate',
    label: 'Accurate',
    description: 'Small multilingual, slower and intended for higher-memory phones.',
    fileName: 'ggml-small-q5_1.bin',
    downloadUrl: `${MODEL_ROOT}/ggml-small-q5_1.bin`,
    downloadBytes: 190_085_487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  },
];

export function getModel(modelId: TranscriptionModel['id']) {
  const model = TRANSCRIPTION_MODELS.find((item) => item.id === modelId);
  if (!model) throw new Error(`Unknown transcription model: ${modelId}`);
  return model;
}
