import type { CaptionStylePatch, FontReference, TextTreatment } from '@/types/project';

export type FontColors = { primary: string; secondary: string };
export type FontChoice = {
  font: FontReference;
  name: string;
  mood: string;
  treatment: TextTreatment;
  colors?: FontColors;
};

export function fontChoicePatch(
  choice: Pick<FontChoice, 'font' | 'treatment' | 'colors'>,
  colors?: Partial<FontColors>,
): CaptionStylePatch {
  const solid = choice.treatment === 'solid';
  return {
    font: choice.font,
    textTreatment: choice.treatment,
    textColor: colors?.primary ?? (solid ? '#FFFFFF' : choice.colors?.primary ?? '#FFFFFF'),
    secondaryTextColor: solid ? '#FFFFFF' : colors?.secondary ?? choice.colors?.secondary ?? '#FFFFFF',
  };
}
