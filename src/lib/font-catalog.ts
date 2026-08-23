import type { CaptionStylePatch, FontReference, TextTreatment } from '@/types/project';

type FontAsset = number;

export type FontChoice = {
  font: FontReference;
  name: string;
  mood: string;
  treatment: TextTreatment;
  colors?: { primary: string; secondary: string };
};

export const FONT_ASSETS: Record<string, FontAsset> = {
  'Caption-Anton': require('../../assets/fonts/anton.ttf'),
  'Caption-BebasNeue': require('../../assets/fonts/bebasneue.ttf'),
  'Caption-Bungee': require('../../assets/fonts/bungee.ttf'),
  'Caption-BungeeShade': require('../../assets/fonts/bungeeshade.ttf'),
  'Caption-Creepster': require('../../assets/fonts/creepster.ttf'),
  'Caption-Eater': require('../../assets/fonts/eater.ttf'),
  'Caption-FascinateInline': require('../../assets/fonts/fascinateinline.ttf'),
  'Caption-FasterOne': require('../../assets/fonts/fasterone.ttf'),
  'Caption-Fredericka': require('../../assets/fonts/frederickathegreat.ttf'),
  'Caption-Frijole': require('../../assets/fonts/frijole.ttf'),
  'Caption-HennyPenny': require('../../assets/fonts/hennypenny.ttf'),
  'Caption-Lacquer': require('../../assets/fonts/lacquer.ttf'),
  'Caption-Limelight': require('../../assets/fonts/limelight.ttf'),
  'Caption-MetalMania': require('../../assets/fonts/metalmania.ttf'),
  'Caption-Monoton': require('../../assets/fonts/monoton.ttf'),
  'Caption-Nosifer': require('../../assets/fonts/nosifer.ttf'),
  'Caption-PressStart2P': require('../../assets/fonts/pressstart2p.ttf'),
  'Caption-Ranchers': require('../../assets/fonts/ranchers.ttf'),
  'Caption-RubikBeastly': require('../../assets/fonts/rubikbeastly.ttf'),
  'Caption-RubikBubbles': require('../../assets/fonts/rubikbubbles.ttf'),
  'Caption-RubikBurned': require('../../assets/fonts/rubikburned.ttf'),
  'Caption-RubikDirt': require('../../assets/fonts/rubikdirt.ttf'),
  'Caption-RubikDistressed': require('../../assets/fonts/rubikdistressed.ttf'),
  'Caption-RubikGlitch': require('../../assets/fonts/rubikglitch.ttf'),
  'Caption-RubikIso': require('../../assets/fonts/rubikiso.ttf'),
  'Caption-RubikMarkerHatch': require('../../assets/fonts/rubikmarkerhatch.ttf'),
  'Caption-RubikMoonrocks': require('../../assets/fonts/rubikmoonrocks.ttf'),
  'Caption-RubikPuddles': require('../../assets/fonts/rubikpuddles.ttf'),
  'Caption-Rye': require('../../assets/fonts/rye.ttf'),
  'Caption-Sancreek': require('../../assets/fonts/sancreek.ttf'),
  'Caption-TiltPrism': require('../../assets/fonts/tiltprism.ttf'),
  'Caption-UnifrakturCook': require('../../assets/fonts/unifrakturcook.ttf'),
  'Caption-BlackOpsOne': require('../../assets/fonts/blackopsone.ttf'),
  'Caption-BowlbyOneSC': require('../../assets/fonts/bowlbyonesc.ttf'),
  'Caption-CabinSketch': require('../../assets/fonts/cabinsketch.ttf'),
  'Caption-Dokdo': require('../../assets/fonts/dokdo.ttf'),
  'Caption-FontdinerSwanky': require('../../assets/fonts/fontdinerswanky.ttf'),
  'Caption-GravitasOne': require('../../assets/fonts/gravitasone.ttf'),
  'Caption-Knewave': require('../../assets/fonts/knewave.ttf'),
  'Caption-Modak': require('../../assets/fonts/modak.ttf'),
  'Caption-PermanentMarker': require('../../assets/fonts/permanentmarker.ttf'),
  'Caption-RubikMicrobe': require('../../assets/fonts/rubikmicrobe.ttf'),
  'Caption-RubikVinyl': require('../../assets/fonts/rubikvinyl.ttf'),
  'Caption-Sixtyfour': require('../../assets/fonts/sixtyfour.ttf'),
};

function choice(
  id: string,
  family: string,
  name: string,
  mood: string,
  treatment: TextTreatment = 'solid',
  colors?: FontChoice['colors'],
): FontChoice {
  return {
    font: { id, family, source: 'built-in', postScriptName: name },
    name,
    mood,
    treatment,
    colors,
  };
}

