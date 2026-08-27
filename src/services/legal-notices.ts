import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';

import apacheLicenseAsset from '../../third-party/licenses/Apache-2.0.txt';
import mitNoticesAsset from '../../third-party/licenses/MIT-component-notices.txt';
import oflLicenseAsset from '../../assets/fonts/licenses/anton-OFL.txt';

export type LegalNoticeDocument = {
  id: 'overview' | 'ofl' | 'apache' | 'mit';
  title: string;
  load: () => Promise<string>;
};

const OFL_FONTS = [
  'Anton', 'Bebas Neue', 'Black Ops One', 'Bowlby One SC', 'Bungee', 'Bungee Shade',
  'Cabin Sketch', 'Creepster', 'Dokdo', 'Eater', 'Fascinate Inline', 'Faster One',
  'Fredericka the Great', 'Frijole', 'Gravitas One', 'Henny Penny', 'Knewave', 'Lacquer',
  'Limelight', 'Metal Mania', 'Modak', 'Monoton', 'Nosifer', 'Press Start 2P', 'Ranchers',
  'Rubik Beastly', 'Rubik Bubbles', 'Rubik Burned', 'Rubik Dirt', 'Rubik Distressed',
  'Rubik Glitch', 'Rubik Iso', 'Rubik Marker Hatch', 'Rubik Microbe', 'Rubik Moonrocks',
  'Rubik Puddles', 'Rubik Vinyl', 'Rye', 'Sancreek', 'Sixtyfour', 'Tilt Prism',
  'UnifrakturCook',
];

const OFL_COPYRIGHT_NOTICES = [
  'Anton — Copyright 2020 The Anton Project Authors.',
  'Bebas Neue — Copyright © 2010 Dharma Type.',
  'Black Ops One — Copyright 2022 The Black-Ops Project Authors.',
  'Bowlby One SC — Copyright © 2011 Vernon Adams.',
  'Bungee and Bungee Shade — Copyright 2023 The Bungee Project Authors.',
  'Cabin Sketch — Copyright 2011 The Cabin Project Authors; Reserved Font Names Cabin and Cabin Sketch.',
  'Creepster — Copyright © 2011 Font Diner, Inc.',
  'Dokdo — Copyright © 2005–2017 FONTRIX.',
  'Eater and Nosifer — Copyright © 2011 Typomondo.',
  'Fascinate Inline — Copyright © 2011 Brian J. Bonislawsky DBA Astigmatic.',
  'Faster One — Copyright 2012 The Faster Project Authors; Reserved Font Name Faster.',
  'Fredericka the Great — Copyright © 2011 Tart Workshop, a DBA of Font Diner, Inc.',
  'Frijole — Copyright © 2011 Sideshow, a DBA of Font Diner, Inc.',
  'Gravitas One, Limelight, and Rye — Copyright © 2011 Sorkin Type Co.',
  'Henny Penny — Copyright © 2011 BrownFox.',
  'Knewave — Copyright © 2010 Tyler Finck; Reserved Font Name Knewave.',
  'Lacquer — Copyright 2019 The Lacquer Project Authors.',
  'Metal Mania — Copyright © 2012 Open Window; Reserved Font Name Metal Mania.',
  'Modak — Copyright © 2015 Ek Type.',
  'Monoton — Copyright © 2011 Vernon Adams.',
  'Press Start 2P — Copyright 2012 The Press Start 2P Project Authors; Reserved Font Name Press Start 2P.',
  'Ranchers — Copyright © 2012 Pablo Impallari and Brenda Gallo; Reserved Font Name Ranchers.',
  'Rubik Beastly, Bubbles, Burned, Dirt, Distressed, Glitch, Iso, Marker Hatch, Microbe, Moonrocks, Puddles, and Vinyl — Copyright 2020 The Rubik Filtered Project Authors.',
  'Sancreek — Copyright 2011 The Sancreek Project Authors.',
  'Sixtyfour — Copyright 2021 The Sixtyfour Project Authors.',
  'Tilt Prism — Copyright 2019 The Tilt Project Authors.',
  'UnifrakturCook — Copyright © 2010 J. “Mach” Wust; Reserved Font Name UnifrakturCook.',
];

const OVERVIEW = `Caption Studio is MIT-licensed. It includes open-source Android and Expo software under their respective licenses.

Native media and machine-learning components
• Google MediaPipe Tasks Vision — Apache License 2.0
• Google ML Kit Face Detection — Google APIs Terms and ML Kit terms
• Google AI Edge LiteRT-LM 0.16.1 — Apache License 2.0
• Gson 2.13.2 — Apache License 2.0
• Kotlin reflection 2.2.21 — Apache License 2.0
• Kotlin coroutines Android 1.9.0 — Apache License 2.0
• AndroidX Media3 Transformer and Effect — Apache License 2.0
• Expo, React Native, and React Navigation components — MIT License

Local transcription runtime
• whisper.rn 0.7.0 — MIT License, Copyright © 2023 Jhen-Jie Hong
• whisper.cpp and ggml native sources — MIT License, Copyright © 2023–2026 The ggml authors

Optional transcription models
• OpenAI Whisper ggml tiny, base, and small multilingual models — MIT License, Copyright © 2022 OpenAI
• Silero VAD v6.2 ggml model — MIT License, Copyright © 2020–present Silero Team
Whisper revision: c521a4b02f422512d734391fdf08bb08c0862f68
Silero VAD revision: 9ffd54a1e1ee413ddf265af9913beaf518d1639b
Caption Studio verifies each downloaded model's exact size and SHA-256 digest before use.

Optional caption translation model
Qwen2.5 1.5B Instruct Q8 LiteRT-LM — Apache License 2.0.
Pinned revision: 19edb84c69a0212f29a6ef17ba0d6f278b6a1614
SHA-256: faa60663b333290c1496c499828b21d3e3254a788cacd8cce917ce0f761a2dc9
The model is not bundled in the APK or AAB. Caption Studio downloads it only when natural English–Chinese translation is enabled, verifies it, and runs it locally on the device.

Bundled segmentation model
MediaPipe Selfie Multiclass Segmentation 256 × 256, Apache License 2.0.
SHA-256: c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0
The model runs locally and is not called through a server.

Bundled fonts
SIL Open Font License 1.1 (${OFL_FONTS.length}): ${OFL_FONTS.join(', ')}.

Font copyright and Reserved Font Name notices
${OFL_COPYRIGHT_NOTICES.join('\n')}

Apache License 2.0: Fontdiner Swanky and Permanent Marker.

Imported fonts are supplied by the user, who remains responsible for having permission to use them.`;

export const LEGAL_NOTICE_DOCUMENTS: LegalNoticeDocument[] = [
  { id: 'overview', title: 'Attributions', load: async () => OVERVIEW },
  { id: 'mit', title: 'MIT component notices', load: () => readBundledText(mitNoticesAsset) },
  { id: 'ofl', title: 'SIL Open Font License 1.1', load: () => readBundledText(oflLicenseAsset) },
  { id: 'apache', title: 'Apache License 2.0', load: () => readBundledText(apacheLicenseAsset) },
];

async function readBundledText(moduleId: number) {
  const asset = Asset.fromModule(moduleId);
  if (!asset.localUri) await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new Error('The bundled license text could not be opened.');
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
}