export const BUILT_IN_FONT_CHOICES: FontChoice[] = [
  choice('anton', 'Caption-Anton', 'Anton', 'Tall blockbuster'),
  choice('bebas-neue', 'Caption-BebasNeue', 'Bebas Neue', 'Clean poster'),
  choice('bungee', 'Caption-Bungee', 'Bungee', 'Arcade headline', 'duotone-offset', { primary: '#FFF45C', secondary: '#FF3D9A' }),
  choice('bungee-shade', 'Caption-BungeeShade', 'Bungee Shade', 'Dimensional display', 'duotone-shadow', { primary: '#DFFF35', secondary: '#6A35FF' }),
  choice('creepster', 'Caption-Creepster', 'Creepster', 'Monster horror'),
  choice('eater', 'Caption-Eater', 'Eater', 'Rough spooky'),
  choice('fascinate-inline', 'Caption-FascinateInline', 'Fascinate Inline', 'Cabaret outline', 'duotone-offset', { primary: '#FFDA57', secondary: '#F23DFF' }),
  choice('faster-one', 'Caption-FasterOne', 'Faster One', 'Racing speed'),
  choice('fredericka', 'Caption-Fredericka', 'Fredericka the Great', 'Hand-drawn elegant'),
  choice('frijole', 'Caption-Frijole', 'Frijole', 'Wild party'),
  choice('henny-penny', 'Caption-HennyPenny', 'Henny Penny', 'Whimsical storybook'),
  choice('lacquer', 'Caption-Lacquer', 'Lacquer', 'Graffiti marker'),
  choice('limelight', 'Caption-Limelight', 'Limelight', 'Art deco cinema'),
  choice('metal-mania', 'Caption-MetalMania', 'Metal Mania', 'Heavy metal'),
  choice('monoton', 'Caption-Monoton', 'Monoton', 'Retro neon', 'duotone-neon', { primary: '#56FFF2', secondary: '#FF3FD1' }),
  choice('nosifer', 'Caption-Nosifer', 'Nosifer', 'Dripping danger'),
  choice('press-start-2p', 'Caption-PressStart2P', 'Press Start 2P', 'Pixel game'),
  choice('ranchers', 'Caption-Ranchers', 'Ranchers', 'Cartoon western'),
  choice('rubik-beastly', 'Caption-RubikBeastly', 'Rubik Beastly', 'Furry creature'),
  choice('rubik-bubbles', 'Caption-RubikBubbles', 'Rubik Bubbles', 'Soft bubbly'),
  choice('rubik-burned', 'Caption-RubikBurned', 'Rubik Burned', 'Scorched sketch'),
  choice('rubik-dirt', 'Caption-RubikDirt', 'Rubik Dirt', 'Dusty texture'),
  choice('rubik-distressed', 'Caption-RubikDistressed', 'Rubik Distressed', 'Worn print'),
  choice('rubik-glitch', 'Caption-RubikGlitch', 'Rubik Glitch', 'Digital distortion', 'duotone-offset', { primary: '#66FFDA', secondary: '#FF3A89' }),
  choice('rubik-iso', 'Caption-RubikIso', 'Rubik Iso', 'Isometric maze'),
  choice('rubik-marker-hatch', 'Caption-RubikMarkerHatch', 'Rubik Marker Hatch', 'Cross-hatched marker'),
  choice('rubik-moonrocks', 'Caption-RubikMoonrocks', 'Rubik Moonrocks', 'Alien craters'),
  choice('rubik-puddles', 'Caption-RubikPuddles', 'Rubik Puddles', 'Liquid splash', 'duotone-shadow', { primary: '#8CFF5A', secondary: '#3D67FF' }),
  choice('rye', 'Caption-Rye', 'Rye', 'Vintage saloon'),
  choice('sancreek', 'Caption-Sancreek', 'Sancreek', 'Circus slab'),
  choice('tilt-prism', 'Caption-TiltPrism', 'Tilt Prism', 'Variable 3D', 'duotone-neon', { primary: '#FFE74A', secondary: '#8B5CFF' }),
  choice('unifraktur', 'Caption-UnifrakturCook', 'Unifraktur Cook', 'Blackletter drama'),
  choice('black-ops-one', 'Caption-BlackOpsOne', 'Black Ops One', 'Military stencil'),
  choice('bowlby-one-sc', 'Caption-BowlbyOneSC', 'Bowlby One SC', 'Chunky retro sign', 'duotone-shadow', { primary: '#FFEF5A', secondary: '#FF477E' }),
  choice('cabin-sketch', 'Caption-CabinSketch', 'Cabin Sketch', 'Hand-sketched poster'),
  choice('dokdo', 'Caption-Dokdo', 'Dokdo', 'Loose ink brush'),
  choice('fontdiner-swanky', 'Caption-FontdinerSwanky', 'Fontdiner Swanky', 'Playful diner'),
  choice('gravitas-one', 'Caption-GravitasOne', 'Gravitas One', 'Heavy editorial'),
  choice('knewave', 'Caption-Knewave', 'Knewave', 'Painted surf'),
  choice('modak', 'Caption-Modak', 'Modak', 'Inflated cartoon', 'duotone-offset', { primary: '#74FFCD', secondary: '#8A4DFF' }),
  choice('permanent-marker', 'Caption-PermanentMarker', 'Permanent Marker', 'Bold marker note'),
  choice('rubik-microbe', 'Caption-RubikMicrobe', 'Rubik Microbe', 'Organic science'),
  choice('rubik-vinyl', 'Caption-RubikVinyl', 'Rubik Vinyl', 'Grooved record', 'duotone-neon', { primary: '#50F6FF', secondary: '#FF40C7' }),
  choice('sixtyfour', 'Caption-Sixtyfour', 'Sixtyfour', 'Variable sci-fi grid', 'duotone-offset', { primary: '#DFFF35', secondary: '#28A7FF' }),
];

export function fontChoicePatch(choice: FontChoice): CaptionStylePatch {
  return {
    font: choice.font,
    textTreatment: choice.treatment,
    ...(choice.colors
      ? { textColor: choice.colors.primary, secondaryTextColor: choice.colors.secondary }
      : { textTreatment: 'solid' as const }),
  };
}
